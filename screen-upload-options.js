'use strict';

import { S }                from './state.js';
import { showScreen }       from './utils.js';
import { startUpload }      from './screen-upload.js';

// ── Wire (called once on DOMContentLoaded) ────────────────────────────────────
export function wireUploadOptions() {
  // Video mode radio buttons
  document.querySelectorAll('input[name="uo-video-mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      S.uploadVideoMode = radio.value;   // 'all' | 'corrected' | 'none'
    });
  });

  // Comment textarea
  const commentEl = document.getElementById('uo-comment');
  if (commentEl) {
    commentEl.addEventListener('input', () => { S.sessionComment = commentEl.value; });
  }

  // Location text label
  const labelEl = document.getElementById('uo-location-label');
  if (labelEl) {
    labelEl.addEventListener('input', () => {
      if (S.sessionLocation) S.sessionLocation.label = labelEl.value;
      else S.sessionLocation = { lat: null, lng: null, label: labelEl.value };
    });
  }

  // GPS detect button
  document.getElementById('uo-gps-btn')?.addEventListener('click', requestGps);

  // Upload button
  document.getElementById('uo-upload-btn')?.addEventListener('click', () => {
    startUpload();
  });
}

// ── Init (called each time the screen is shown) ───────────────────────────────
export function initUploadOptions() {
  // Reset comment field
  S.sessionComment  = '';
  S.uploadVideoMode = 'corrected';

  const commentEl = document.getElementById('uo-comment');
  if (commentEl) commentEl.value = '';

  // Reset radio to default
  const defaultRadio = document.querySelector('input[name="uo-video-mode"][value="corrected"]');
  if (defaultRadio) defaultRadio.checked = true;

  // Location label
  const labelEl  = document.getElementById('uo-location-label');
  const gpsEl    = document.getElementById('uo-gps-status');
  if (labelEl) labelEl.value = '';
  if (gpsEl)   gpsEl.textContent = '';
  S.sessionLocation = null;

  // Auto-attempt GPS on screen load
  requestGps();
}

// ── GPS helper ────────────────────────────────────────────────────────────────
function requestGps() {
  const statusEl = document.getElementById('uo-gps-status');
  const labelEl  = document.getElementById('uo-location-label');
  if (!navigator.geolocation) {
    if (statusEl) statusEl.textContent = '⚠️ Geolocation not supported';
    return;
  }
  if (statusEl) statusEl.textContent = '📍 Detecting location…';
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      S.sessionLocation = { lat, lng, label: labelEl?.value ?? '' };
      if (statusEl) statusEl.textContent = `📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}  (±${Math.round(accuracy)} m)`;
    },
    err => {
      if (statusEl) statusEl.textContent = `⚠️ GPS unavailable — ${err.message}`;
      S.sessionLocation = { lat: null, lng: null, label: labelEl?.value ?? '' };
    },
    { enableHighAccuracy: true, timeout: 10_000 },
  );
}
