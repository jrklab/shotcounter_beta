'use strict';

/**
 * detector.js — Shot scene detector.
 *
 * Continuously ingests sensor samples and fires when either:
 *   • IMU residual acceleration magnitude exceeds ACCEL_TRIGGER_G, OR
 *   • TOF_LOW_MM < ToF range < TOF_HIGH_MM with sufficient signal rate
 *
 * On trigger at T0, it:
 *   1. Freezes the pre-T0 ring buffer as the pre-window.
 *   2. Keeps collecting until T0 + POST_S, then emits the full scene.
 *   3. Enters blackout for BLACKOUT_S so adjacent triggers don't overlap.
 *
 * Scene object emitted via onScene(scene):
 * {
 *   trigger_ts   : number   device time of trigger (s)
 *   trigger_type : 'imu' | 'tof'
 *   imu  : [{ ts, mag, sample }]           — PRE_S … T0+POST_S
 *   tof  : [{ ts, distance, signalRate }]  — same window (valid readings only)
 * }
 */

import { PRE_S, POST_S } from './config.js';

// ── Configurable thresholds ──────────────────────────────────────────────────
export class DetectorConfig {
  constructor() {
    // IMU trigger: residual accel magnitude above baseline (g)
    this.IMPACT_ACCEL_THRESHOLD         = 1;

    // ToF trigger: ball over sensor (between low and high range + sufficient signal rate)
    this.TOF_DISTANCE_THRESHOLD_LOW     = 0;     // mm — range below this is "no basket"
    this.TOF_DISTANCE_THRESHOLD_HIGH    = 1300;  // mm — range above this is "no ball"
    this.TOF_SIGNAL_RATE_THRESHOLD      = 500;   // signal-rate units

    // Scene window — values from config.js (must match ML training)
    this.PRE_S              = PRE_S;
    this.POST_S             = POST_S;

    // After emitting a scene, ignore triggers for this long
    this.BLACKOUT_S         = 0.5;
  }
}

// ── Scene detector ───────────────────────────────────────────────────────────
export class SceneDetector {
  /**
   * @param {import('./rule-classifier.js').BaselineCalibrator} calibrator
   *   Shared session-level calibrator — detector will not trigger until complete.
   * @param {DetectorConfig} [config]
   */
  constructor(calibrator, config) {
    this._cal  = calibrator;
    this._cfg  = config ?? new DetectorConfig();

    /** @type {function(scene: object): void | null} */
    this.onScene = null;

    this._reset();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Process one packet's MPU and ToF streams in timestamp order.
   * Replaces the old push(sample) API.
   * @param {Array<{accel:number[], gyro:number[], ts:number}>} mpuBatch
   * @param {Array<{distance:number, sr:number, ts:number, isOor:boolean}>} tofBatch
   */
  pushBatch(mpuBatch, tofBatch) {
    // Two-pointer merge: process MPU and ToF in timestamp order
    let ti = 0;
    for (const mpuS of mpuBatch) {
      while (ti < tofBatch.length && tofBatch[ti].ts <= mpuS.ts) {
        this._pushTof(tofBatch[ti++]);
      }
      this._pushMpu(mpuS);
    }
    while (ti < tofBatch.length) this._pushTof(tofBatch[ti++]);
  }

  _pushMpu(mpuS) {
    if (!this._cal.isComplete) return;
    const mpuTs = mpuS.ts / 1000.0;  // ms → s

    const dx  = mpuS.accel[0] - this._cal.accelX;
    const dy  = mpuS.accel[1] - this._cal.accelY;
    const dz  = mpuS.accel[2] - this._cal.accelZ;
    const mag = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (this._state === 'IDLE') {
      this._imuBuf.push({ ts: mpuTs, mag, accel: mpuS.accel, gyro: mpuS.gyro });
      this._pruneImuBuf(mpuTs);
      if (mag > this._cfg.IMPACT_ACCEL_THRESHOLD) {
        this._t0          = mpuTs;
        this._triggerType = 'imu';
        this._postImu     = [];
        this._postTof     = [];
        this._state       = 'COLLECTING';
      }
    } else if (this._state === 'COLLECTING') {
      this._postImu.push({ ts: mpuTs, mag, accel: mpuS.accel, gyro: mpuS.gyro });
      if (mpuTs >= this._t0 + this._cfg.POST_S) this._emitScene(mpuTs);
    } else if (this._state === 'BLACKOUT') {
      if (mpuTs >= this._blackoutEnd) {
        this._state  = 'IDLE';
        this._imuBuf = [];
        this._tofBuf = [];
      }
    }
  }

  _pushTof(tofS) {
    if (!this._cal.isComplete) return;
    const tofTs    = tofS.ts / 1000.0;  // ms → s
    const isValid  = !tofS.isOor && tofS.distance > 0;
    const cfg      = this._cfg;

    if (this._state === 'IDLE') {
      if (isValid) {
        this._tofBuf.push({ ts: tofTs, distance: tofS.distance, signalRate: tofS.sr });
        this._pruneTofBuf(tofTs);
      }
      const tofHit = isValid &&
        tofS.sr > cfg.TOF_SIGNAL_RATE_THRESHOLD &&
        tofS.distance < cfg.TOF_DISTANCE_THRESHOLD_HIGH &&
        tofS.distance > cfg.TOF_DISTANCE_THRESHOLD_LOW;
      if (tofHit) {
        this._t0          = tofTs;
        this._triggerType = 'tof';
        this._postImu     = [];
        this._postTof     = [];
        this._state       = 'COLLECTING';
      }
    } else if (this._state === 'COLLECTING') {
      if (isValid)
        this._postTof.push({ ts: tofTs, distance: tofS.distance, signalRate: tofS.sr });
      // Emit is driven by MPU time — no need to check here
    }
    // BLACKOUT: handled by _pushMpu
  }

  /** Reset to initial state (e.g. new session). */
  reset() { this._reset(); }

  // ── Internal ────────────────────────────────────────────────────────────────

  _reset() {
    this._state       = 'IDLE';
    this._imuBuf      = [];    // ring buffer — pre-window IMU
    this._tofBuf      = [];    // ring buffer — pre-window ToF
    this._t0          = null;
    this._triggerType = null;
    this._postImu     = [];
    this._postTof     = [];
    this._blackoutEnd = null;
  }

  _emitScene(nowTs) {
    const cfg = this._cfg;
    const t0  = this._t0;

    // Extract the pre-window from the ring buffer
    const preImu = this._imuBuf.filter(s => s.ts  >= t0 - cfg.PRE_S);
    const preTof = this._tofBuf.filter(s => s.ts  >= t0 - cfg.PRE_S);

    // Trim post-window to exactly T0 + POST_S
    const postImu = this._postImu.filter(s => s.ts <= t0 + cfg.POST_S);
    const postTof = this._postTof.filter(s => s.ts <= t0 + cfg.POST_S);

    const scene = {
      trigger_ts:   t0,
      trigger_type: this._triggerType,
      imu: [...preImu, ...postImu],
      tof: [...preTof, ...postTof],
    };

    // Enter blackout
    this._state       = 'BLACKOUT';
    this._blackoutEnd = t0 + cfg.POST_S + cfg.BLACKOUT_S;
    this._t0          = null;
    this._imuBuf      = [];
    this._tofBuf      = [];
    this._postImu     = [];
    this._postTof     = [];

    if (this.onScene) this.onScene(scene);
  }

  _pruneImuBuf(nowTs) {
    const cutoff = nowTs - this._cfg.PRE_S * 2;
    const idx    = this._imuBuf.findIndex(s => s.ts >= cutoff);
    if (idx > 0) this._imuBuf.splice(0, idx);
  }

  _pruneTofBuf(nowTs) {
    const cutoff = nowTs - this._cfg.PRE_S * 2;
    const idx    = this._tofBuf.findIndex(s => s.ts >= cutoff);
    if (idx > 0) this._tofBuf.splice(0, idx);
  }
}
