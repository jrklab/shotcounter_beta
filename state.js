'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
export const VIDEO_TIMESLICE_MS  = 200;    // chunk interval for frequent keyframes
export const VIDEO_BITRATE       = 500_000; // 500 kbps
export const SENSOR_WINDOW_SLOTS = 400;    // max samples in rolling window (~2 s)
export const EVENT_PRE_MS        = 1500;   // ms before event for review window
export const EVENT_POST_MS       = 2000;   // ms after event for review window

// ── App revision — increment here when releasing a new web app version ────────
export const APP_REVISION = 'v0.1.26';

// ── Beta detection — prefix session IDs when served from the beta app ─────────
// Checks the full URL so "beta" is matched anywhere (hostname, path, etc.).
// localhost is also treated as beta (dev/test traffic).
export const IS_BETA = (() => {
  const url = window.location.href;
  return url.includes('localhost') || url.includes('beta');
})();

// ── Shared mutable state ──────────────────────────────────────────────────────
// All screen modules import and mutate this object directly (S.foo = ...).
export const S = {
  // ── Auth ───────────────────────────────────────────────────────────────────
  user:         null,
  activeScreen: null,

  // ── Session ────────────────────────────────────────────────────────────────
  sessionId:      null,
  sessionStart:   null,   // performance.now() ms when practice starts
  sessionEnd:     null,   // performance.now() ms when practice stops
  sessionMakes:   0,
  sessionTotal:   0,

  // ── Battery (mV, read from sensor packets) ──────────────────────────────────
  battStartMv:  null,   // first non-zero battery reading of the session
  battEndMv:    null,   // most-recent battery reading  lastBattMv:   null,   // most-recent battery reading (any time, for Device Info page)
  lastTempC:    null,   // most-recent temperature reading (any time)
  // ── BLE packet loss counter ─────────────────────────────────────────────────
  totalLostPackets: 0,  // accumulated from parser.parse() lostPackets across session

  // ── Raw BLE packet log (Task 4) ─────────────────────────────────────────────
  // Each entry: { hostMs: performance.now(), buffer: ArrayBuffer (336 bytes) }
  allRawPackets: [],

  // ── Recording timestamps ────────────────────────────────────────────────────
  recordingStartGlobalMs: 0,  // Date.now() when recording started (wall clock)

  /** @type {{ shot, ai_top, ai_subtype, user_top, user_subtype,
   *            device_event_ts, host_event_ts_s, video_clip_ts,
   *            timestamp, host_ts, comment, source, event_type }[]} */
  sessionEvents:  [],
  reviewIndex:    0,

  // ── Sensor ─────────────────────────────────────────────────────────────────
  // DataViz rolling windows (always maintained while BLE connected)
  // MPU: ~10 s at 200 Hz = 2000 samples; ToF: ~10 s at 40 Hz = 400 samples
  rawMpuWindow:  [],  // [{accel:[3], gyro:[3], ts}] — raw 200 Hz stream
  rawTofWindow:  [],  // [{distance, sr, ts, isOor}] — raw 40 Hz stream
  filtMpuWindow: [],  // [{accel:[3], gyro:[3], ts}] — filtered (empty if MPU filter off)
  filtTofWindow: [],  // [{distance, sr, ts, isOor}] — filtered (empty if ToF filter off)
  allSensorData: [],  // full-session log for CSV (freed after upload)

  // ── Video ──────────────────────────────────────────────────────────────────
  mediaStream:        null,
  mediaRecorder:      null,
  allVideoChunks:     [],
  videoMimeType:      'video/webm',
  videoEnabled:       false,
  recordingStartMs:   0,
  videoSessionBlob:   null,
  videoSessionUrl:    null,
  _clipStopListener:  null,

  // ── Upload options (set on upload-options screen before upload) ────────────
  // uploadVideoMode: 'all' | 'corrected' | 'none'
  uploadVideoMode:    'corrected',
  sessionComment:     '',
  // sessionLocation: { lat: number, lng: number, label: string } | null
  sessionLocation:    null,

  // ── BLE / device ───────────────────────────────────────────────────────────
  isBleConnected: false,
  deviceHwVer:    '–',
  deviceFwVer:    '–',

  // ── Audio ──────────────────────────────────────────────────────────────────
  audioCtx:    null,
  keepAliveEl: null,

  // ── Classifier mode ────────────────────────────────────────────────────────
  // 'classic'  = threshold state-machine (fast, ~0.5–2 s)
  // 'learned'  = ONNX dual-branch CNN (~2.02 s fixed latency)
  classifierMode: 'classic',

  // ── HPF sensor filters ─────────────────────────────────────────────────────
  // Applied to raw MPU / ToF streams before the classifier pipeline.
  // When either filter is enabled, threshold defaults switch to filter-tuned values.
  filterConfig: {
    mpuEnabled: true,
    mpuFc:      1.0,   // cut-off frequency in Hz
    tofEnabled: true,
    tofFc:      1.0,   // cut-off frequency in Hz
  },

  // ── Classifier hyperparameters (advanced mode) ─────────────────────────────
  // Filter-ON defaults (since filterConfig defaults to both enabled).
  // Reset to filter-aware defaults whenever the advanced toggle is switched off
  // or filterConfig changes while advancedMode = false.
  classicParams: {
    IMPACT_ACCEL_THRESHOLD:      0.5,   // g above baseline
    TOF_DISTANCE_THRESHOLD_HIGH: 1300,  // mm
    TOF_DISTANCE_THRESHOLD_LOW:  5,     // mm
    TOF_SIGNAL_RATE_THRESHOLD:   300,
  },
  detectorParams: {
    IMPACT_ACCEL_THRESHOLD:      0.5,   // g above baseline
    TOF_DISTANCE_THRESHOLD_HIGH: 1300,  // mm
    TOF_DISTANCE_THRESHOLD_LOW:  5,     // mm
    TOF_SIGNAL_RATE_THRESHOLD:   300,
  },
  advancedMode: false,

  // ── OTA ────────────────────────────────────────────────────────────────────
  ota: null,

  // ── History chart ──────────────────────────────────────────────────────────
  historyChart: null,
};
