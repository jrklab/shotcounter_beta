'use strict';

/**
 * param-calibrator.js — Two-phase calibration routine for classifier parameters.
 *
 * Phase 1 — Baseline (3 s, automatic):
 *   Captures idle accel and ToF data to establish per-axis accel baseline and
 *   the resting ToF distance (sensor-to-rim).
 *
 * Phase 2 — Collection (runs until user calls stop()):
 *   Accumulates all residual accel magnitudes and all valid ToF readings.
 *   No shot detection — the user shoots freely and presses Stop.
 *
 *   "Valid" ToF readings: distance is not an error code and is > 0.
 *
 * Suggested values are computed as:
 *   IMPACT_ACCEL_THRESHOLD      = 10th-pct(residuals > 0.3 g) × 0.8  (floor 0.3 g)
 *   TOF_DISTANCE_THRESHOLD_HIGH = 95th-pct(shoot_distances) + 20 mm
 *   TOF_DISTANCE_THRESHOLD_LOW  = 5th-pct(shoot_distances)  − 20 mm  (floor 0)
 *   TOF_SIGNAL_RATE_THRESHOLD   = 10th-pct(shoot_SRs) × 0.8
 *
 * A warning is included in stats when fewer than MIN_TOF_READINGS (20) shooting
 * readings were collected, but results are always calculated.
 *
 * Callbacks:
 *   onBaselineProgress(fraction)  — progress 0..1 while capturing baseline
 *   onShootingStart()             — baseline complete; collection phase begins
 *   onTofCount(count)             — fires each time a ball ToF reading is added
 *   onComplete(suggestions, stats) — called by stop(); always fires if in shooting phase
 */



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

  /** Feed one batch of separate MPU and ToF samples (post-filter). */
  pushBatch(mpuBatch, tofBatch) {
    if (this._phase === 'idle' || this._phase === 'done') return;
    for (const s of mpuBatch) this._processMpu(s);
    for (const s of tofBatch) this._processTof(s);
  }

  // ── Phase 1: baseline ──────────────────────────────────────────────────────

  _processMpu(mpuS) {
    if (this._phase === 'idle' || this._phase === 'done') return;
    const wallNow = performance.now() / 1000;
    if (this._baselineStart === null) this._baselineStart = wallNow;
    const elapsed = wallNow - this._baselineStart;

    if (this._phase === 'baseline') {
      this.onBaselineProgress?.(Math.min(elapsed / this.BASELINE_DURATION, 1));
      this._baselineAccels.push(mpuS.accel);
      if (elapsed >= this.BASELINE_DURATION) {
        this._finalizeBaseline();
        this._phase = 'shooting';
        this.onShootingStart?.();
      }
    } else if (this._phase === 'shooting') {
      const bl  = this._accelBL;
      const dx  = mpuS.accel[0] - bl.x;
      const dy  = mpuS.accel[1] - bl.y;
      const dz  = mpuS.accel[2] - bl.z;
      const mag = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (mag > 0.3) this._residualMags.push(mag);
    }
  }

  _processTof(tofS) {
    if (this._phase === 'idle' || this._phase === 'done') return;
    const isValid = !tofS.isOor && tofS.distance > 0;
    if (!isValid) return;

    if (this._phase === 'baseline') {
      this._baselineTof.push(tofS.distance);
      this._baselineSRs.push(tofS.sr);
    } else if (this._phase === 'shooting') {
      this._shootDists.push(tofS.distance);
      this._shootSRs.push(tofS.sr);
      this.onTofCount?.(this._shootDists.length);
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

  // ── Phase 2 finalise ──────────────────────────────────────────────────────

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
    if (this._shootDists.length > 0) {
      tofHigh = Math.round(_percentile(this._shootDists,  95) + 20);
      tofLow  = Math.max(0, Math.round(_percentile(this._shootDists,   5) - 20));
      srThr   = Math.round(_percentile(this._shootSRs,   10) * 0.8);
    } else {
      // Fallback to defaults if no ball readings were collected
      tofHigh = 360;
      tofLow  = 60;
      srThr   = 500;
    }

    const classicSuggestions = {
      IMPACT_ACCEL_THRESHOLD:      accelThr,
      TOF_DISTANCE_THRESHOLD_HIGH: tofHigh,
      TOF_DISTANCE_THRESHOLD_LOW:  tofLow,
      TOF_SIGNAL_RATE_THRESHOLD:   srThr,
    };

    // Learned classifier uses wider ToF gates (effectively no range restriction)
    // and lower trigger thresholds so the CNN sees more candidate windows.
    const learnedSuggestions = {
      IMPACT_ACCEL_THRESHOLD:      parseFloat((classicSuggestions.IMPACT_ACCEL_THRESHOLD * 0.6).toFixed(1)),
      TOF_DISTANCE_THRESHOLD_HIGH: 1300,  // no upper range restriction
      TOF_DISTANCE_THRESHOLD_LOW:  0,     // no lower range restriction
      TOF_SIGNAL_RATE_THRESHOLD:   Math.round(classicSuggestions.TOF_SIGNAL_RATE_THRESHOLD * 0.6),
    };

    const suggestions = { classic: classicSuggestions, learned: learnedSuggestions };

    // ── Raw reference statistics ────────────────────────────────────────────
    const maxAccel = this._residualMags.length
      ? parseFloat(Math.max(...this._residualMags).toFixed(2))
      : null;

    // Baseline ToF stats
    const blMaxTof = this._baselineTof.length ? Math.max(...this._baselineTof) : null;
    const blMinTof = this._baselineTof.length ? Math.min(...this._baselineTof) : null;
    const blMaxSR  = this._baselineSRs.length ? Math.max(...this._baselineSRs) : null;
    const blMinSR  = this._baselineSRs.length ? Math.min(...this._baselineSRs) : null;

    // Shooting ToF stats
    const maxTof = this._shootDists.length ? Math.max(...this._shootDists) : null;
    const minTof = this._shootDists.length ? Math.min(...this._shootDists) : null;
    const maxSR  = this._shootSRs.length   ? Math.max(...this._shootSRs)   : null;
    const minSR  = this._shootSRs.length   ? Math.min(...this._shootSRs)   : null;

    const stats = {
      tofSampleCount:   this._shootDists.length,
      tofBaselineDist:  this._tofBaselineDist !== null ? Math.round(this._tofBaselineDist) : null,
      accelSampleCount: this._residualMags.length,
      lowTofWarning:    this._shootDists.length < this.MIN_TOF_READINGS,
      // Baseline observed values
      maxAccel,
      blMaxTof,
      blMinTof,
      blMaxSR,
      blMinSR,
      // Shooting observed values
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
    this._shootDists     = [];
    this._shootSRs       = [];
    this._baselineSRs    = [];
  }
}

