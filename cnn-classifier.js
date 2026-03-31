'use strict';

/**
 * cnn-classifier.js — Learned shot classifier using ONNX Runtime Web.
 *
 * Model: dual-branch 1D-CNN (primary), ~8.7 k params.
 *   Inputs:
 *     x_imu  Float32 (1, 1, 800)   — accel_mag resampled @ 400 Hz, normalised
 *     x_tof  Float32 (1, 2, 80)    — [tof_range_mm, tof_sr] resampled @ 40 Hz, normalised
 *   Output:
 *     logits Float32 (1, 3)         — [Not-a-shot, Miss, Make]
 *
 * Files required in web/model/:
 *   primary.onnx      — exported from ml/artifacts/exp1/model_cnn_primary.pt
 *   normalizer.json   — global mean/std from ml/export_onnx.py
 *
 * Latency estimate:
 *   Window collection  : PRE_S + POST_S = 2.0 s (fixed)
 *   ONNX inference     : ~10–20 ms (mobile Chrome)
 *   Total from trigger : ~2.02 s
 */

import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/esm/ort.min.js';

// ── Window geometry (must match training) ────────────────────────────────────
const PRE_S   = 0.5;
const POST_S  = 1.5;
const IMU_HZ  = 400;   // resampled target rate
const TOF_HZ  = 40;
const T_IMU   = Math.round((PRE_S + POST_S) * IMU_HZ);   // 800
const T_TOF   = Math.round((PRE_S + POST_S) * TOF_HZ);   //  80

// ── IMU channel layout (must match prepare_dataset_firebase.py ALL_IMU_FEATURES) ─
// ch 0-2 : accel_xyz (ax, ay, az) — baseline-subtracted (g)
// ch 3   : accel_mag = √(ax²+ay²+az²) after baseline (g)
// ch 4-6 : gyro_xyz  (gx, gy, gz) — raw °/s (no baseline subtraction in training)
// ch 7   : gyro_mag  = √(gx²+gy²+gz²) °/s
const C_IMU   = 8;
const C_TOF   = 2;

// Label indices (must match LABEL_MAP in train_cnn.py)
const LABEL_NAMES = ['Not-a-shot', 'Miss', 'Make'];

// ── Model paths ──────────────────────────────────────────────────────────────
const MODEL_URL      = './model/primary.onnx';
const NORMALIZER_URL = './model/normalizer.json';

export class LearnedClassifier {
  /**
   * @param {import('./classifier.js').BaselineCalibrator} calibrator
   *   Shared session-level calibrator — used to baseline-subtract accel channels.
   */
  constructor(calibrator) {
    this._cal        = calibrator;
    this._session    = null;   // ort.InferenceSession
    this._normalizer = null;   // { imu: {mean:[8], std:[8]}, tof: {mean:[2], std:[2]} }
    this._loading    = null;   // Promise while loading
    this.isReady     = false;
    this.loadError   = null;
  }

  // ── Load model + normalizer (idempotent) ────────────────────────────────────
  async load() {
    if (this._loading) return this._loading;
    this._loading = this._doLoad();
    return this._loading;
  }

  async _doLoad() {
    try {
      const [session, normJson] = await Promise.all([
        ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] }),
        fetch(NORMALIZER_URL).then(r => r.json()),
      ]);
      this._session    = session;
      this._normalizer = normJson;
      this.isReady     = true;
      console.log('[LearnedClassifier] model loaded:', MODEL_URL);
    } catch (e) {
      this.loadError = e.message;
      console.error('[LearnedClassifier] load failed:', e);
    }
  }

  // ── Classify a scene ────────────────────────────────────────────────────────
  /**
   * @param {object} scene  from SceneDetector — { trigger_ts, imu, tof }
   * @returns {{ classification: string, confidence: number,
   *             impact_time: number|null, basket_time: number|null,
   *             basket_type: string|null }}
   */
  async classify(scene) {
    if (!this.isReady) return _fallbackResult(scene);

    try {
      const t0     = scene.trigger_ts;
      const winLo  = t0 - PRE_S;
      const winHi  = t0 + POST_S;

      // ── Extract 8 IMU channels + 2 TOF channels ─────────────────────────
      // Channel order matches prepare_dataset_firebase.py ALL_IMU_FEATURES:
      //   [ax, ay, az] (baseline-subtracted), accel_mag, [gx, gy, gz], gyro_mag
      const cal    = this._cal;
      const imuTs  = scene.imu.map(s => s.ts);
      const ax = scene.imu.map(s => s.sample.accel[0] - (cal.accelX ?? 0));
      const ay = scene.imu.map(s => s.sample.accel[1] - (cal.accelY ?? 0));
      const az = scene.imu.map(s => s.sample.accel[2] - (cal.accelZ ?? 0));
      const am = scene.imu.map(s => s.mag);   // already baseline-subtracted
      const gx = scene.imu.map(s => s.sample.gyro[0]); // raw, no baseline
      const gy = scene.imu.map(s => s.sample.gyro[1]);
      const gz = scene.imu.map(s => s.sample.gyro[2]);
      const gm = scene.imu.map(s => Math.sqrt(
        s.sample.gyro[0] ** 2 + s.sample.gyro[1] ** 2 + s.sample.gyro[2] ** 2));

      const tofTs  = scene.tof.map(s => s.ts);
      const tofRng = scene.tof.map(s => s.distance);
      const tofSr  = scene.tof.map(s => s.signalRate);

      // ── Resample onto uniform grids ─────────────────────────────────────
      const imuGrid  = linspace(winLo, winHi, T_IMU);
      const tofGrid  = linspace(winLo, winHi, T_TOF);

      const imuRaw = [ax, ay, az, am, gx, gy, gz, gm]
        .map(ch => interp(imuGrid, imuTs, ch));
      const tofRngR  = tofTs.length >= 2 ? interp(tofGrid, tofTs, tofRng)
                                          : new Float32Array(T_TOF).fill(1000);
      const tofSrR   = tofTs.length >= 2 ? interp(tofGrid, tofTs, tofSr)
                                          : new Float32Array(T_TOF).fill(0);

      // ── Normalize → pack (C, T) buffers ──────────────────────────────────
      const norm = this._normalizer;
      const xImu = normaliseNch(imuRaw,           norm.imu.mean, norm.imu.std);
      const xTof = normaliseNch([tofRngR, tofSrR], norm.tof.mean, norm.tof.std);

      // ── Build ONNX tensors — shape (1, C, T) ─────────────────────────────
      const tensorImu = new ort.Tensor('float32', xImu, [1, C_IMU, T_IMU]);
      const tensorTof = new ort.Tensor('float32', xTof, [1, C_TOF, T_TOF]);

      // ── Inference ────────────────────────────────────────────────────────
      const t1 = performance.now();
      const out  = await this._session.run({ x_imu: tensorImu, x_tof: tensorTof });
      const dt   = (performance.now() - t1).toFixed(1);
      console.log(`[CNN] inference ${dt} ms`);

      // ── Decode logits → softmax label ────────────────────────────────────
      const logits = Array.from(out[Object.keys(out)[0]].data);
      const probs  = softmax(logits);
      const ci     = argmax(probs);

      return {
        classification: ci === 2 ? 'MAKE' : ci === 1 ? 'MISS' : 'NOT_SHOT',
        confidence:     probs[ci],
        impact_time:    scene.trigger_type === 'imu' ? t0 : null,
        basket_time:    scene.trigger_type === 'tof' ? t0 : null,
        basket_type:    null,   // CNN doesn't distinguish basket type
      };
    } catch (e) {
      console.error('[LearnedClassifier] inference error:', e);
      return _fallbackResult(scene);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _fallbackResult(scene) {
  return {
    classification: 'MISS',
    confidence:     0.5,
    impact_time:    scene.trigger_ts,
    basket_time:    null,
    basket_type:    null,
  };
}

/** np.linspace equivalent */
function linspace(lo, hi, n) {
  const arr  = new Float32Array(n);
  const step = (hi - lo) / (n - 1);
  for (let i = 0; i < n; i++) arr[i] = lo + i * step;
  return arr;
}

/** 1-D linear interpolation (like np.interp) — clamps to edge values */
function interp(xq, x, y) {
  const out = new Float32Array(xq.length);
  for (let qi = 0; qi < xq.length; qi++) {
    const xi = xq[qi];
    if (x.length === 0)  { out[qi] = 0; continue; }
    if (xi <= x[0])      { out[qi] = y[0]; continue; }
    if (xi >= x[x.length - 1]) { out[qi] = y[y.length - 1]; continue; }
    // Binary search
    let lo = 0, hi = x.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; x[m] <= xi ? lo = m : hi = m; }
    const t = (xi - x[lo]) / (x[hi] - x[lo]);
    out[qi] = y[lo] + t * (y[hi] - y[lo]);
  }
  return out;
}

/**
 * Normalise N channels and pack into (C, T) Float32Array.
 * channels: Array of C Float32Arrays, each length T.
 * mean, std: Arrays of length C.
 */
function normaliseNch(channels, mean, std) {
  const C   = channels.length;
  const T   = channels[0].length;
  const out = new Float32Array(C * T);
  for (let c = 0; c < C; c++) {
    const s = (std[c] > 0 ? std[c] : 1);
    const m = mean[c];
    const base = c * T;
    const ch   = channels[c];
    for (let i = 0; i < T; i++) out[base + i] = (ch[i] - m) / s;
  }
  return out;
}

function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map(x => Math.exp(x - max));
  const sum  = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

function argmax(arr) {
  return arr.reduce((best, v, i) => v > arr[best] ? i : best, 0);
}
