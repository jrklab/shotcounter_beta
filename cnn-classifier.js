'use strict';

/**
 * cnn-classifier.js — Learned shot classifier using ONNX Runtime Web.
 *
 * Model: dual-branch 1D-CNN (primary), ~9.5 k params.
 *   Inputs:
 *     x_imu  Float32 (1, C_IMU, T_IMU) — IMU channels from EXP_FEATURES, resampled @ 200 Hz, normalised
 *     x_tof  Float32 (1, C_TOF, T_TOF) — TOF channels from EXP_FEATURES, resampled @ 40 Hz, normalised
 *   Output:
 *     logits Float32 (1, 3)             — [Not-a-shot, Miss, Make]
 *
 * Active features are driven by EXP_FEATURES in config.js (must match ml/dataset_config.py).
 * T_IMU, T_TOF, C_IMU, C_TOF are read from normalizer.json._meta at load time
 * so they stay in sync with the exported model automatically.
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
import { PRE_S, POST_S, IMU_HZ, TOF_HZ, TOF_OOR_FILL_MM, EXP_FEATURES } from './config.js';

// ── Feature ordering (must match ALL_IMU/TOF_FEATURES in prepare_dataset_firebase.py) ─
// Channels are appended in this fixed order; EXP_FEATURES selects which groups to include.
// accel_xyz → [ax, ay, az] (baseline-subtracted, g)
// accel_mag → [√(ax²+ay²+az²)] (g)
// gyro_xyz  → [gx, gy, gz] (raw, °/s)
// gyro_mag  → [√(gx²+gy²+gz²)] (°/s)
// tof_range → [distance mm]
// tof_sr    → [signal rate]
//
// T_IMU, T_TOF, C_IMU, C_TOF are read from normalizer.json _meta after load()
// — they are the authoritative values exported by ml/export_onnx.py.
const ALL_IMU_FEATURES = ['accel_xyz', 'accel_mag', 'gyro_xyz', 'gyro_mag'];
const ALL_TOF_FEATURES = ['tof_range', 'tof_sr'];

// Label indices (must match LABEL_MAP in train_cnn.py)
const LABEL_NAMES = ['Not-a-shot', 'Miss', 'Make'];

// ── Model paths ──────────────────────────────────────────────────────────────
const MODEL_URL      = './model/primary.onnx';
const NORMALIZER_URL = './model/normalizer.json';

export class LearnedClassifier {
  /**
   * @param {import('./rule-classifier.js').BaselineCalibrator} calibrator
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
      // Tell ORT where to find WASM binaries (same CDN, same version).
      // numThreads=1 uses the non-threaded build — no SharedArrayBuffer required.
      ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/';
      ort.env.wasm.numThreads = 1;

      const [session, normJson] = await Promise.all([
        ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] }),
        fetch(NORMALIZER_URL).then(r => r.json()),
      ]);
      this._session    = session;
      this._normalizer = normJson;

      // Geometry from the exported normalizer — single source of truth
      const meta   = normJson._meta;
      this._T_IMU  = meta.T_IMU;    // e.g. 400
      this._T_TOF  = meta.T_TOF;    // e.g.  80
      this._C_IMU  = meta.c_imu;   // e.g.   8
      this._C_TOF  = meta.c_tof;   // e.g.   2

      // Sanity-check against runtime config.js constants
      const expectedT_IMU = Math.round((PRE_S + POST_S) * IMU_HZ);
      const expectedT_TOF = Math.round((PRE_S + POST_S) * TOF_HZ);
      if (this._T_IMU !== expectedT_IMU || this._T_TOF !== expectedT_TOF) {
        console.warn(
          `[LearnedClassifier] normalizer.json T_IMU/T_TOF (${this._T_IMU}/${this._T_TOF}) ` +
          `does not match config.js (${expectedT_IMU}/${expectedT_TOF}). ` +
          'Using values from normalizer.json.',
        );
      }

      this.isReady = true;
      console.log(`[LearnedClassifier] model loaded: T_IMU=${this._T_IMU} T_TOF=${this._T_TOF} C_IMU=${this._C_IMU} C_TOF=${this._C_TOF}`);
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

      // ── Extract IMU + TOF channels driven by EXP_FEATURES ────────────────
      // Channel order mirrors prepare_dataset_firebase.py: groups from
      // ALL_IMU_FEATURES / ALL_TOF_FEATURES that appear in EXP_FEATURES.
      const cal   = this._cal;
      const imuTs = scene.imu.map(s => s.ts);
      const tofTs = scene.tof.map(s => s.ts);

      const imuFeat = ALL_IMU_FEATURES.filter(f => EXP_FEATURES.includes(f));
      const tofFeat = ALL_TOF_FEATURES.filter(f => EXP_FEATURES.includes(f));

      // Build raw IMU channel arrays in ALL_IMU_FEATURES order
      const imuRawCh = [];
      if (imuFeat.includes('accel_xyz')) {
        imuRawCh.push(scene.imu.map(s => s.sample.accel[0] - (cal.accelX ?? 0)));
        imuRawCh.push(scene.imu.map(s => s.sample.accel[1] - (cal.accelY ?? 0)));
        imuRawCh.push(scene.imu.map(s => s.sample.accel[2] - (cal.accelZ ?? 0)));
      }
      if (imuFeat.includes('accel_mag')) {
        imuRawCh.push(scene.imu.map(s => s.mag));  // baseline-subtracted mag
      }
      if (imuFeat.includes('gyro_xyz')) {
        imuRawCh.push(scene.imu.map(s => s.sample.gyro[0]));
        imuRawCh.push(scene.imu.map(s => s.sample.gyro[1]));
        imuRawCh.push(scene.imu.map(s => s.sample.gyro[2]));
      }
      if (imuFeat.includes('gyro_mag')) {
        imuRawCh.push(scene.imu.map(s => Math.sqrt(
          s.sample.gyro[0] ** 2 + s.sample.gyro[1] ** 2 + s.sample.gyro[2] ** 2)));
      }

      // ── Resample onto uniform grids ─────────────────────────────────────
      const T_IMU = this._T_IMU;
      const T_TOF = this._T_TOF;
      const C_IMU = this._C_IMU;
      const C_TOF = this._C_TOF;

      const imuGrid = linspace(winLo, winHi, T_IMU);
      const tofGrid = linspace(winLo, winHi, T_TOF);

      const imuRaw = imuRawCh.map(ch => interp(imuGrid, imuTs, ch));

      // Build TOF channel arrays in ALL_TOF_FEATURES order
      const tofRaw = [];
      if (tofFeat.includes('tof_range')) {
        tofRaw.push(tofTs.length >= 2
          ? interp(tofGrid, tofTs, scene.tof.map(s => s.distance))
          : new Float32Array(T_TOF).fill(TOF_OOR_FILL_MM));
      }
      if (tofFeat.includes('tof_sr')) {
        tofRaw.push(tofTs.length >= 2
          ? interp(tofGrid, tofTs, scene.tof.map(s => s.signalRate))
          : new Float32Array(T_TOF).fill(0));
      }

      // ── Normalize → pack (C, T) buffers ──────────────────────────────────
      const norm = this._normalizer;
      const xImu = normaliseNch(imuRaw, norm.imu.mean, norm.imu.std);
      const xTof = normaliseNch(tofRaw, norm.tof.mean, norm.tof.std);

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
