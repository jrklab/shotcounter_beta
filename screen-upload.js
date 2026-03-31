'use strict';

import { saveShot, saveSession,
         uploadSensorBin, uploadSessionJson,
         uploadClip }                               from './db.js';
import { S, APP_REVISION }                          from './state.js';
import { showScreen, setEl }                        from './utils.js';
import { Timestamp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';

// ── Extract a single shot clip from recorded video chunks ────────────────────
// Re-records from the full session blob using captureStream() so that:
//   • The clip always starts on a keyframe (browser seek guarantees this).
//   • Timestamps in the output start from 0, not the original recording offset.
// Uses a 1 s pre-window + 2 s post-window around video_clip_ts.
const CLIP_PRE_MS  = 1000;
const CLIP_POST_MS = 2000;

async function extractShotClip(ev, fullBlob) {
  if (!fullBlob || ev.video_clip_ts == null) return null;

  const clipStartSec = Math.max(0, ev.video_clip_ts - CLIP_PRE_MS / 1000);
  const clipDurMs    = CLIP_PRE_MS + CLIP_POST_MS;
  const mimeType     = S.videoMimeType || 'video/webm';

  return new Promise(resolve => {
    const url = URL.createObjectURL(fullBlob);
    const vid = document.createElement('video');
    vid.src              = url;
    vid.muted            = true;
    vid.style.cssText    = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px';
    document.body.appendChild(vid);

    const cleanup = () => { URL.revokeObjectURL(url); vid.remove(); };
    vid.onerror = () => { cleanup(); resolve(null); };

    vid.addEventListener('seeked', () => {
      const captureFn = vid.captureStream ?? vid.mozCaptureStream;
      if (!captureFn) { cleanup(); resolve(null); return; }

      const stream   = captureFn.call(vid);
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks   = [];

      recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        cleanup();
        resolve(chunks.length ? new Blob(chunks, { type: mimeType }) : null);
      };

      recorder.start(200);
      vid.play().then(() => {
        setTimeout(() => { vid.pause(); recorder.stop(); }, clipDurMs + 300);
      }).catch(() => { cleanup(); resolve(null); });
    }, { once: true });

    vid.addEventListener('loadedmetadata', () => {
      vid.currentTime = clipStartSec;
    }, { once: true });

    vid.load();
  });
}

// ── Upload orchestrator ──────────────────────────────────────────────────────────────
export async function startUpload() {
  showScreen('practice-upload');
  const uid = S.user?.uid;
  if (!uid) { showScreen('dashboard'); return; }

  // Determine which events will have clips uploaded
  const eventsForClip = (() => {
    if (S.uploadVideoMode === 'none' || !S.allVideoChunks.length) return [];
    if (S.uploadVideoMode === 'corrected') {
      return S.sessionEvents.filter(
        ev => ev.user_top !== ev.ai_top || ev.user_subtype !== ev.ai_subtype
      );
    }
    return S.sessionEvents;  // 'all'
  })();

  // Steps: 1 sensor.bin + 1 labels JSON + N shots + M clips
  const videoSteps = eventsForClip.length;
  const totalSteps = 2 + S.sessionEvents.length + videoSteps;
  let   doneSteps  = 0;
  const shotIds    = [];
  // map of sessionEvents index → clip download URL
  const clipUrls   = new Map();

  const progressEl = document.getElementById('upload-progress');
  const statusEl   = document.getElementById('upload-status');
  const setStatus  = msg => { if (statusEl) statusEl.textContent = msg; };
  const updateBar  = ()  => {
    if (progressEl) progressEl.style.width = `${Math.round(doneSteps / totalSteps * 100)}%`;
  };

  setStatus('Generating session data…');

  // ── Compute session stats ─────────────────────────────────────────────────
  const userMakes = S.sessionEvents.filter(e => e.user_top === 'Make').length;
  const userTotal = S.sessionEvents.filter(e => e.user_top !== 'Not-a-shot').length;
  const aiMakes   = S.sessionEvents.filter(e => e.ai_top  === 'Make').length;
  const aiTotal   = S.sessionEvents.filter(e => e.ai_top  !== 'Not-a-shot').length;
  const durSec    = Math.round(((S.sessionEnd ?? performance.now()) - S.sessionStart) / 1000);

  // ── 1. Upload raw sensor binary ──────────────────────────────────────────
  const lossPct = S.totalLostPackets > 0
    ? parseFloat((S.totalLostPackets / (S.allRawPackets.length + S.totalLostPackets) * 100).toFixed(2))
    : 0;
  let sensorDataUrl = null;
  try {
    setStatus('Uploading sensor data…');
    const binBlob = generateSensorBin();
    sensorDataUrl = await uploadSensorBin(uid, S.sessionId, binBlob);
  } catch (e) { console.warn('Sensor bin upload failed:', e); }
  doneSteps++; updateBar();

  // ── 2. Upload session labels JSON ─────────────────────────────────────────
  try {
    setStatus('Uploading session labels JSON…');
    await uploadSessionJson(uid, S.sessionId, generateSessionJson());
  } catch (e) { console.warn('Labels JSON upload failed:', e); }
  doneSteps++; updateBar();

  // ── 3. Upload per-shot video clips ────────────────────────────────────────
  // Assemble full session blob (needed for seek-based clip extraction)
  const fullVideoBlob = eventsForClip.length
    ? (S.videoSessionBlob ?? (S.allVideoChunks.length
        ? new Blob(S.allVideoChunks.map(c => c.data), { type: S.videoMimeType || 'video/webm' })
        : null))
    : null;

  for (let i = 0; i < eventsForClip.length; i++) {
    const ev        = eventsForClip[i];
    const globalIdx = S.sessionEvents.indexOf(ev);
    try {
      setStatus(`Extracting & uploading clip ${i + 1} / ${eventsForClip.length}…`);
      const blob = await extractShotClip(ev, fullVideoBlob);
      if (blob) {
        const url = await uploadClip(uid, S.sessionId, globalIdx, blob, S.videoMimeType);
        clipUrls.set(globalIdx, url);
      }
    } catch (e) {
      console.warn('Clip upload failed:', e);
    }
    doneSteps++; updateBar();
  }

  // ── 4. Save shot documents ────────────────────────────────────────────────
  for (let i = 0; i < S.sessionEvents.length; i++) {
    const ev = S.sessionEvents[i];
    const source = (ev.user_top === ev.ai_top && ev.user_subtype === ev.ai_subtype)
      ? 'auto' : 'manual';
    try {
      setStatus(`Saving shot ${i + 1} / ${S.sessionEvents.length}…`);
      const id = await saveShot({
        userId:          uid,
        sessionId:       S.sessionId,
        createdAt:       Timestamp.now(),
        ai_top:          ev.ai_top,
        ai_subtype:      ev.ai_subtype,
        confidence:      ev.shot.confidence ?? 0,
        user_top:        ev.user_top,
        user_subtype:    ev.user_subtype,
        comment:         ev.comment ?? '',
        source,
        event_type:      ev.event_type,
        device_event_ts: ev.device_event_ts,
        host_event_ts:   ev.host_event_ts_s,
        video_clip_ts:   ev.video_clip_ts ?? null,
        video_clip_url:  clipUrls.get(i) ?? null,
      });
      shotIds.push(id);
    } catch (e) { console.warn('Shot save failed:', e); }
    doneSteps++; updateBar();
  }

  // ── 5. Save session document to Firestore ──────────────────────────────────
  try {
    await saveSession(uid, S.sessionId, {
      userId:    uid,
      sessionId: S.sessionId,
      Device_Meta: {
        Manufacturer_Name: window.deviceMeta?.manufacturer ?? '',
        Model_Number:      window.deviceMeta?.model        ?? '',
        Hardware_Revision: window.deviceMeta?.hwRevision   ?? '',
        Firmware_Revision: window.deviceMeta?.fwRevision   ?? '',
        'System_ID (MAC)': window.deviceMeta?.systemId     ?? '',
        Battery_Start_mV:  S.battStartMv ?? 0,
        Battery_End_mV:    S.battEndMv   ?? 0,
      },
      Client_Meta: {
        App_Revision:        APP_REVISION,
        User_Agent:          navigator.userAgent,
        BLE_Packet_Loss_Pct: lossPct,
      },
      Practice_Meta: {
        ai_accuracy:   aiTotal  > 0 ? parseFloat((aiMakes  / aiTotal  * 100).toFixed(1)) : 0,
        ai_makes:      aiMakes,
        ai_total:      aiTotal,
        user_accuracy: userTotal > 0 ? parseFloat((userMakes / userTotal * 100).toFixed(1)) : 0,
        user_makes:    userMakes,
        user_total:    userTotal,
        createdAt:     Timestamp.now(),
        durationSec:   durSec,
        comment:       S.sessionComment ?? '',
        location:      S.sessionLocation ?? null,
        classifier:    S.classifierMode ?? 'classic',
      },
      createdAt:                 Timestamp.now(),
      sensor_data_url:           sensorDataUrl,
      recording_start_global_ms: S.recordingStartGlobalMs,
      recording_start_s:         S.recordingStartMs / 1000,
      video_url:                 null,
      shotIds,
    });
  } catch (e) { console.warn('Session save failed:', e); }

  // Free memory
  S.allSensorData = [];
  S.allRawPackets = [];

  setStatus('✅ Upload complete!');
  if (progressEl) progressEl.style.width = '100%';

  const uPct = userTotal > 0 ? Math.round(userMakes / userTotal * 100) : 0;
  const aPct = aiTotal   > 0 ? Math.round(aiMakes   / aiTotal   * 100) : 0;
  setEl('upload-summary', `User: ${userMakes}/${userTotal} (${uPct}%) · AI: ${aiMakes}/${aiTotal} · ${durSec}s`);

  const doneBtn = document.getElementById('upload-done-btn');
  if (doneBtn) doneBtn.style.display = '';
  doneBtn?.addEventListener('click', () => showScreen('dashboard'), { once: true });
}

// ── Binary sensor export ─────────────────────────────────────────────────────
function generateSensorBin() {
  const RECORD_SIZE = 8 + 336; // float64 hostMs + 336-byte raw BLE packet
  const buf = new ArrayBuffer(S.allRawPackets.length * RECORD_SIZE);
  const dv  = new DataView(buf);
  const u8  = new Uint8Array(buf);
  S.allRawPackets.forEach(({ hostMs, buffer }, i) => {
    const offset = i * RECORD_SIZE;
    dv.setFloat64(offset, hostMs, true); // little-endian float64
    u8.set(new Uint8Array(buffer), offset + 8);
  });
  return new Blob([buf], { type: 'application/octet-stream' });
}

// ── Session labels JSON export ────────────────────────────────────────────────
function generateSessionJson() {
  const output = {};
  S.sessionEvents.forEach((ev, idx) => {
    const source = (ev.user_top === ev.ai_top && ev.user_subtype === ev.ai_subtype)
      ? 'auto' : 'manual';
    output[idx] = {
      ai_top:        ev.ai_top,
      ai_subtype:    ev.ai_subtype,
      user_top:      ev.user_top,
      user_subtype:  ev.user_subtype,
      comment:       ev.comment ?? '',          // Feature 16
      source,
      event_type:      ev.event_type,
      device_event_ts: ev.device_event_ts,
      host_event_ts:   ev.host_event_ts_s,
      video_clip_ts: ev.video_clip_ts ?? null,
    };
  });
  return new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
}
