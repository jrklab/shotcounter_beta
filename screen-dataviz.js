'use strict';
/**
 * screen-dataviz.js — Real-time rolling sensor data visualisation.
 *
 * Renders 4 canvas charts showing the last DISPLAY_S seconds of raw and
 * filtered sensor data drawn from S.rawMpuWindow / S.filtMpuWindow /
 * S.rawTofWindow / S.filtTofWindow.
 *
 * Charts (top to bottom):
 *  1. Accel magnitude (g)
 *  2. Gyro  magnitude (°/s)
 *  3. ToF distance (mm, OOR samples at −1)
 *  4. ToF signal rate (kcps)
 *
 * Two traces per chart: raw (muted #445566) and filtered (bright #2980b9 for
 * accel/gyro, #2ecc71 for ToF).  If no filter is active (filtWindow empty),
 * only the raw trace is drawn.
 *
 * The render loop uses requestAnimationFrame and is active only while the
 * data-viz screen is visible.
 */

import { S }              from './state.js';
import { showScreen }     from './utils.js';

const DISPLAY_S      = 5;          // seconds of data to show
const MPU_FS         = 200;        // nominal MPU sample rate
const TOF_FS         = 40;         // nominal ToF sample rate
const DISPLAY_MPU    = DISPLAY_S * MPU_FS;   // 1000 samples
const DISPLAY_TOF    = DISPLAY_S * TOF_FS;   // 200 samples

const COL_RAW_LINE  = '#445566';
const COL_RAW_FILL  = 'rgba(68,85,102,0.12)';
const COL_FILT_MPU  = '#2980b9';
const COL_FILT_TOF  = '#2ecc71';
const COL_GRID      = 'rgba(255,255,255,0.07)';
const COL_AXIS      = 'rgba(255,255,255,0.25)';
const COL_LABEL     = 'rgba(255,255,255,0.55)';

let _rafId      = null;  // requestAnimationFrame handle
let _visible    = false; // true while data-viz screen is shown

// ── Exported entry point ──────────────────────────────────────────────────────

export function wireDataVizScreen() {
  const backBtn = document.getElementById('dv-back-btn');
  backBtn?.addEventListener('click', () => showScreen('ota'));

  // Activate/deactivate the render loop when the screen becomes visible/hidden.
  // screen-active.js calls showScreen() which toggles data-screen attributes;
  // we observe the visibility using a MutationObserver on the section element.
  const section = document.querySelector('[data-screen="data-viz"]');
  if (section) {
    new MutationObserver(() => {
      const nowVisible = section.style.display !== 'none' &&
                         !section.hidden &&
                         section.getAttribute('aria-hidden') !== 'true' &&
                         section.classList.contains('active');
      if (nowVisible && !_visible) {
        _visible = true;
        _startLoop();
      } else if (!nowVisible && _visible) {
        _visible = false;
        _stopLoop();
      }
    }).observe(section, { attributes: true });
  }
}

// ── Render loop ───────────────────────────────────────────────────────────────

function _startLoop() {
  if (_rafId !== null) return;
  const tick = () => {
    if (!_visible) { _rafId = null; return; }
    _renderAll();
    _rafId = requestAnimationFrame(tick);
  };
  _rafId = requestAnimationFrame(tick);
}

function _stopLoop() {
  if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
}

// ── Chart rendering ───────────────────────────────────────────────────────────

function _renderAll() {
  _drawMpuChart('dv-canvas-accel', _accelMag, S.rawMpuWindow, S.filtMpuWindow,
                'Accel Magnitude (g)', COL_FILT_MPU, 0.05, null);
  _drawMpuChart('dv-canvas-gyro',  _gyroMag,  S.rawMpuWindow, S.filtMpuWindow,
                'Gyro Magnitude (°/s)', COL_FILT_MPU, 1, null);
  _drawTofChart('dv-canvas-range', 'ToF Distance (mm)',
                COL_FILT_TOF, null, null, /*isRange*/true);
  _drawTofChart('dv-canvas-sr',    'ToF Signal Rate',
                COL_FILT_TOF, null, null, /*isRange*/false);
}

// ── MPU chart (accel or gyro magnitude) ──────────────────────────────────────

function _accelMag(s) {
  const a = s.accel;
  return Math.sqrt(a[0]*a[0] + a[1]*a[1] + a[2]*a[2]);
}

function _gyroMag(s) {
  const g = s.gyro;
  return Math.sqrt(g[0]*g[0] + g[1]*g[1] + g[2]*g[2]);
}

/**
 * @param {string}   canvasId
 * @param {function} valueFn   (sample) → number
 * @param {Array}    rawWin    S.rawMpuWindow
 * @param {Array}    filtWin   S.filtMpuWindow (may be empty)
 * @param {string}   title
 * @param {string}   filtColor
 * @param {number}   minYSpan  minimum Y axis span
 * @param {number|null} fixedYMax  null = auto
 */
function _drawMpuChart(canvasId, valueFn, rawWin, filtWin, title, filtColor, minYSpan, fixedYMax) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  _ensureSize(canvas);
  const { width: W, height: H } = canvas;

  // Slice last DISPLAY_MPU samples
  const raw  = rawWin.slice(-DISPLAY_MPU);
  const filt = filtWin.length > 0 ? filtWin.slice(-DISPLAY_MPU) : null;

  const rawVals  = raw.map(valueFn);
  const filtVals = filt ? filt.map(valueFn) : [];

  const allVals = [...rawVals, ...filtVals];
  const [yMin, yMax] = _autoY(allVals, minYSpan, fixedYMax);

  ctx.clearRect(0, 0, W, H);
  _drawBackground(ctx, W, H, title, yMin, yMax);

  _drawLine(ctx, rawVals,  W, H, yMin, yMax, COL_RAW_LINE, 1.5);
  if (filt) _drawLine(ctx, filtVals, W, H, yMin, yMax, filtColor, 1.5);
}

// ── ToF chart ────────────────────────────────────────────────────────────────

function _drawTofChart(canvasId, title, filtColor, _unused1, _unused2, isRange) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  _ensureSize(canvas);
  const { width: W, height: H } = canvas;

  const raw  = S.rawTofWindow.slice(-DISPLAY_TOF);
  const filt = S.filtTofWindow.length > 0 ? S.filtTofWindow.slice(-DISPLAY_TOF) : null;

  const valueFn = isRange
    ? (s) => s.isOor ? -1 : s.distance
    : (s) => s.sr;

  const rawVals  = raw.map(valueFn);
  const filtVals = filt ? filt.map(valueFn) : [];

  const allVals = [...rawVals.filter(v => v >= 0), ...filtVals.filter(v => v >= 0)];
  const [yMin, yMax] = _autoY(allVals, isRange ? 50 : 10, null, isRange ? -50 : undefined);

  ctx.clearRect(0, 0, W, H);
  _drawBackground(ctx, W, H, title, yMin, yMax);

  _drawLine(ctx, rawVals,  W, H, yMin, yMax, COL_RAW_LINE, 1.5);
  if (filt) _drawLine(ctx, filtVals, W, H, yMin, yMax, filtColor, 1.5);
}

// ── Drawing helpers ───────────────────────────────────────────────────────────

function _ensureSize(canvas) {
  const rect = canvas.getBoundingClientRect();
  if (canvas.width  !== Math.round(rect.width)  && rect.width  > 0) canvas.width  = Math.round(rect.width);
  if (canvas.height !== Math.round(rect.height) && rect.height > 0) canvas.height = Math.round(rect.height);
}

function _autoY(vals, minSpan, fixedMax, forceMin) {
  if (vals.length === 0) return [0, minSpan];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  lo = Math.floor(lo * 10) / 10;
  hi = Math.ceil(hi  * 10) / 10;
  if (forceMin !== undefined && lo > forceMin) lo = forceMin;
  if (fixedMax !== null && fixedMax !== undefined) hi = fixedMax;
  return [lo, hi];
}

function _drawBackground(ctx, W, H, title, yMin, yMax) {
  const PAD_L = 42, PAD_R = 8, PAD_T = 20, PAD_B = 24;
  const cW = W - PAD_L - PAD_R;
  const cH = H - PAD_T  - PAD_B;

  ctx.fillStyle = '#1a1f2e';
  ctx.fillRect(0, 0, W, H);

  // Title
  ctx.font = `11px sans-serif`;
  ctx.fillStyle = COL_LABEL;
  ctx.fillText(title, PAD_L + 4, PAD_T - 5);

  // Y grid + labels (5 lines)
  const steps = 4;
  ctx.strokeStyle = COL_GRID;
  ctx.lineWidth   = 0.5;
  ctx.fillStyle   = COL_LABEL;
  ctx.font        = '9px monospace';
  for (let i = 0; i <= steps; i++) {
    const y     = PAD_T + cH - (i / steps) * cH;
    const label = (yMin + (i / steps) * (yMax - yMin)).toFixed(1);
    ctx.beginPath();
    ctx.moveTo(PAD_L, y);
    ctx.lineTo(PAD_L + cW, y);
    ctx.stroke();
    ctx.fillText(label, 0, y + 3);
  }

  // Axes
  ctx.strokeStyle = COL_AXIS;
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(PAD_L, PAD_T);
  ctx.lineTo(PAD_L, PAD_T + cH);
  ctx.lineTo(PAD_L + cW, PAD_T + cH);
  ctx.stroke();

  // Store chart area on canvas for _drawLine to use
  canvas._pad = { L: PAD_L, R: PAD_R, T: PAD_T, B: PAD_B, cW, cH };

  function canvas() { return ctx.canvas; }
}

function _drawLine(ctx, vals, W, H, yMin, yMax, color, lw) {
  if (!vals || vals.length < 2) return;
  const pad = ctx.canvas._pad ?? { L: 42, R: 8, T: 20, B: 24, cW: W - 50, cH: H - 44 };
  const { L, T, cW, cH } = pad;
  const n    = vals.length;
  const ySpan = yMax - yMin;

  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth   = lw;
  ctx.lineJoin    = 'round';

  let started = false;
  for (let i = 0; i < n; i++) {
    const x = L + (i / (n - 1)) * cW;
    const v = vals[i];
    if (!isFinite(v)) { started = false; continue; }
    const y = T + cH - ((v - yMin) / ySpan) * cH;
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
