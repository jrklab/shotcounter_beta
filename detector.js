'use strict';

/**
 * detector.js — Shot scene detector.
 *
 * Continuously ingests sensor samples and fires when either:
 *   • IMU residual acceleration magnitude exceeds ACCEL_TRIGGER_G, OR
 *   • ToF range < TOF_LOW_MM with sufficient signal rate
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

const INVALID_TOF = new Set([0xFFFE, 65534, 0xFFFF, 65535, 0]);

// ── Configurable thresholds ──────────────────────────────────────────────────
export class DetectorConfig {
  constructor() {
    // IMU trigger: residual accel magnitude above baseline (g)
    this.ACCEL_TRIGGER_G    = 2.0;

    // ToF trigger: ball over sensor (low range + sufficient signal rate)
    this.TOF_LOW_MM         = 200;   // mm — range below this is "ball in basket"
    this.TOF_SR_THRESHOLD   = 500;   // signal-rate units

    // Scene window (must match ML training window)
    this.PRE_S              = 0.5;   // seconds before trigger
    this.POST_S             = 1.5;   // seconds after trigger

    // After emitting a scene, ignore triggers for this long
    this.BLACKOUT_S         = 2.0;
  }
}

// ── Scene detector ───────────────────────────────────────────────────────────
export class SceneDetector {
  /**
   * @param {import('./classifier.js').BaselineCalibrator} calibrator
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

  /** Process one sensor sample (from parser batch). */
  push(sample) {
    if (!this._cal.isComplete) return;

    const mpuTs = sample.mpu_ts / 1000.0;  // ms → s
    const tofTs = sample.tof_ts / 1000.0;
    const isValidTof = !INVALID_TOF.has(sample.distance) && sample.distance > 0;

    // Residual accel magnitude (using calibrated baseline)
    const dx  = sample.accel[0] - this._cal.accelX;
    const dy  = sample.accel[1] - this._cal.accelY;
    const dz  = sample.accel[2] - this._cal.accelZ;
    const mag = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (this._state === 'IDLE') {
      // ── Maintain pre-window ring buffer ─────────────────────────────────
      this._imuBuf.push({ ts: mpuTs, mag, sample });
      this._pruneImuBuf(mpuTs);
      if (isValidTof) {
        this._tofBuf.push({ ts: tofTs, distance: sample.distance, signalRate: sample.signal_rate });
        this._pruneTofBuf(tofTs);
      }

      // ── Check trigger conditions ─────────────────────────────────────────
      const cfg    = this._cfg;
      const imuHit = mag > cfg.ACCEL_TRIGGER_G;
      const tofHit = isValidTof &&
                     sample.distance < cfg.TOF_LOW_MM &&
                     sample.signal_rate > cfg.TOF_SR_THRESHOLD;

      if (imuHit || tofHit) {
        this._t0           = imuHit ? mpuTs : tofTs;
        this._triggerType  = imuHit ? 'imu'  : 'tof';
        this._postImu      = [];
        this._postTof      = [];
        this._state        = 'COLLECTING';
      }

    } else if (this._state === 'COLLECTING') {
      // ── Accumulate post-trigger samples ──────────────────────────────────
      this._postImu.push({ ts: mpuTs, mag, sample });
      if (isValidTof) {
        this._postTof.push({ ts: tofTs, distance: sample.distance, signalRate: sample.signal_rate });
      }

      // Emit once we have POST_S of data past the trigger
      if (mpuTs >= this._t0 + this._cfg.POST_S)
        this._emitScene(mpuTs);

    } else if (this._state === 'BLACKOUT') {
      // ── Wait out blackout period ─────────────────────────────────────────
      if (mpuTs >= this._blackoutEnd) {
        this._state   = 'IDLE';
        this._imuBuf  = [];
        this._tofBuf  = [];
      }
    }
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
