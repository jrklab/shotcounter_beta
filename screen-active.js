'use strict';

import { BLEReceiver }                from './ble.js';
import { PacketParser }               from './parser.js';
import { MpuHighPassFilter, TofHighPassFilter } from './sensor_filter.js';
import { BaselineCalibrator, ThresholdConfig,
         ClassicClassifier }          from './rule-classifier.js';
import { SceneDetector, DetectorConfig } from './detector.js';
import { LearnedClassifier }          from './cnn-classifier.js';
import { storeSessionVideo }          from './video-store.js';
import { S, VIDEO_TIMESLICE_MS, VIDEO_BITRATE,
         IS_BETA }                    from './state.js';
import { showScreen, setEl, showToast, speak, initAudio } from './utils.js';
import { showReviewScreen }           from './screen-review.js';

// ── Module-level instances ────────────────────────────────────────────────────
let parser      = new PacketParser();
let calibrator  = new BaselineCalibrator();
let detector    = new SceneDetector(calibrator);
let classicCls  = new ClassicClassifier(calibrator);
let learnedCls  = null;   // LearnedClassifier — created lazily on first use

// ── HPF filter instances (null = disabled) ────────────────────────────────────
let _mpuFilter = null;
let _tofFilter = null;

/** (Re-)create filter instances from S.filterConfig. Called on BLE connect and session start. */
function _resetFilters() {
  const cfg = S.filterConfig;
  _mpuFilter = cfg.mpuEnabled ? new MpuHighPassFilter(cfg.mpuFc) : null;
  _tofFilter = cfg.tofEnabled ? new TofHighPassFilter(cfg.tofFc) : null;
}
/** Exported so screen-setup.js can trigger a filter reset when config changes. */
export function resetFilters() { _resetFilters(); }

// Kept current in onBlePacket so handleScene can reference it
let latestDeviceTs_ms = 0;

// BLE receiver — callbacks defined below so they reference the latest parser/classifier
export const ble = new BLEReceiver(onBlePacket, onBleStatus);

// ── Param calibrator tap ──────────────────────────────────────────────────────
// Set by screen-setup.js when a calibration is running; cleared when done/cancelled.
let _activeParamCal = null;
export function setParamCalibrator(cal) { _activeParamCal = cal; }

// ── Build classifier / detector configs from S.*Params ───────────────────────
function buildClassicConfig() {
  const cfg = new ThresholdConfig();
  Object.assign(cfg, S.classicParams);
  return cfg;
}
function buildDetectorConfig() {
  const cfg = new DetectorConfig();
  // In classic mode the detector and classifier share the same thresholds so
  // the detector never fires on events the classifier would reject as NOT_SHOT.
  // In learned mode the detector uses its own wider gates (detectorParams).
  Object.assign(cfg, S.classifierMode === 'classic' ? S.classicParams : S.detectorParams);
  return cfg;
}

// ── Wire buttons ──────────────────────────────────────────────────────────────
export function wirePracticeActive() {
  document.getElementById('active-stop-btn')?.addEventListener('click', stopPracticeSession);
  document.getElementById('active-restart-btn')?.addEventListener('click', restartPracticeSession);
}

// ── Session lifecycle ─────────────────────────────────────────────────────────
export function startPracticeSession() {
  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 15);
  S.sessionId        = IS_BETA ? `beta_${ts}` : ts;
  S.sessionStart     = performance.now();
  S.sessionEnd       = null;
  S.sessionMakes     = 0;
  S.sessionTotal     = 0;
  S.sessionEvents    = [];
  S.rawMpuWindow     = [];
  S.rawTofWindow     = [];
  S.filtMpuWindow    = [];
  S.filtTofWindow    = [];
  S.allSensorData    = [];
  S.allRawPackets    = [];
  S.battStartMv      = null;
  S.battEndMv        = null;
  S.totalLostPackets = 0;
  S.recordingStartGlobalMs = 0;
  S.allVideoChunks   = [];
  S.videoSessionBlob = null;
  if (S.videoSessionUrl) { URL.revokeObjectURL(S.videoSessionUrl); S.videoSessionUrl = null; }

  calibrator = new BaselineCalibrator();
  classicCls = new ClassicClassifier(calibrator, buildClassicConfig());
  detector   = new SceneDetector(calibrator, buildDetectorConfig());
  detector.onScene = handleScene;
  latestDeviceTs_ms = 0;
  if (S.classifierMode === 'learned') {
    if (!learnedCls) learnedCls = new LearnedClassifier(calibrator);
    else learnedCls._cal = calibrator;   // update after session calibrator refresh
    learnedCls.load();   // pre-warm ONNX model
  }
  parser.reset();
  _resetFilters();

  showScreen('practice-active');

  const videoEl = document.getElementById('active-video');
  if (videoEl && S.mediaStream) { videoEl.srcObject = S.mediaStream; videoEl.play(); }
  else if (videoEl)               { videoEl.style.display = 'none'; }

  if (S.mediaStream && S.videoEnabled) startVideoRecording();

  updateActiveScoreboard();
  setActiveEvent('calibrating baseline…', '#f39c12');
  showCalibrationBar(true);
}

export function stopPracticeSession() {
  S.sessionEnd = performance.now();
  if (S.isBleConnected) ble.disconnect();

  if (S.sessionEvents.length === 0) {
    stopCamera();
    showToast('Session ended with no detected shots.', 'info');
    showScreen('dashboard');
    return;
  }

  setActiveEvent('Saving session video…', '#f39c12');

  const finalizeAndReview = async () => {
    stopCamera();
    if (S.allVideoChunks.length > 0) {
      S.videoSessionBlob = new Blob(S.allVideoChunks.map(c => c.data),
                                    { type: S.videoMimeType || 'video/webm' });
      try { await storeSessionVideo(S.sessionId, S.videoSessionBlob); } catch (e) {
        console.warn('IndexedDB store failed — video lives in RAM only:', e);
      }
    }
    S.reviewIndex = 0;
    await showReviewScreen();
  };

  if (S.mediaRecorder && S.mediaRecorder.state !== 'inactive') {
    S.mediaRecorder.addEventListener('stop', finalizeAndReview, { once: true });
    S.mediaRecorder.stop();
    S.mediaRecorder = null;
  } else {
    S.mediaRecorder = null;
    finalizeAndReview();
  }
}

export function restartPracticeSession() {
  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 15);
  S.sessionId        = IS_BETA ? `beta_${ts}` : ts;
  S.sessionStart     = performance.now();
  S.sessionEnd       = null;
  S.sessionMakes     = 0;
  S.sessionTotal     = 0;
  S.sessionEvents    = [];
  S.rawMpuWindow     = [];
  S.rawTofWindow     = [];
  S.filtMpuWindow    = [];
  S.filtTofWindow    = [];
  S.allSensorData    = [];
  S.allRawPackets    = [];
  S.battStartMv      = null;
  S.battEndMv        = null;
  S.totalLostPackets = 0;
  S.recordingStartGlobalMs = 0;
  S.allVideoChunks   = [];
  S.videoSessionBlob = null;
  if (S.videoSessionUrl) { URL.revokeObjectURL(S.videoSessionUrl); S.videoSessionUrl = null; }

  calibrator = new BaselineCalibrator();
  classicCls = new ClassicClassifier(calibrator, buildClassicConfig());
  detector   = new SceneDetector(calibrator, buildDetectorConfig());
  detector.onScene = handleScene;
  latestDeviceTs_ms = 0;
  if (S.classifierMode === 'learned') {
    if (!learnedCls) learnedCls = new LearnedClassifier(calibrator);
    else learnedCls._cal = calibrator;   // update after session calibrator refresh
    learnedCls.load();
  }
  parser.reset();
  _resetFilters();

  if (S.mediaRecorder && S.mediaRecorder.state !== 'inactive') {
    try { S.mediaRecorder.stop(); } catch (_) {}
    S.mediaRecorder = null;
  }
  S.recordingStartMs = 0;
  if (S.mediaStream && S.videoEnabled) startVideoRecording();

  updateActiveScoreboard();
  setActiveEvent('calibrating baseline…', '#f39c12');
  showCalibrationBar(true);
}

// ── Scoreboard helpers ────────────────────────────────────────────────────────
function updateActiveScoreboard() {
  setEl('active-makes', S.sessionMakes);
  setEl('active-total', S.sessionTotal);
  setEl('active-pct', S.sessionTotal
    ? `${Math.round(S.sessionMakes / S.sessionTotal * 100)}%` : '—%');
}

function setActiveEvent(text, color = '#ccc') {
  const el = document.getElementById('active-event');
  if (el) { el.textContent = text; el.style.color = color; }
}

function showCalibrationBar(show) {
  document.getElementById('active-cal-wrap')?.classList.toggle('visible', show);
}

function updateCalBar(pct) {
  const bar = document.getElementById('active-cal-bar');
  if (bar) bar.style.width = `${Math.round(pct * 100)}%`;
}

// ── Video recording ───────────────────────────────────────────────────────────
function startVideoRecording() {
  const mimeOptions = [
    'video/webm;codecs=vp8',
    'video/webm;codecs=vp9',
    'video/webm',
    'video/mp4',
  ];
  S.videoMimeType  = mimeOptions.find(m => MediaRecorder.isTypeSupported(m)) ?? '';
  S.allVideoChunks = [];
  S.recordingStartMs     = performance.now();
  S.recordingStartGlobalMs = Date.now();   // wall-clock reference for Firestore

  try {
    S.mediaRecorder = new MediaRecorder(S.mediaStream, {
      mimeType: S.videoMimeType,
      videoBitsPerSecond: VIDEO_BITRATE,
    });
    S.mediaRecorder.addEventListener('dataavailable', evt => {
      if (evt.data.size > 0) {
        const startMs = S.allVideoChunks.length * VIDEO_TIMESLICE_MS;
        S.allVideoChunks.push({ data: evt.data, startMs });
      }
    });
    S.mediaRecorder.start(VIDEO_TIMESLICE_MS);
  } catch (e) {
    console.warn('MediaRecorder failed:', e);
    S.videoEnabled = false;
  }
}

export function stopCamera() {
  if (S.mediaRecorder && S.mediaRecorder.state !== 'inactive') S.mediaRecorder.stop();
  S.mediaRecorder = null;
  if (S.mediaStream) {
    S.mediaStream.getTracks().forEach(t => t.stop());
    S.mediaStream  = null;
    S.videoEnabled = false;
  }
}

// ── BLE packet handler ────────────────────────────────────────────────────────
function onBlePacket(dataView) {
  const hostMs = performance.now();

  // ── Task 4: accumulate raw packets for .bin upload ───────────────────────────
  if (S.activeScreen === 'practice-active') {
    const buffer = dataView.buffer.slice(dataView.byteOffset,
                                         dataView.byteOffset + dataView.byteLength);
    S.allRawPackets.push({ hostMs, buffer });
  }

  const { mpuBatch, tofBatch, lostPackets, deviceInfo } = parser.parse(dataView);

  // ── Packet loss tracking ────────────────────────────────────────────────────
  if (lostPackets > 0) {
    S.totalLostPackets += lostPackets;
    console.warn(`Packet loss: ${lostPackets} (total: ${S.totalLostPackets})`);
  }

  if (deviceInfo) {
    // ── Battery tracking ─────────────────────────────────────────────────────
    if (deviceInfo.battMv > 0) {
      if (!S.battStartMv) S.battStartMv = deviceInfo.battMv;
      S.battEndMv   = deviceInfo.battMv;
      S.lastBattMv  = deviceInfo.battMv;
    }
    if (deviceInfo.tempC != null) S.lastTempC = deviceInfo.tempC;
    S.deviceHwVer = window.deviceMeta?.hwRevision ?? '–';
    S.deviceFwVer = window.deviceMeta?.fwRevision ?? '–';
    updateDeviceInfoBar(deviceInfo);
  }

  if (!mpuBatch) return;

  // ── Apply HPF filters ───────────────────────────────────────────────────────
  const filtMpu = _mpuFilter ? _mpuFilter.process(mpuBatch) : mpuBatch;
  const filtTof = _tofFilter ? _tofFilter.process(tofBatch) : tofBatch;

  // ── Maintain DataViz rolling windows (always, not just during practice) ─────
  const RAW_MPU_MAX  = 2000;
  const RAW_TOF_MAX  = 400;
  S.rawMpuWindow.push(...mpuBatch);
  if (S.rawMpuWindow.length > RAW_MPU_MAX)
    S.rawMpuWindow.splice(0, S.rawMpuWindow.length - RAW_MPU_MAX);
  S.rawTofWindow.push(...tofBatch);
  if (S.rawTofWindow.length > RAW_TOF_MAX)
    S.rawTofWindow.splice(0, S.rawTofWindow.length - RAW_TOF_MAX);
  if (_mpuFilter) {
    S.filtMpuWindow.push(...filtMpu);
    if (S.filtMpuWindow.length > RAW_MPU_MAX)
      S.filtMpuWindow.splice(0, S.filtMpuWindow.length - RAW_MPU_MAX);
  } else {
    S.filtMpuWindow.length = 0;
  }
  if (_tofFilter) {
    S.filtTofWindow.push(...filtTof);
    if (S.filtTofWindow.length > RAW_TOF_MAX)
      S.filtTofWindow.splice(0, S.filtTofWindow.length - RAW_TOF_MAX);
  } else {
    S.filtTofWindow.length = 0;
  }

  // ── Route to param calibrator when active ──────────────────────────────────
  if (_activeParamCal) {
    _activeParamCal.pushBatch(filtMpu, filtTof);
  }

  if (S.activeScreen !== 'practice-active') return;

  latestDeviceTs_ms = mpuBatch[mpuBatch.length - 1].ts;
  S.allSensorData.push(...mpuBatch);

  for (const s of filtMpu) {
    if (!calibrator.isComplete) {
      const done = calibrator.addMpu(s.accel, s.gyro, s.ts);
      updateCalBar(calibrator.progress);
      if (done) {
        showCalibrationBar(false);
        setActiveEvent('baseline ready — detecting shots 🏀', '#2ecc71');
      }
    }
  }
  for (const s of filtTof) {
    calibrator.addTof(s.distance, s.sr);
  }
  // detector.pushBatch() is a no-op until calibration is complete (guarded internally)
  detector.pushBatch(filtMpu, filtTof);
}

// ── Scene handler (fired by SceneDetector.onScene) ───────────────────────────
async function handleScene(scene) {
  if (S.activeScreen !== 'practice-active') return;

  const hostNow = performance.now();

  // Choose classifier
  let result;
  const useLearn = S.classifierMode === 'learned' && learnedCls?.isReady;
  if (useLearn) {
    result = await learnedCls.classify(scene);
  } else {
    result = classicCls.classify(scene);
  }
  console.log(`[classifier:${useLearn ? 'cnn' : 'classic'}]`, result.classification,
              `(${(result.confidence * 100).toFixed(0)}%)`);

  if (result.classification === 'NOT_SHOT') {
    // Add to session events for user review; do not count in totals
    const eventTs = scene.trigger_ts;
    const deviceLag_ms = Math.max(0, latestDeviceTs_ms - eventTs * 1000);
    S.sessionEvents.push({
      shot:            result,
      ai_top:          'Not-a-shot',
      ai_subtype:      null,
      user_top:        'Not-a-shot',
      user_subtype:    null,
      device_event_ts: eventTs,
      host_event_ts_s: (hostNow - deviceLag_ms) / 1000,
      video_clip_ts:   (hostNow - S.recordingStartMs - deviceLag_ms) / 1000,
      event_type:      'nas',
      timestamp:       Date.now(),
      host_ts:         hostNow,
      hostEventTs:     hostNow - S.recordingStartMs - deviceLag_ms,
      comment:         '',
    });
    return;
  }

  onShotDetected(result, hostNow, latestDeviceTs_ms);
}

function onShotDetected(shot, hostNow = performance.now(), latestDeviceTs_ms = null) {
  const isMake    = shot.classification === 'MAKE';
  const type      = shot.basket_type ?? '';
  const subtypeMap = { SWISH: 'Swish', BANK: 'Rim-in' };
  const aiTop     = isMake ? 'Make' : (shot.classification === 'MISS' ? 'Miss' : 'Not-a-shot');
  const aiSubtype = isMake ? (subtypeMap[type] ?? null) : null;

  if (isMake) S.sessionMakes++;
  S.sessionTotal++;
  updateActiveScoreboard();

  const eventDeviceTs_ms = (shot.basket_time ?? shot.impact_time ?? 0) * 1000;
  const deviceLag_ms     = latestDeviceTs_ms !== null
    ? Math.max(0, latestDeviceTs_ms - eventDeviceTs_ms) : 0;
  const hostEventTs   = (hostNow - S.recordingStartMs) - deviceLag_ms;
  const video_clip_ts = hostEventTs / 1000.0;
  // host_event_ts_s: absolute performance.now()-based host time of event, in seconds
  const host_event_ts_s = (hostNow - deviceLag_ms) / 1000.0;
  // device_event_ts: device-side sensor timestamp of the event, in seconds
  const device_event_ts = shot.basket_time ?? shot.impact_time ?? 0;
  const event_type = aiTop === 'Make' ? 'basket' : 'impact';

  S.sessionEvents.push({
    shot,
    ai_top:         aiTop,
    ai_subtype:     aiSubtype,
    user_top:       aiTop,
    user_subtype:   aiSubtype,
    device_event_ts,
    host_event_ts_s,
    video_clip_ts,
    event_type,
    timestamp:      Date.now(),
    host_ts:        hostNow,
    hostEventTs,
    comment:        '',
  });

  const scoreText = `${S.sessionMakes} out of ${S.sessionTotal}`;
  if (isMake) {
    setActiveEvent(aiSubtype ? `🏀 ${aiSubtype}!` : '🏀 Make!', '#2ecc71');
    speak(`${aiSubtype ?? 'Make'}, ${scoreText}`);
  } else {
    setActiveEvent('❌ Miss', '#e74c3c');
    speak(`Miss, ${scoreText}`);
  }
}

function onBleStatus(state, detail) {
  S.isBleConnected = state === 'connected';

  // Reset the packet parser on every fresh BLE connection so that stale
  // sequence numbers and a partially-filled _pending buffer from a previous
  // session (or a device reboot) never block the next calibration run.
  if (state === 'connected') { parser.reset(); _resetFilters(); }

  const bleState = document.getElementById('setup-ble-state');
  const bleBtn   = document.getElementById('setup-ble-btn');
  if (bleState) {
    bleState.textContent = S.isBleConnected ? '✅ Connected' : '⛕ Not connected';
    bleState.classList.toggle('ok', S.isBleConnected);
  }
  if (bleBtn) bleBtn.textContent = S.isBleConnected ? 'Disconnect' : 'Connect';

  const statusEl = document.getElementById('global-ble-status');
  if (statusEl) {
    statusEl.textContent = S.isBleConnected ? 'BLE ●' : 'BLE ○';
    statusEl.style.color = S.isBleConnected ? '#2ecc71' : '#555566';
  }

  if (typeof window._updatePracticeReadyGate === 'function') {
    window._updatePracticeReadyGate();
  }
  if (typeof window._updateOtaBleStatus === 'function') {
    window._updateOtaBleStatus();
  }
}

function updateDeviceInfoBar(info) {
  // hw/fw revision is now served via BLE DIS (window.deviceMeta); packet bytes 4-5 are RSVD zeros
  const hw   = window.deviceMeta?.hwRevision  ?? '–';
  const fw   = window.deviceMeta?.fwRevision  ?? '–';
  setEl('di-hw',   hw);
  setEl('di-fw',   fw);
  setEl('di-batt', info.battMv ? `${(info.battMv / 1000).toFixed(2)} V` : '–');
  setEl('di-temp', `${info.tempC}°C`);  // Refresh Device Info page live readings if it is currently open
  if (typeof window._updateOtaReadings === 'function') window._updateOtaReadings();}
