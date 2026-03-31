'use strict';

/**
 * config.js — Shared sensor / window constants for the web app.
 *
 * Single source of truth for:
 *   - IMU / ToF sampling rates
 *   - Shot window geometry (pre/post duration around trigger)
 *
 * These values must match:
 *   ml/dataset_config.py  (dataset builder + ONNX export)
 *   cpp/src/sensors/mpu6050.h  (200 Hz esp_timer)
 */

// ── Sensor rates ──────────────────────────────────────────────────────────────
export const IMU_HZ = 200;   // MPU6050 native rate — 200 Hz esp_timer on ESP32
export const TOF_HZ = 40;    // VL53L1X effective update rate (Hz)

// ── ToF sentinel ─────────────────────────────────────────────────────────────
export const TOF_OOR_FILL_MM = 1300;  // OOR / invalid fill (short-range mode max)

export const PRE_S  = 0.5;   // seconds of data kept before the trigger
export const POST_S = 1.5;   // seconds of data collected after the trigger

// ── Experiment feature set (must match ml/dataset_config.py) ─────────────────
export const EXP_FEATURES = ['accel_mag', 'tof_range', 'tof_sr'];
