'use strict';

/**
 * sensor_filter.js — First-order IIR high-pass filters for MPU and ToF streams.
 *
 * Mirrors SensorFilter.kt (Android) and viz/shared/sensor_filter.py.
 *
 *   alpha = RC / (RC + dt),   RC = 1 / (2π·fc)
 *   y[n]  = alpha * (y[n-1] + x[n] - x[n-1])
 */

function _computeAlpha(fc, fs) {
  const dt = 1.0 / fs;
  const rc = 1.0 / (2.0 * Math.PI * fc);
  return rc / (rc + dt);
}

/**
 * 6-channel MPU high-pass filter (ax, ay, az, gx, gy, gz).
 * Mirrors MpuHighPassFilter in SensorFilter.kt.
 *
 * Input/output sample shape: { accel: [ax, ay, az], gyro: [gx, gy, gz], ts: number (ms) }
 */
export class MpuHighPassFilter {
  /**
   * @param {number} fc  Cut-off frequency in Hz
   * @param {number} fs  Sample rate in Hz (default 200)
   */
  constructor(fc, fs = 200) {
    this._alpha = _computeAlpha(fc, fs);
    this.reset();
  }

  reset() {
    this._prevIn  = [0, 0, 0, 0, 0, 0];
    this._prevOut = [0, 0, 0, 0, 0, 0];
    this._primed  = false;
  }

  /**
   * Process a batch of MPU samples.
   * @param {Array<{accel:number[], gyro:number[], ts:number}>} batch
   * @returns {Array<{accel:number[], gyro:number[], ts:number}>}
   */
  process(batch) {
    const α = this._alpha;
    return batch.map(s => {
      const raw = [
        s.accel[0], s.accel[1], s.accel[2],
        s.gyro[0],  s.gyro[1],  s.gyro[2],
      ];
      const out = [0, 0, 0, 0, 0, 0];
      if (!this._primed) {
        for (let i = 0; i < 6; i++) this._prevIn[i] = raw[i];
        this._prevOut.fill(0);
        this._primed = true;
        // First output is zero — filter settling
      } else {
        for (let i = 0; i < 6; i++) {
          out[i] = α * (this._prevOut[i] + raw[i] - this._prevIn[i]);
          this._prevIn[i]  = raw[i];
          this._prevOut[i] = out[i];
        }
      }
      return {
        accel: [out[0], out[1], out[2]],
        gyro:  [out[3], out[4], out[5]],
        ts:    s.ts,
      };
    });
  }
}

/**
 * 2-channel ToF high-pass filter (distance, signal rate).
 *
 * OOR samples substitute the last valid range to avoid transients — same as
 * TofHighPassFilter in SensorFilter.kt. The isOor flag is preserved on output.
 *
 * Input/output sample shape: { distance: number, sr: number, ts: number (ms), isOor: boolean }
 */
export class TofHighPassFilter {
  /**
   * @param {number} fc  Cut-off frequency in Hz
   * @param {number} fs  Sample rate in Hz (default 40)
   */
  constructor(fc, fs = 40) {
    this._alpha = _computeAlpha(fc, fs);
    this.reset();
  }

  reset() {
    this._prevRangeIn  = 0;  this._prevRangeOut = 0;
    this._prevSrIn     = 0;  this._prevSrOut    = 0;
    this._lastValid    = 0;
    this._primed       = false;
  }

  /**
   * Process a batch of ToF samples.
   * @param {Array<{distance:number, sr:number, ts:number, isOor:boolean}>} batch
   * @returns {Array<{distance:number, sr:number, ts:number, isOor:boolean}>}
   */
  process(batch) {
    const α = this._alpha;
    return batch.map(s => {
      // Substitute last valid range for OOR entries to keep filter state continuous
      const rawRange = s.isOor ? this._lastValid : s.distance;
      if (!s.isOor) this._lastValid = s.distance;
      const rawSr = s.sr;

      let fRange, fSr;
      if (!this._primed) {
        this._prevRangeIn = rawRange;  this._prevRangeOut = 0;
        this._prevSrIn    = rawSr;     this._prevSrOut    = 0;
        this._primed = true;
        fRange = 0;  fSr = 0;
      } else {
        fRange = α * (this._prevRangeOut + rawRange - this._prevRangeIn);
        this._prevRangeIn  = rawRange;  this._prevRangeOut = fRange;
        fSr    = α * (this._prevSrOut   + rawSr    - this._prevSrIn);
        this._prevSrIn     = rawSr;     this._prevSrOut    = fSr;
      }
      return {
        distance: Math.abs(fRange),
        sr:       Math.abs(fSr),
        ts:       s.ts,
        isOor:    s.isOor,
      };
    });
  }
}
