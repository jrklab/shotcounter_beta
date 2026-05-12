/**
 * parser.js
 * Packet parser — exact JavaScript port of the host-side process_data() parser.
 *
 * Updated packet layout (all multi-byte fields big-endian / network byte order):
 *
 *   ── Extended header (12 bytes) ───────────────────────────────────────
 *   [0:2]   pkt_id      uint16   0x4C49 ('L','I')
 *   [2:4]   RSVD        uint16   0x0000
 *   [4]     hw_version  uint8    hardware version
 *   [5]     fw_version  uint8    firmware version
 *   [6]     batt_raw    uint8    battery_mv / 20  (20 mV/LSB; 0 = unknown)
 *   [7]     temp_raw    uint8    temperature °C as int8 reinterpreted as uint8
 *   [8:12]  RSVD        uint32   0x00000000
 *   ── Sensor stream header (7 bytes) ───────────────────────────────────
 *   [12:16]  pkt_ts      uint32   ESP32 ms timestamp
 *   [16:18]  seq_id      uint16
 *   [18]     num_mpu     uint8
 *   ── MPU slots (19 + i×14 for i in range(num_mpu)) ────────────────────
 *       ts_delta  uint16
 *       ax ay az  int16 ×3
 *       gx gy gz  int16 ×3
 *   ── TOF section ──────────────────────────────────────────────────────
 *   [19 + num_mpu×14]         num_tof  uint8
 *   [19 + num_mpu×14 + 1 + i×6] for i in range(6):   (always 6 slots)
 *       ts_delta  uint16
 *       distance  uint16
 *       sr        uint16
 */

'use strict';

const ACCEL_SENSITIVITY  = 2048.0;   // LSB/g  for ±16g
const GYRO_SENSITIVITY   = 16.384;   // LSB/°/s for ±2000°/s
const SAMPLES_PER_PACKET = 20;
const TOF_SLOTS          = 6;        // fixed number of TOF slots per packet
const BAT_MV_PER_LSB     = 20;       // battery encoding: batt_mv = batt_raw × 20
const PKT_ID             = 0x4C49;  // 'L','I'

export class PacketParser {
  constructor() {
    this._lastSeq = -1;
  }

  reset() {
    this._lastSeq = -1;
  }

  /**
   * Parse one BLE notification DataView.
   * @returns {{ mpuBatch: Array|null, tofBatch: Array, lostPackets: number, deviceInfo: Object|null }}
   *   mpuBatch is null if the packet was stale/duplicate.
   *   mpuBatch: [{accel:[3], gyro:[3], ts}]  (ts in ms, same as ESP32 pktTs)
   *   tofBatch: [{distance, sr, ts, isOor}]  (real slots only; isOor=true for 0xFFFF readings)
   *   deviceInfo: { hwVersion, fwVersion, battMv, tempC } or null on bad packet.
   */
  parse(view) {
    if (view.byteLength < 336) return { mpuBatch: null, tofBatch: [], lostPackets: 0, deviceInfo: null };

    // ── Validate packet identifier ────────────────────────────────────────
    const pktId = view.getUint16(0, false);
    if (pktId !== PKT_ID) return { batch: null, lostPackets: 0, deviceInfo: null };

    // ── Extended header ───────────────────────────────────────────────────
    const hwVersion = view.getUint8(4);
    const fwVersion = view.getUint8(5);
    const battRaw   = view.getUint8(6);
    const tempRaw   = view.getUint8(7);
    const battMv    = battRaw * BAT_MV_PER_LSB;
    // int8 sign-extension for temperature
    const tempC     = tempRaw < 128 ? tempRaw : tempRaw - 256;
    const deviceInfo = { hwVersion, fwVersion, battMv, tempC };

    // ── Sensor stream header ──────────────────────────────────────────────
    const pktTs  = view.getUint32(12, false);
    const seqId  = view.getUint16(16, false);
    const numMpu = view.getUint8(18);

    // ── Sequence check ────────────────────────────────────────────────────
    let lostPackets = 0;
    if (this._lastSeq >= 0) {
      const gap = (seqId - this._lastSeq) & 0xFFFF;
      if (gap === 0 || (seqId < this._lastSeq &&
                        !(this._lastSeq > 60000 && seqId < 5000))) {
        return { mpuBatch: null, tofBatch: [], lostPackets: 0, deviceInfo };   // stale / duplicate
      }
      if (gap > 1) lostPackets = gap - 1;
    }
    this._lastSeq = seqId;

    // ── MPU samples → mpuBatch ───────────────────────────────────────────
    const mpuBatch = [];
    for (let i = 0; i < numMpu; i++) {
      const off     = 19 + i * 14;
      const tsDelta = view.getUint16(off, false);
      const ax = view.getInt16(off + 2,  false) / ACCEL_SENSITIVITY;
      const ay = view.getInt16(off + 4,  false) / ACCEL_SENSITIVITY;
      const az = view.getInt16(off + 6,  false) / ACCEL_SENSITIVITY;
      const gx = view.getInt16(off + 8,  false) / GYRO_SENSITIVITY;
      const gy = view.getInt16(off + 10, false) / GYRO_SENSITIVITY;
      const gz = view.getInt16(off + 12, false) / GYRO_SENSITIVITY;
      mpuBatch.push({ accel: [ax, ay, az], gyro: [gx, gy, gz], ts: pktTs - tsDelta });
    }

    // ── TOF samples → tofBatch (real slots only, with OOR flag) ─────────
    const tofOff  = 19 + numMpu * 14;
    const numTof  = view.getUint8(tofOff);
    const tofBatch = [];
    for (let i = 0; i < Math.min(numTof, TOF_SLOTS); i++) {
      const off      = tofOff + 1 + i * 6;
      const tsDelta  = view.getUint16(off,     false);
      const distance = view.getUint16(off + 2, false);
      const sr       = view.getUint16(off + 4, false);
      if (distance === 0xFFFE) continue;   // firmware dummy-fill — skip
      const isOor = (distance === 0xFFFF);
      tofBatch.push({ distance, sr, ts: pktTs - tsDelta, isOor });
    }

    if (mpuBatch.length === 0)
      return { mpuBatch: null, tofBatch: [], lostPackets, deviceInfo };
    return { mpuBatch, tofBatch, lostPackets, deviceInfo };
  }
}

