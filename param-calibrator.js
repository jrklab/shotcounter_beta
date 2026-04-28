'use strict';

/**
 * param-calibrator.js — Two-phase calibration routine for classifier parameters.
 *
 * Phase 1 — Baseline (3 s, automatic):
 *   Captures idle accel and ToF data to establish per-axis accel baseline and
 *   the resting ToF distance (sensor-to-rim).
 *
 * Phase 2 — Collection (runs until user calls stop()):
 *   Accumulates all residual accel magnitudes and all ball-over-sensor ToF
 *   readings. No shot detection — the user shoots freely and presses Stop.
 *
 *   "Ball-over-sensor" readings: valid ToF samples whose distance is at least
 *   30 mm below the resting baseline distance.
 *
 * Suggested values are computed as:
 *   IMPACT_ACCEL_THRESHOLD      = 10th-pct(residuals > 0.3 g) × 0.8  (floor 0.3 g)
 *   TOF_DISTANCE_THRESHOLD_HIGH = 95th-pct(ball_distances) + 20 mm
 *   TOF_DISTANCE_THRESHOLD_LOW  = 5th-pct(ball_distances)  − 20 mm  (floor 0)
 *   TOF_SIGNAL_RATE_THRESHOLD   = 10th-pct(ball_SRs) × 0.8
 *
 * A warning is included in stats when fewer than MIN_TOF_READINGS (20) ball
 * readings were collected, but results are always calculated.
 *
 * Callbacks:
 *   onBaselineProgress(fraction)  — progress 0..1 while capturing baseline
 *   onShootingStart()             — baseline complete; collection phase begins
 *   onTofCount(count)             — fires each time a ball ToF reading is added
 *   onComplete(suggestions, stats) — called by stop(); always fires if in shooting phase
 */

const INVALID_TOF = new Set([0xFFFE, 65534, 0xFFFF, 65535, 0]);

// ── Stats helpers ──────────────────────────────────────────────────────────────

function _median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function _madMean(arr) {
  if (!arr.length) return 0;
  if (arr.length < 4) return arr.reduce((a, b) => a + b, 0) / arr.length;
  const med  = _median(arr);
  const devs = arr.map(x => Math.abs(x - med));
  const mad  = _median(devs);
  if (mad === 0) return med;
  const K       = 2.5;
  const inliers = arr.filter(x => Math.abs(x - med) <= K * mad);
  return inliers.length ? inliers.reduce((a, b) => a + b, 0) / inliers.length : med;
}

function _percentile(arr, p) {
  if (!arr.length) return 0;
  const s   = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

// ── ParamCalibrator ────────────────────────────────────────────────────────────

export class ParamCalibrator {
  constructor() {
    this.BASELINE_DURATION = 3.0;  // seconds of idle data
    this.MIN_TOF_READINGS  = 20;   // warn if fewer ball readings collected

    /** @type {(fraction: number) => void} */
    this.onBaselineProgress = null;
    /** @type {() => void} */
    this.onShootingStart    = null;
    /** @type {(count: number) => void} */
    this.onTofCount         = null;
    /** @type {(suggestions: object, stats: object) => void} */
    this.onComplete         = null;

    this._reset();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Begin calibration. */
  start() {
    this._reset();
    this._phase = 'baseline';
  }

  /** Abort without computing results. */
  cancel() {
    this._phase = 'idle';
  }

  /** End collection and compute suggestions. Safe to call from any phase. */
  stop() {
    if (this._phase === 'shooting') this._finalize();
    else this._phase = 'idle';
  }

  /** Feed one parsed sensor sample. */
  push(sample) {
    if (this._phase === 'idle' || this._phase === 'done') return;
    const ts = sample.mpu_ts / 1000.0;
    if (this._phase === 'baseline') this._collectBaseline(sample, ts);
    else                            this._collectSample(sample);
  }

  // ── Phase 1: baseline ──────────────────────────────────────────────────────

  _collectBaseline(sample, ts) {
    if (this._baselineStart === null) this._baselineStart = ts;
    const elapsed = ts - this._baselineStart;
    this.onBaselineProgress?.(Math.min(elapsed / this.BASELINE_DURATION, 1));

    this._baselineAccels.push(sample.accel);
    const isValid = !INVALID_TOF.has(sample.distance) && sample.distance > 0;
    if (isValid) this._baselineTof.push(sample.distance);

    if (elapsed >= this.BASELINE_DURATION) {
      this._finalizeBaseline();
      this._phase = 'shooting';
      this.onShootingStart?.();
    }
  }

  _finalizeBaseline() {
    const axs = this._baselineAccels.map(a => a[0]);
    const ays = this._baselineAccels.map(a => a[1]);
    const azs = this._baselineAccels.map(a => a[2]);
    this._accelBL = {
      x: _madMean(axs),
      y: _madMean(ays),
      z: _madMean(azs),
    };
    this._tofBaselineDist = this._baselineTof.length >= 5
      ? _percentile(this._baselineTof, 50)
      : null;
  }

  // ── Phase 2: continuous collection ────────────────────────────────────────

  _collectSample(sample) {
    const isValid = !INVALID_TOF.has(sample.distance) && sample.distance > 0;

    // Residual accel magnitude
    const dx  = sample.accel[0] - this._accelBL.x;
    const dy  = sample.accel[1] - this._accelBL.y;
    const dz  = sample.accel[2] - this._accelBL.z;
    const mag = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (mag > 0.3) this._residualMags.push(mag);  // keep only above noise floor

    // Ball-over-sensor: distance at least 30 mm below the resting baseline
    if (isValid) {
      const isBall = this._tofBaselineDist !== null
        ? sample.distance < this._tofBaselineDist - 30
        : true;  // no baseline distance available — accept all valid readings
      if (isBall) {
        this._ballDists.push(sample.distance);
        this._ballSRs.push(sample.signal_rate);
        this.onTofCount?.(this._ballDists.length);
      }
    }
  }

  _finalize() {
    this._phase = 'done';

    // ── IMPACT_ACCEL_THRESHOLD ───────────────────────────────────────────────
    // 10th percentile of above-noise residuals × 0.8, so the threshold sits
    // just below the weakest shot impacts captured during collection.
    const accelThr = this._residualMags.length
      ? parseFloat(Math.max(0.3, _percentile(this._residualMags, 10) * 0.8).toFixed(1))
      : 1.0;

    // ── ToF thresholds ───────────────────────────────────────────────────────
    let tofHigh, tofLow, srThr;
    if (this._ballDists.length > 0) {
      tofHigh = Math.round(_percentile(this._ballDists,  95) + 20);
      tofLow  = Math.max(0, Math.round(_percentile(this._ballDists,   5) - 20));
      srThr   = Math.round(_percentile(this._ballSRs,   10) * 0.8);
    } else {
      // Fallback to defaults if no ball readings were collected
      tofHigh = 360;
      tofLow  = 60;
      srThr   = 500;
    }

    const suggestions = {
      IMPACT_ACCEL_THRESHOLD:      accelThr,
      TOF_DISTANCE_THRESHOLD_HIGH: tofHigh,
      TOF_DISTANCE_THRESHOLD_LOW:  tofLow,
      TOF_SIGNAL_RATE_THRESHOLD:   srThr,
    };

    // ── Raw reference statistics ────────────────────────────────────────────
    const maxAccel = this._residualMags.length
      ? parseFloat(Math.max(...this._residualMags).toFixed(2))
      : null;
    const maxTof = this._ballDists.length ? Math.max(...this._ballDists) : null;
    const minTof = this._ballDists.length ? Math.min(...this._ballDists) : null;
    const maxSR  = this._ballSRs.length   ? Math.max(...this._ballSRs)   : null;
    const minSR  = this._ballSRs.length   ? Math.min(...this._ballSRs)   : null;

    const stats = {
      tofSampleCount:   this._ballDists.length,
      tofBaselineDist:  this._tofBaselineDist !== null ? Math.round(this._tofBaselineDist) : null,
      accelSampleCount: this._residualMags.length,
      lowTofWarning:    this._ballDists.length < this.MIN_TOF_READINGS,
      // Raw observed values for user reference
      maxAccel,
      maxTof,
      minTof,
      maxSR,
      minSR,
    };

    this.onComplete?.(suggestions, stats);
  }

  _reset() {
    this._phase          = 'idle';
    this._baselineStart  = null;
    this._baselineAccels = [];
    this._baselineTof    = [];
    this._accelBL        = { x: 0, y: 0, z: 0 };
    this._tofBaselineDist = null;
    this._residualMags   = [];
    this._ballDists      = [];
    this._ballSRs        = [];
  }
}

