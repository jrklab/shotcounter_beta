'use strict';

import { S }                       from './state.js';
import { showScreen, showToast }   from './utils.js';
import { ble, stopCamera, startPracticeSession } from './screen-active.js';
import { initAudio }               from './utils.js';

// ── Practice setup screen ─────────────────────────────────────────────────────
export function wirePracticeSetup() {
  const bleBtn       = document.getElementById('setup-ble-btn');
  const camBtn       = document.getElementById('setup-cam-btn');
  const startBtn     = document.getElementById('setup-start-btn');
  const backBtn      = document.getElementById('setup-back-btn');
  const bleState     = document.getElementById('setup-ble-state');
  const camState     = document.getElementById('setup-cam-state');
  const uploadToggle = document.getElementById('setup-upload-video-toggle');

  if (uploadToggle) {
    uploadToggle.checked = S.uploadVideoEnabled;
    uploadToggle.addEventListener('change', () => { S.uploadVideoEnabled = uploadToggle.checked; });
  }

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

  function updateReadyGate() {
    if (startBtn) startBtn.disabled = !(S.isBleConnected && S.videoEnabled);
  }
  // Exposed so BLE status changes (onBleStatus) can trigger a gate re-check
  window._updatePracticeReadyGate = updateReadyGate;

  // Exposed so onBleStatus can refresh the device-info panel after BLE connects
  window._updateDeviceMetaDisplay = function () {
    const panel = document.getElementById('setup-device-meta');
    const text  = document.getElementById('setup-meta-text');
    const meta  = window.deviceMeta;
    if (!panel || !text) return;
    if (!meta) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = '';
    // Build a compact multi-line summary — omit empty values
    const lines = [
      meta.manufacturer && `Manufacturer:  ${meta.manufacturer}`,
      meta.model        && `Model:         ${meta.model}`,
      meta.hwRevision   && `HW Revision:   ${meta.hwRevision}`,
      meta.fwRevision   && `FW Revision:   ${meta.fwRevision}`,
      meta.systemId     && `MAC:           ${meta.systemId}`,
    ].filter(Boolean);
    text.textContent = lines.join('\n');
  };
}

export function resetPracticeSetup() {
  const bleState = document.getElementById('setup-ble-state');
  const camState = document.getElementById('setup-cam-state');
  if (bleState) { bleState.textContent = S.isBleConnected ? '✅ Connected' : '⭕ Not connected'; bleState.classList.toggle('ok', S.isBleConnected); }
  if (camState) { camState.textContent = S.mediaStream    ? '✅ Camera ready' : '⭕ Not enabled';  camState.classList.toggle('ok', !!S.mediaStream); }
  const camBtn   = document.getElementById('setup-cam-btn');
  if (camBtn) camBtn.textContent = S.mediaStream ? 'Disable' : 'Enable';
  const uploadToggle = document.getElementById('setup-upload-video-toggle');
  if (uploadToggle) uploadToggle.checked = S.uploadVideoEnabled;
  const startBtn = document.getElementById('setup-start-btn');
  if (startBtn) startBtn.disabled = !(S.isBleConnected && S.videoEnabled);
}
