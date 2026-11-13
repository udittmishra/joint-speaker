// Joint Speaker — audio engine.
//
// How phones stay in sync:
//  1. Clock: every device measures its offset to the server clock with
//     NTP-style pings and keeps the fastest (most trustworthy) samples.
//  2. Scheduler: every piece of audio carries the server time it should be
//     *heard*. Each device converts that to its own AudioContext time
//     (accounting for its speaker latency) and schedules it there.
//  3. Drift: device audio clocks run a hair fast or slow. The scheduler
//     measures how far its queue has drifted from the ideal timeline and
//     nudges playback speed by up to ±0.3% (inaudible) to pull back in line.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const LIVE_HEADER_BYTES = 24;

// ------------------------------------------------------------------- Clock

export class Clock {
  constructor() {
    this.samples = [];
    this.offset = null; // server ms − local performance.now() ms
    this.rtt = null;
  }

  get synced() {
    return this.offset !== null && this.samples.length >= 3;
  }

  now() {
    return performance.now() + (this.offset ?? 0);
  }

  toLocal(serverMs) {
    return serverMs - (this.offset ?? 0);
  }

  addSample(t0, serverTs) {
    const t1 = performance.now();
    const rtt = t1 - t0;
    if (!(rtt >= 0 && rtt < 5000)) return;
    this.samples.push({ rtt, off: serverTs - (t0 + t1) / 2, at: t1 });
    const cutoff = t1 - 40000;
    this.samples = this.samples.filter((s) => s.at >= cutoff).slice(-40);

    // The lowest-RTT pings had the least queuing delay, so their midpoint
    // estimate is the most accurate. Average the best quarter.
    const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const best = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 4)));
    const est = best.reduce((s, x) => s + x.off, 0) / best.length;
    this.rtt = sorted[0].rtt;
    if (this.offset === null || Math.abs(est - this.offset) > 100) this.offset = est;
    else this.offset += (est - this.offset) * 0.3;
  }
}

// --------------------------------------------------------------- Scheduler

export class Scheduler {
  constructor(ctx, clock, destination) {
    this.ctx = ctx;
    this.clock = clock;
    this.dest = destination;
    this.nudgeMs = 0; // + means this device's speaker is late, so play earlier
    this.map = null; // AudioContext seconds − local perf seconds, at the speaker
    this.nextTime = null;
    this.errEma = 0;
    this.active = new Set();
    this.stats = { resyncs: 0, drops: 0, err: 0 };
    this._mapTimer = setInterval(() => this.updateMap(), 100);
  }

  /** Tracks the relationship between the audio clock and the page clock. */
  updateMap() {
    const ctx = this.ctx;
    const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    const fallback = ctx.currentTime - performance.now() / 1000 - lat;
    let sample = fallback;
    if (typeof ctx.getOutputTimestamp === 'function') {
      const ts = ctx.getOutputTimestamp();
      if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
        const s = ts.contextTime - ts.performanceTime / 1000;
        if (Math.abs(s - fallback) < 0.25) sample = s;
      }
    }
    if (this.map === null || Math.abs(sample - this.map) > 0.08) this.map = sample;
    else this.map += (sample - this.map) * 0.05;
  }

  /** AudioContext time at which a sample must be scheduled to be heard at serverMs. */
  serverToCtx(serverMs) {
    if (this.map === null) this.updateMap();
    return (this.clock.toLocal(serverMs) - this.nudgeMs) / 1000 + this.map;
  }

  /**
   * Queue an AudioBuffer whose first sample should be heard at serverMs.
   * Returns false if it arrived too late to play.
   */
  push(buffer, serverMs) {
    const ctx = this.ctx;
    const ideal = this.serverToCtx(serverMs);
    if (this.nextTime === null) {
      this.nextTime = ideal;
      this.errEma = 0;
    }
    let err = this.nextTime - ideal; // > 0: we're running late
    if (Math.abs(err) > 0.04) {
      this.nextTime = ideal;
      err = 0;
      this.errEma = 0;
      this.stats.resyncs++;
    }
    if (this.nextTime < ctx.currentTime + 0.02) {
      this.nextTime = null;
      this.stats.drops++;
      return false;
    }
    this.errEma += (err - this.errEma) * 0.12;
    this.stats.err = this.errEma * 1000;
    // Correct roughly half the error per second, never more than ±0.3% speed.
    const rate = 1 + clamp(this.errEma * 0.5, -0.003, 0.003);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(this.dest);
    src.start(this.nextTime);
    src.onended = () => this.active.delete(src);
    this.active.add(src);
    this.nextTime += buffer.duration / rate;
    return true;
  }

  /** Stop everything queued, at ctx time `when` (0 = right now). */
  stopAll(when = 0) {
    const at = Math.max(when, this.ctx.currentTime);
    for (const src of this.active) {
      try {
        src.stop(at);
      } catch {}
    }
    if (!when) this.active.clear();
    this.nextTime = null;
    this.errEma = 0;
  }

  /** Short clicks on every phone at the same moments — for checking sync by ear. */
  beeps(atServerMs, count, interval) {
    const ctx = this.ctx;
    for (let i = 0; i < count; i++) {
      const when = this.serverToCtx(atServerMs + i * interval);
      if (when < ctx.currentTime + 0.01) continue;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = i % 4 === 0 ? 1568 : 1046;
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(0.9, when + 0.002);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.09);
      osc.connect(g).connect(this.dest);
      osc.start(when);
      osc.stop(when + 0.1);
    }
  }
}

// -------------------------------------------------------- Live (tab audio)

export function packLive({ seq, t, sampleRate, channels, pcm }) {
  const frames = pcm.length / channels;
  const buf = new ArrayBuffer(LIVE_HEADER_BYTES + pcm.byteLength);
  const dv = new DataView(buf);
  dv.setUint8(0, 1);
  dv.setUint8(1, channels);
  dv.setUint32(4, sampleRate, true);
  dv.setUint32(8, seq >>> 0, true);
  dv.setUint32(12, frames, true);
  dv.setFloat64(16, t, true);
  new Int16Array(buf, LIVE_HEADER_BYTES).set(pcm);
  return buf;
}

export class LiveReceiver {
  constructor(scheduler) {
    this.scheduler = scheduler;
    this.delay = 1000;
    this.lastSeq = null;
    this.level = 0;
  }

  reset() {
    this.lastSeq = null;
  }

  handle(packet) {
    const dv = new DataView(packet);
    if (dv.getUint8(0) !== 1) return;
    const ch = dv.getUint8(1);
    const sr = dv.getUint32(4, true);
    const seq = dv.getUint32(8, true);
    const frames = dv.getUint32(12, true);
    const t = dv.getFloat64(16, true);
    const pcm = new Int16Array(packet, LIVE_HEADER_BYTES, frames * ch);

    if (this.lastSeq !== null && seq !== ((this.lastSeq + 1) >>> 0)) this.scheduler.nextTime = null;
    this.lastSeq = seq;

    const ctx = this.scheduler.ctx;
    const buf = ctx.createBuffer(ch, frames, sr);
    for (let c = 0; c < ch; c++) {
      const out = buf.getChannelData(c);
      for (let i = 0, j = c; i < frames; i++, j += ch) out[i] = pcm[j] / 32768;
    }
    this.scheduler.push(buf, t + this.delay);
  }
}

// ------------------------------------------------------------ File playback

const FILE_CHUNK_SECONDS = 0.1;
const FILE_LOOKAHEAD_SECONDS = 1.2;

export class FilePlayer {
  constructor(scheduler, clock) {
    this.scheduler = scheduler;
    this.clock = clock;
    this.buffer = null;
    this.trackId = null;
    this.playback = null;
    this.pos = null; // next sample index to queue
    this.timer = null;
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  setBuffer(id, audioBuffer) {
    this.stop();
    this.trackId = id;
    this.buffer = audioBuffer;
  }

  clear() {
    this.stop();
    this.trackId = null;
    this.buffer = null;
  }

  /** Position (seconds) in the song at a given server time. */
  positionAt(serverMs) {
    const pb = this.playback;
    if (!pb) return 0;
    if (!pb.playing) return pb.offset;
    return pb.offset + Math.max(0, serverMs - pb.startAt) / 1000;
  }

  apply(playback) {
    this.playback = playback;
    if (playback && playback.playing && this.buffer) {
      this.scheduler.stopAll();
      this.pos = null;
      if (!this.timer) this.timer = setInterval(() => this.tick(), 100);
      this.tick();
    } else {
      const when = playback && playback.pauseAt ? this.scheduler.serverToCtx(playback.pauseAt) : 0;
      this.stop(when);
    }
  }

  stop(when = 0) {
    clearInterval(this.timer);
    this.timer = null;
    this.pos = null;
    this.scheduler.stopAll(when);
  }

  tick() {
    const pb = this.playback;
    const b = this.buffer;
    const sch = this.scheduler;
    if (!pb || !pb.playing || !b || !this.clock.synced) return;
    const sr = b.sampleRate;
    if (this.pos === null) {
      const t = Math.max(pb.offset, this.positionAt(this.clock.now() + 150));
      this.pos = Math.round(t * sr);
    }
    const chunk = Math.round(FILE_CHUNK_SECONDS * sr);
    let guard = 0;
    while (
      (sch.nextTime === null || sch.nextTime < sch.ctx.currentTime + FILE_LOOKAHEAD_SECONDS) &&
      guard++ < 30
    ) {
      if (this.pos >= b.length) break;
      const len = Math.min(chunk, b.length - this.pos);
      const piece = sch.ctx.createBuffer(b.numberOfChannels, len, sr);
      for (let c = 0; c < b.numberOfChannels; c++) {
        piece.getChannelData(c).set(b.getChannelData(c).subarray(this.pos, this.pos + len));
      }
      const serverMs = pb.startAt + (this.pos / sr - pb.offset) * 1000;
      if (!sch.push(piece, serverMs)) {
        this.pos = null; // fell behind (tab was asleep?) — re-aim at "now" next tick
        break;
      }
      this.pos += len;
    }
  }
}

// ------------------------------------------------------------ Audio unlock

let silentEl = null;

function silentWavUrl() {
  const n = 4000;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF');
  dv.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true);
  dv.setUint32(28, 16000, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, 'data');
  dv.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

/**
 * Must be called synchronously inside a tap/click handler.
 * Creates the AudioContext and makes iPhones play even with the silent switch on.
 */
export function unlockAudio() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch {}
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  ctx.resume?.();
  const b = ctx.createBuffer(1, 1, 22050);
  const s = ctx.createBufferSource();
  s.buffer = b;
  s.connect(ctx.destination);
  s.start(0);
  try {
    if (!silentEl) {
      silentEl = new Audio(silentWavUrl());
      silentEl.loop = true;
      silentEl.setAttribute('playsinline', '');
    }
    silentEl.play().catch(() => {});
  } catch {}
  return ctx;
}

export function decodeAudio(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(arrayBuffer, resolve, (e) =>
      reject(e || new Error('This device cannot play that file format.'))
    );
    if (p && typeof p.catch === 'function') p.catch(() => {});
  });
}
