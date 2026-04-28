'use strict';

import { S }                       from './state.js';
import { showScreen, showToast }   from './utils.js';
import { ble, stopCamera, startPracticeSession } from './screen-active.js';
import { initAudio }               from './utils.js';

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
