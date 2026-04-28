'use strict';

import { S }                       from './state.js';
import { showScreen, showToast }   from './utils.js';
import { ble, stopCamera, startPracticeSession, setParamCalibrator } from './screen-active.js';
import { initAudio }               from './utils.js';
import { ParamCalibrator }         from './param-calibrator.js';

// ── Practice setup screen ─────────────────────────────────────────────────────
export function wirePracticeSetup() {
  const bleBtn   = document.getElementById('setup-ble-btn');
  const camBtn   = document.getElementById('setup-cam-btn');
  const startBtn = document.getElementById('setup-start-btn');
  const backBtn  = document.getElementById('setup-back-btn');
  const bleState = document.getElementById('setup-ble-state');
  const camState = document.getElementById('setup-cam-state');

  backBtn?.addEventListener('click', () => {
    if (S.isBleConnected) ble.disconnect();
    stopCamera();
    showScreen('dashboard');
  });

  bleBtn?.addEventListener('click', async () => {
    initAudio();   // must happen inside a user gesture
    if (S.isBleConnected) {
      ble.disconnect();
    } else {
      bleBtn.disabled = true;
      try { await ble.connect(); } catch (_) {}
      bleBtn.disabled = false;
    }
  });

  camBtn?.addEventListener('click', async () => {
    if (S.mediaStream) {
      stopCamera();
      camState.textContent = '⛕ Not enabled';
      camState.classList.remove('ok');
      camBtn.textContent = 'Enable';
      const preview = document.getElementById('setup-cam-preview');
      if (preview) preview.style.display = 'none';
      updateReadyGate();
      return;
    }
    try {
      S.mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      S.videoEnabled = true;
      const preview = document.getElementById('setup-cam-preview');
      if (preview) { preview.srcObject = S.mediaStream; preview.style.display = 'block'; preview.play(); }
      camState.textContent = '✅ Camera ready';
      camState.classList.add('ok');
      camBtn.textContent = 'Disable';
    } catch (e) {
      S.videoEnabled = false;
      camState.textContent = `⭕ ${e.message}`;
      showToast('Camera access denied — please enable camera to continue.', 'error');
    }
    updateReadyGate();
  });

  startBtn?.addEventListener('click', startPracticeSession);

  // ── Classifier mode radio buttons ─────────────────────────────────────────
  const radios = document.querySelectorAll('input[name="classifier-mode"]');
  radios.forEach(r => {
    r.checked = r.value === S.classifierMode;
    r.addEventListener('change', () => {
      S.classifierMode = r.value;
      const noteEl = document.getElementById('classifier-latency-note');
      if (noteEl) noteEl.style.display = r.value === 'learned' ? 'block' : 'none';
      _syncParamPanels();
    });
  });

  // ── Advanced mode toggle ───────────────────────────────────────────────────
  const advToggle = document.getElementById('classifier-advanced-toggle');
  if (advToggle) {
    advToggle.checked = S.advancedMode;
    advToggle.addEventListener('change', () => {
      S.advancedMode = advToggle.checked;
      if (!S.advancedMode) {
        // Reset params to defaults
        Object.assign(S.classicParams,  { IMPACT_ACCEL_THRESHOLD: 1, TOF_DISTANCE_THRESHOLD_HIGH: 360,  TOF_DISTANCE_THRESHOLD_LOW: 60, TOF_SIGNAL_RATE_THRESHOLD: 500 });
        Object.assign(S.detectorParams, { IMPACT_ACCEL_THRESHOLD: 1, TOF_DISTANCE_THRESHOLD_HIGH: 1300, TOF_DISTANCE_THRESHOLD_LOW: 0,  TOF_SIGNAL_RATE_THRESHOLD: 500 });
      }
      _syncParamPanels();
    });
  }

  // ── Param inputs ───────────────────────────────────────────────────────────
  function _bindParam(id, obj, key) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => { obj[key] = parseFloat(el.value) || 0; });
  }
  _bindParam('p-classic-accel',    S.classicParams,  'IMPACT_ACCEL_THRESHOLD');
  _bindParam('p-classic-tof-high', S.classicParams,  'TOF_DISTANCE_THRESHOLD_HIGH');
  _bindParam('p-classic-tof-low',  S.classicParams,  'TOF_DISTANCE_THRESHOLD_LOW');
  _bindParam('p-classic-sr',       S.classicParams,  'TOF_SIGNAL_RATE_THRESHOLD');
  _bindParam('p-det-accel',        S.detectorParams, 'IMPACT_ACCEL_THRESHOLD');
  _bindParam('p-det-tof-high',     S.detectorParams, 'TOF_DISTANCE_THRESHOLD_HIGH');
  _bindParam('p-det-tof-low',      S.detectorParams, 'TOF_DISTANCE_THRESHOLD_LOW');
  _bindParam('p-det-sr',           S.detectorParams, 'TOF_SIGNAL_RATE_THRESHOLD');

  _syncParamPanels();

  // ── Calibrate button ───────────────────────────────────────────────────────
  document.getElementById('calib-start-btn')?.addEventListener('click', () => {
    if (!S.isBleConnected) { showToast('Connect BLE first.', 'error'); return; }
    _startCalibration();
  });
  _wireCalibOverlay();

  function updateReadyGate() {
    if (startBtn) startBtn.disabled = !(S.isBleConnected && S.videoEnabled);
  }
  // Exposed so BLE status changes (onBleStatus) can trigger a gate re-check
  window._updatePracticeReadyGate = updateReadyGate;
}

// ── Sync advanced panel visibility and populate inputs from state ─────────────
function _syncParamPanels() {
  const panel     = document.getElementById('classifier-advanced-panel');
  const classicEl = document.getElementById('classic-params-panel');
  const detEl     = document.getElementById('detector-params-panel');
  if (!panel) return;

  panel.style.display = S.advancedMode ? 'block' : 'none';
  if (!S.advancedMode) return;

  const isLearn = S.classifierMode === 'learned';
  if (classicEl) classicEl.style.display = isLearn ? 'none' : 'block';
  if (detEl)     detEl.style.display     = isLearn ? 'block' : 'none';

  // Populate inputs with current param values
  const cp = S.classicParams;
  const dp = S.detectorParams;
  _setInput('p-classic-accel',    cp.IMPACT_ACCEL_THRESHOLD);
  _setInput('p-classic-tof-high', cp.TOF_DISTANCE_THRESHOLD_HIGH);
  _setInput('p-classic-tof-low',  cp.TOF_DISTANCE_THRESHOLD_LOW);
  _setInput('p-classic-sr',       cp.TOF_SIGNAL_RATE_THRESHOLD);
  _setInput('p-det-accel',        dp.IMPACT_ACCEL_THRESHOLD);
  _setInput('p-det-tof-high',     dp.TOF_DISTANCE_THRESHOLD_HIGH);
  _setInput('p-det-tof-low',      dp.TOF_DISTANCE_THRESHOLD_LOW);
  _setInput('p-det-sr',           dp.TOF_SIGNAL_RATE_THRESHOLD);
}

function _setInput(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

// ── Calibration overlay ───────────────────────────────────────────────────────

let _cal = null;

function _showCalibPhase(phase) {
  ['baseline', 'shooting', 'results'].forEach(p => {
    const el = document.getElementById(`calib-phase-${p}`);
    if (el) el.style.display = p === phase ? '' : 'none';
  });
}

function _startCalibration() {
  const overlay = document.getElementById('calib-overlay');
  if (!overlay) return;

  _cal = new ParamCalibrator();
  setParamCalibrator(_cal);
  overlay.style.display = 'flex';

  _showCalibPhase('baseline');
  const blBar    = document.getElementById('calib-bl-bar');
  const tofEl    = document.getElementById('calib-tof-count');
  const warnEl   = document.getElementById('calib-tof-warn');
  const applyBtn = document.getElementById('calib-apply-btn');
  const stopBtn  = document.getElementById('calib-stop-btn');
  if (blBar)    blBar.style.width     = '0%';
  if (tofEl)    tofEl.textContent     = '0';
  if (warnEl)   warnEl.style.display  = 'none';
  if (applyBtn) applyBtn.style.display = 'none';
  if (stopBtn)  stopBtn.style.display  = 'none';

  _cal.onBaselineProgress = fraction => {
    if (blBar) blBar.style.width = `${Math.round(fraction * 100)}%`;
  };

  _cal.onShootingStart = () => {
    _showCalibPhase('shooting');
    if (tofEl)   tofEl.textContent    = '0';
    if (stopBtn) stopBtn.style.display = '';
  };

  _cal.onTofCount = count => {
    if (tofEl) tofEl.textContent = count;
  };

  _cal.onComplete = (suggestions, stats) => {
    _showCalibPhase('results');
    if (stopBtn) stopBtn.style.display = 'none';
    if (stats.lowTofWarning && warnEl) {
      warnEl.textContent = `Only ${stats.tofSampleCount} ball reading(s) collected (recommended ≥ ${_cal.MIN_TOF_READINGS}). ToF thresholds may be less accurate.`;
      warnEl.style.display = '';
    }
    _renderCalibResults(suggestions, stats);
    if (applyBtn) {
      applyBtn.style.display = '';
      applyBtn._suggestions  = suggestions;
    }
  };

  _cal.start();
}

function _renderCalibResults(suggestions, stats) {
  const grid = document.getElementById('calib-results-grid');
  const note = document.getElementById('calib-stats-note');
  if (!grid) return;

  const currentParams = S.classifierMode === 'learned' ? S.detectorParams : S.classicParams;
  const rows = [
    ['Accel threshold (g)',  'IMPACT_ACCEL_THRESHOLD',      suggestions.IMPACT_ACCEL_THRESHOLD],
    ['Range high (mm)',      'TOF_DISTANCE_THRESHOLD_HIGH', suggestions.TOF_DISTANCE_THRESHOLD_HIGH],
    ['Range low (mm)',       'TOF_DISTANCE_THRESHOLD_LOW',  suggestions.TOF_DISTANCE_THRESHOLD_LOW],
    ['Signal rate',          'TOF_SIGNAL_RATE_THRESHOLD',   suggestions.TOF_SIGNAL_RATE_THRESHOLD],
  ];

  grid.innerHTML = rows.map(([label, key, suggested]) => `
    <span class="param-label">${label}</span>
    <span class="calib-current">${currentParams[key]}</span>
    <span class="calib-arrow">→</span>
    <span class="calib-suggested">${suggested}</span>
  `).join('');

  const rawEl = document.getElementById('calib-raw-stats');
  if (rawEl) {
    const na = '—';
    const fmt = v => v !== null ? v : na;
    const blNote = stats.tofBaselineDist ? ` (baseline ${stats.tofBaselineDist} mm)` : '';
    rawEl.innerHTML = [
      `<span class="calib-stat-label">Max accel (g)</span><span class="calib-stat-value">${fmt(stats.maxAccel)}</span>`,
      `<span class="calib-stat-label">Max range (mm)</span><span class="calib-stat-value">${fmt(stats.maxTof)}</span>`,
      `<span class="calib-stat-label">Min range (mm)</span><span class="calib-stat-value">${fmt(stats.minTof)}</span>`,
      `<span class="calib-stat-label">Max signal rate</span><span class="calib-stat-value">${fmt(stats.maxSR)}</span>`,
      `<span class="calib-stat-label">Min signal rate</span><span class="calib-stat-value">${fmt(stats.minSR)}</span>`,
    ].join('');
  }

  if (note) {
    const blNote  = stats.tofBaselineDist ? ` · baseline ${stats.tofBaselineDist} mm` : '';
    const accNote = stats.accelSampleCount ? ` · ${stats.accelSampleCount} accel samples` : '';
    note.textContent = `${stats.tofSampleCount} ball reading(s)${accNote}${blNote}`;
  }
}

function _closeCalibOverlay() {
  setParamCalibrator(null);
  _cal?.cancel();
  _cal = null;
  const overlay = document.getElementById('calib-overlay');
  if (overlay) overlay.style.display = 'none';
}

// Wire static overlay buttons (called once from wirePracticeSetup)
function _wireCalibOverlay() {
  document.getElementById('calib-cancel-btn')?.addEventListener('click', _closeCalibOverlay);

  document.getElementById('calib-stop-btn')?.addEventListener('click', () => {
    if (!_cal) return;
    _cal.stop();
  });

  document.getElementById('calib-apply-btn')?.addEventListener('click', () => {
    const btn = document.getElementById('calib-apply-btn');
    const suggestions = btn?._suggestions;
    if (!suggestions) return;
    // Apply to both param objects — same physical measurements benefit both classifiers
    Object.assign(S.classicParams,  suggestions);
    Object.assign(S.detectorParams, suggestions);
    _syncParamPanels();
    _closeCalibOverlay();
    showToast('Calibrated parameters applied.', 'info');
  });
}

export function resetPracticeSetup() {
  const bleState = document.getElementById('setup-ble-state');
  const camState = document.getElementById('setup-cam-state');
  if (bleState) { bleState.textContent = S.isBleConnected ? '✅ Connected' : '⭕ Not connected'; bleState.classList.toggle('ok', S.isBleConnected); }
  if (camState) { camState.textContent = S.mediaStream    ? '✅ Camera ready' : '⭕ Not enabled';  camState.classList.toggle('ok', !!S.mediaStream); }
  const camBtn   = document.getElementById('setup-cam-btn');
  if (camBtn) camBtn.textContent = S.mediaStream ? 'Disable' : 'Enable';
  const startBtn = document.getElementById('setup-start-btn');
  if (startBtn) startBtn.disabled = !(S.isBleConnected && S.videoEnabled);
}
