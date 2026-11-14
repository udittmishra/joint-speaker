import {
  Clock,
  Scheduler,
  LiveReceiver,
  FilePlayer,
  Loudness,
  packLive,
  unlockAudio,
  decodeAudio,
} from './audio.js';
import { GlyphField } from './glyphs.js';

// ------------------------------------------------------------------ Helpers

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function storage(area) {
  return {
    get(k, d) {
      try {
        const v = window[area].getItem(k);
        return v === null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        if (v === undefined || v === null) window[area].removeItem(k);
        else window[area].setItem(k, JSON.stringify(v));
      } catch {}
    },
  };
}
const local = storage('localStorage');
const session = storage('sessionStorage');

function randomId() {
  if (window.crypto && crypto.randomUUID) {
    try {
      return crypto.randomUUID();
    } catch {}
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function defaultName() {
  const ua = navigator.userAgent;
  const kind = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'PC' : 'Phone';
  return `${kind} ${Math.floor(10 + Math.random() * 90)}`;
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Only Chromium browsers (Chrome, Edge, Brave, Arc…) on a computer can share a
// tab *with its sound*. Safari and Firefox share the picture but no audio.
const isMobile = /Android|iPhone|iPad/.test(navigator.userAgent);
const isChromium = /Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent);
const canShareTab = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !isMobile && isChromium;

// ------------------------------------------------------------------- Island

const island = $('#island');
const islandDot = island.querySelector('.island-dot');
const islandText = island.querySelector('.island-text');
let islandStatus = null;
let toastMsg = null;
let toastTimer = null;

function paintIsland() {
  const s = toastMsg ? { cls: 'info', text: toastMsg } : islandStatus;
  island.classList.toggle('show', !!s);
  island.classList.toggle('expanded', !!toastMsg);
  if (!s) return;
  islandDot.className = `island-dot ${s.cls || ''}`;
  if (islandText.textContent !== s.text) islandText.textContent = s.text;
}

function setIslandStatus(s) {
  if (s && islandStatus && s.cls === islandStatus.cls && s.text === islandStatus.text) return;
  islandStatus = s;
  paintIsland();
}

function toast(msg, ms = 4200) {
  toastMsg = msg;
  $('#announcer').textContent = msg;
  paintIsland();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastMsg = null;
    paintIsland();
  }, ms);
}

// -------------------------------------------------------------------- State

const S = {
  role: null,
  room: null,
  hostKey: null,
  clientId: local.get('js.clientId') || randomId(),
  name: local.get('js.name', ''),
  ws: null,
  leaving: false,
  connected: false,

  ctx: null,
  out: null,
  analyser: null,
  clock: new Clock(),
  scheduler: null,
  live: null,
  file: null,

  state: null,
  members: [],
  loadingId: null,
  loadPct: 0,
  loadError: null,

  tab: canShareTab ? 'live' : 'file',
  playLocal: true,
  capture: null,
  workletReady: false,
  upload: null,
  seeking: false,
  stopSentFor: null,

  pingTimer: null,
  inviteLink: null,
  wakeLock: null,
};
local.set('js.clientId', S.clientId);
window.__jointSpeaker = S; // handy for debugging from the console

// ---------------------------------------------------- Living mesh gradient

// Palettes rotate every 20 s. On phones the clock is the shared server clock,
// so every screen shows the same colours, moving the same way, at the same time.
// Vivid "photo" palettes: [blob 1, blob 2, blob 3, base].
const NAMED_PALETTES = {
  electric: ['#0A3BFF', '#5BE3FF', '#8A3FFC', '#1238E8'],
  ember: ['#FF1F5A', '#FFB03D', '#8E1FB8', '#E8174F'],
  violet: ['#7B2FF7', '#FF5FD2', '#1B4BFF', '#5A2BE0'],
  bloom: ['#FF2E88', '#6FA0FF', '#FFC2E0', '#E0367F'],
};
const PALETTES = [NAMED_PALETTES.electric, NAMED_PALETTES.ember, NAMED_PALETTES.violet, NAMED_PALETTES.bloom];
const PALETTE_SECONDS = 20;
let paletteIdx = -1;

// Glyph colours for each palette above: [sparkle, core, coastline, strays].
// Neon pink leads wherever the artwork is blue or violet; where the artwork is
// itself pink or red, white and cyan lead so the glyphs never vanish into it.
const GLYPH_COLORS = [
  ['#FFFFFF', '#FF4FB8', '#C77DFF', '#5CF2FF'], // electric
  ['#FFFFFF', '#FFF1F8', '#5CF2FF', '#FFE45C'], // ember
  ['#FFFFFF', '#FF9BE6', '#5CF2FF', '#FFE45C'], // violet
  ['#FFFFFF', '#FFFFFF', '#5CF2FF', '#B6FF5C'], // bloom
].map((set) => set.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))));

/** Glyph colours at shared time t, cross-fading over the same 3 s as the artwork. */
function glyphColorsAt(t) {
  const idx = Math.floor(t / PALETTE_SECONDS) % PALETTES.length;
  const prev = (idx + PALETTES.length - 1) % PALETTES.length;
  const since = t - Math.floor(t / PALETTE_SECONDS) * PALETTE_SECONDS;
  const k = smoothstep(Math.min(1, since / 3));
  return GLYPH_COLORS[idx].map((to, band) => {
    const from = GLYPH_COLORS[prev][band];
    return `rgb(${from.map((v, i) => Math.round(v + (to[i] - v) * k)).join(',')})`;
  });
}
const smoothstep = (x) => x * x * (3 - 2 * x);

const BLOB_HTML = '<span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span><span class="blob b4"></span><span class="grain"></span>';
const meshes = $$('[data-mesh]').map((el) => {
  el.innerHTML = BLOB_HTML;
  const named = NAMED_PALETTES[el.dataset.palette];
  if (named) named.forEach((c, i) => el.style.setProperty(`--c${i + 1}`, c));
  return {
    el,
    blobs: [...el.querySelectorAll('.blob')],
    still: el.dataset.mesh === 'static',
    phase: Number(el.dataset.phase) || 0,
    ambient: el.parentElement.classList.contains('ambient'),
    glyphs: new GlyphField(el), // neon characters drawn over the artwork
  };
});

// Give still meshes one fixed, pleasing arrangement.
for (const m of meshes) if (m.still) placeBlobs(m, 7 + m.phase, 0, 1);

function placeBlobs(m, t, energy, speed) {
  m.blobs.forEach((b, i) => {
    const k = i + 1;
    const x = 32 * Math.sin(t * 0.21 * speed * k + i * 1.7);
    const y = 28 * Math.cos(t * 0.17 * speed * (k + 0.3) + i * 2.3);
    const s = 1 + 0.18 * Math.sin(t * 0.29 + i * 1.1) + energy * 0.12;
    b.style.transform = `translate(${x.toFixed(2)}%, ${y.toFixed(2)}%) scale(${s.toFixed(3)})`;
  });
}

function sharedSeconds() {
  return (S.clock.synced ? S.clock.now() : Date.now()) / 1000;
}

function setPalette(t) {
  const idx = Math.floor(t / PALETTE_SECONDS) % PALETTES.length;
  if (idx === paletteIdx) return;
  paletteIdx = idx;
  const root = document.documentElement.style;
  PALETTES[idx].forEach((c, i) => root.setProperty(`--c${i + 1}`, c));
}

function moveMeshes(t, energy) {
  const speed = 0.35 + energy * 0.25;
  // Read visibility for every mesh first, then write, so the browser never
  // has to recalculate styles in the middle of the loop.
  const visible = meshes.filter((m) => !m.still && (m.ambient || m.el.offsetParent));
  for (const m of visible) placeBlobs(m, t + m.phase, energy, speed);
}

// The glyph field over each artwork. Hidden screens are skipped, and the
// full-page background only gets glyphs on phones, where it becomes the light
// show; elsewhere it's washed out behind the main artwork anyway.
function drawGlyphs(t, energy) {
  const listening = document.body.dataset.screen === 'listen';
  const visible = meshes.filter((m) => (m.ambient ? listening : m.el.offsetParent));
  // With reduced motion, draw one still frame instead of animating.
  const at = reducedMotion ? 0 : t;
  const colors = glyphColorsAt(t);
  for (const m of visible) m.glyphs.update(at + m.phase * 7, reducedMotion ? 0 : energy, colors);
}

// --------------------------------------------------------------------- Audio

/** Call synchronously inside a click/tap handler. */
function setupAudio() {
  if (S.ctx) {
    S.ctx.resume?.();
    return;
  }
  const ctx = unlockAudio();
  const out = ctx.createGain();
  const loudness = new Loudness(ctx);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.5;
  out.connect(loudness.input);
  loudness.output.connect(analyser);
  analyser.connect(ctx.destination);
  S.ctx = ctx;
  S.out = out;
  S.loudness = loudness;
  S.analyser = analyser;
  S.scheduler = new Scheduler(ctx, S.clock, out);
  S.scheduler.nudgeMs = local.get('js.nudge', 0);
  S.live = new LiveReceiver(S.scheduler);
  S.file = new FilePlayer(S.scheduler, S.clock);
}

async function keepAwake() {
  if (!('wakeLock' in navigator) || S.wakeLock) return;
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
    S.wakeLock.addEventListener('release', () => (S.wakeLock = null));
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.role) keepAwake();
});

// ------------------------------------------------------------------- Network

function send(msg) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  S.ws = ws;

  ws.onopen = () => {
    send({
      type: 'hello',
      role: S.role,
      room: S.room,
      hostKey: S.hostKey,
      name: S.name,
      clientId: S.clientId,
    });
    startPings();
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') {
      if (S.role === 'listener' && S.live && S.state && S.state.live.on) S.live.handle(e.data);
      return;
    }
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    onMessage(m);
  };
  ws.onclose = (e) => {
    if (S.ws !== ws) return;
    stopPings();
    setConnected(false);
    if (S.leaving || e.code === 4000) return;
    setTimeout(() => {
      if (S.ws === ws && !S.leaving) connect();
    }, 1500);
  };
}

function startPings() {
  stopPings();
  const ping = () => send({ type: 'ping', t0: performance.now() });
  let n = 0;
  ping();
  // A quick burst to lock on, then a steady trickle to track drift.
  S.pingTimer = setInterval(() => {
    ping();
    if (++n === 10) {
      clearInterval(S.pingTimer);
      S.pingTimer = setInterval(ping, 1500);
    }
  }, 120);
}

function stopPings() {
  clearInterval(S.pingTimer);
  S.pingTimer = null;
}

function sendStatus() {
  if (!S.role) return;
  send({
    type: 'status',
    rtt: S.clock.rtt,
    ready: S.file ? S.file.trackId : null,
    nudge: S.scheduler ? S.scheduler.nudgeMs : 0,
  });
}
setInterval(sendStatus, 2000);

function onMessage(m) {
  switch (m.type) {
    case 'pong':
      S.clock.addSample(m.t0, m.ts);
      break;
    case 'welcome':
      S.role = m.role;
      S.room = m.room;
      if (m.role === 'host') {
        S.hostKey = m.hostKey;
        session.set('js.host', { room: m.room, hostKey: m.hostKey });
        history.replaceState(null, '', '/');
      } else {
        history.replaceState(null, '', `/?r=${m.room}`);
      }
      setConnected(true);
      showScreen(m.role === 'host' ? 'host' : 'listen');
      if (m.role === 'host') setupInvite();
      applyState(m.state);
      sendStatus();
      keepAwake();
      break;
    case 'state':
      applyState(m.state);
      break;
    case 'members':
      S.members = m.members || [];
      renderMembers();
      renderHost();
      break;
    case 'beeps':
      if (S.scheduler && (S.role !== 'host' || S.playLocal)) S.scheduler.beeps(m.at, m.count, m.interval);
      if (S.role === 'listener') toast('Sync test');
      break;
    case 'error':
      if (m.code === 'no-room') {
        leave();
        codeInput.value = '';
        paintOtp();
      }
      toast(m.message || 'Something went wrong.');
      break;
  }
}

function samePlayback(a, b) {
  return a && b && a.playing === b.playing && a.startAt === b.startAt && a.offset === b.offset && a.pauseAt === b.pauseAt;
}

function applyState(st) {
  const prev = S.state;
  S.state = st;
  if (!prev && S.role === 'host' && st.track && !st.live.on) S.tab = 'file';
  if (!S.scheduler) return render();

  S.loudness.setEnabled(!!st.loud);
  S.live.delay = st.delay;
  const liveOn = st.live.on;
  const wasLive = !!(prev && prev.live.on);

  if (liveOn && !wasLive) {
    S.file.stop();
    S.scheduler.stopAll();
    S.live.reset();
  } else if (!liveOn && wasLive) {
    S.scheduler.stopAll();
    S.live.reset();
  } else if (liveOn && prev && prev.delay !== st.delay) {
    S.scheduler.stopAll();
    S.live.reset();
  }

  const track = st.track;
  if (!track) {
    if (S.file.trackId) S.file.clear();
    S.loadingId = null;
    S.loadError = null;
  } else if (track.id !== S.file.trackId && track.id !== S.loadingId) {
    loadTrack(track);
  }

  if (!liveOn && track && S.file.trackId === track.id) {
    const changed = !prev || wasLive || !samePlayback(prev.playback, st.playback) ||
      !prev.track || prev.track.id !== track.id;
    if (changed) S.file.apply(st.playback);
  } else if (!liveOn) {
    S.file.playback = st.playback;
  }
  render();
}

async function loadTrack(track) {
  S.loadingId = track.id;
  S.loadPct = 0;
  S.loadError = null;
  S.file.clear();
  render();
  sendStatus();
  try {
    const res = await fetch(track.url);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const total = Number(res.headers.get('Content-Length')) || 0;
    let bytes;
    if (res.body && res.body.getReader && total) {
      const reader = res.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        S.loadPct = got / total;
        if (S.loadingId !== track.id) return;
        render();
      }
      bytes = new Uint8Array(got);
      let o = 0;
      for (const p of parts) {
        bytes.set(p, o);
        o += p.length;
      }
      bytes = bytes.buffer;
    } else {
      bytes = await res.arrayBuffer();
    }
    if (S.loadingId !== track.id) return;
    S.loadPct = 1;
    render();
    const buf = await decodeAudio(S.ctx, bytes);
    if (S.loadingId !== track.id) return;
    S.loadingId = null;
    S.file.setBuffer(track.id, buf);
    const st = S.state;
    if (st && !st.live.on && st.track && st.track.id === track.id) S.file.apply(st.playback);
  } catch (err) {
    if (S.loadingId === track.id) {
      S.loadingId = null;
      S.loadError = 'Can’t play this file. Try MP3.';
    }
  }
  render();
  sendStatus();
}

// ----------------------------------------------------------------- Screens

function showScreen(name) {
  for (const id of ['home', 'host', 'listen']) $(`#${id}`).hidden = id !== name;
  document.body.dataset.screen = name;
  document.body.classList.remove('on-air');
  if (name !== 'listen') setIslandStatus(null);
  window.scrollTo(0, 0);
}

function setConnected(on) {
  S.connected = on;
  for (const el of $$('[data-conn]')) {
    el.querySelector('span').textContent = on ? 'Connected' : 'Reconnecting…';
    el.title = on ? 'Connected' : 'Reconnecting…';
    el.classList.toggle('off', !on);
  }
}

function render() {
  if (S.role === 'host') renderHost();
  else if (S.role === 'listener') renderListener();
}

function readyCount() {
  const st = S.state;
  if (!st || !st.track) return { ready: 0, total: 0 };
  const total = S.members.length || st.speakers || 1;
  const ready = S.members.filter((m) => m.ready === st.track.id).length;
  return { ready, total };
}

/** Fill-bar sliders: paint the fill from the input's value. */
function paintBar(wrapper) {
  const input = wrapper.querySelector('input');
  const min = Number(input.min);
  const max = Number(input.max);
  const p = ((Number(input.value) - min) / (max - min)) * 100;
  if (wrapper.classList.contains('bipolar')) {
    wrapper.style.setProperty('--from', `${Math.min(p, 50)}%`);
    wrapper.style.setProperty('--w', `${Math.abs(p - 50)}%`);
    wrapper.classList.toggle('neg', p < 50);
    wrapper.classList.toggle('pos', p > 50);
  } else {
    wrapper.style.setProperty('--from', '0%');
    wrapper.style.setProperty('--w', `${p}%`);
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmtDelay = (ms) => `${(ms / 1000).toFixed(1)} s`;

function renderHost() {
  const st = S.state;
  if (!st) return;
  $('#host-code').textContent = st.room;
  $('#host-code').setAttribute('aria-label', `Party code ${st.room.split('').join(' ')}`);
  $('#host-sub').textContent = plural(st.speakers, 'speaker');

  // Stream / Song
  for (const b of $$('.seg [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
  $('#tab-live').hidden = S.tab !== 'live';
  $('#tab-file').hidden = S.tab !== 'file';
  const playingFile = st.track && st.playback.playing && !st.live.on;

  // Stream
  const sharing = !!S.capture;
  $('#live-idle').hidden = sharing;
  $('#live-on').hidden = !sharing;
  $('#stream-actions').hidden = !canShareTab;
  $('#stream-hint').hidden = !canShareTab;
  $('#live-unsupported').hidden = canShareTab;

  // Song file
  $('#upload-box').hidden = !S.upload;
  if (S.upload) {
    $('#upload-name').textContent = S.upload.name;
    $('#upload-meter').style.width = `${Math.round(S.upload.pct * 100)}%`;
  }
  const hasTrack = !!st.track && !S.upload;
  $('#track-box').hidden = !hasTrack;
  $('#file-empty').hidden = !!st.track || !!S.upload;
  if (hasTrack) {
    $('#track-name').textContent = st.track.name;
    const { ready, total } = readyCount();
    let readyText = `Ready on ${ready} of ${total}`;
    if (S.loadingId) readyText = `Loading… ${Math.round(S.loadPct * 100)}%`;
    if (S.loadError) readyText = S.loadError;
    if (st.live.on) readyText = 'Paused while streaming';
    $('#track-ready').textContent = readyText;
    const pb = $('#play-btn');
    pb.classList.toggle('playing', !!playingFile);
    pb.setAttribute('aria-label', playingFile ? 'Pause' : 'Play');
    pb.disabled = !S.file.buffer;
    $('#restart-btn').disabled = !S.file.buffer;
    $('#t-dur').textContent = fmtTime(S.file.duration);
    $('#seek').disabled = !S.file.buffer;
  }

  // Settings
  $('#delay-field').hidden = S.tab !== 'live' && !st.live.on;
  if (document.activeElement !== $('#delay')) {
    $('#delay').value = st.delay;
    $('#delay-val').textContent = fmtDelay(st.delay);
    paintBar($('#delay').closest('[data-bar]'));
  }
  $('#local-toggle').checked = S.playLocal;
  $('#loud-toggle').checked = !!st.loud;
}

// Speakers shown as a small stack of coloured dots next to the count.
function renderMembers() {
  const dots = $('#speaker-dots');
  const list = [...S.members].sort((a, b) => (b.host ? 1 : 0) - (a.host ? 1 : 0)).slice(0, 6);
  dots.textContent = '';
  for (const m of list) {
    const i = document.createElement('i');
    i.style.setProperty('--h', 210 + (hashHue(m.name || m.id) % 130));
    dots.append(i);
  }
  const st = S.state;
  if (st && st.track && !st.live.on) {
    const { ready, total } = readyCount();
    if (S.file && S.file.buffer) $('#track-ready').textContent = `Ready on ${ready} of ${total}`;
  }
}

// The listener's card: tiny label on top, one big thin thing in the middle.
function renderListener() {
  const st = S.state;
  if (!st) return;
  let top = `Party ${st.room}`;
  let big = st.room;
  let foot = 'Waiting for music';
  let right = plural(st.speakers, 'speaker');
  const hasSong = st.track && !st.live.on;
  if (st.live.on) {
    big = 'Live';
    foot = 'Streaming from host';
  } else if (hasSong) {
    foot = st.track.name;
    right = '';
    if (S.loadingId) {
      big = `${Math.round(S.loadPct * 100)}%`;
      top = 'Loading song';
    } else if (S.loadError) {
      big = '!';
      foot = S.loadError;
    } else if (!S.file || !S.file.buffer) {
      big = '0:00';
    }
  }
  if (!st.hostOnline && !st.live.on && !(st.playback.playing && st.track)) {
    big = '—';
    foot = 'Host left';
    right = '';
  }
  $('#card-top').textContent = top;
  // While a song is loaded, the elapsed time is written every 250 ms instead.
  if (!(hasSong && S.file && S.file.buffer && !S.loadingId && st.hostOnline)) $('#card-big').textContent = big;
  $('#now-title').textContent = foot;
  if (!(hasSong && S.file && S.file.buffer)) {
    $('#np-dur').textContent = right;
    $('#np-fill').style.width = st.live.on ? '100%' : '0%';
  }
}

function syncStatus() {
  const c = S.clock;
  if (!S.connected) return { cls: 'bad', text: 'Reconnecting…' };
  if (!c.synced) return { cls: '', text: 'Syncing…' };
  const ms = Math.round(c.rtt);
  if (c.rtt > 250) return { cls: 'bad', text: `Weak Wi-Fi · ${ms} ms` };
  if (c.rtt > 80) return { cls: 'meh', text: `In sync · ${ms} ms` };
  return { cls: 'good', text: `In sync · ${ms} ms` };
}

// ------------------------------------------------------------ Frame loop

const card3d = $('#card3d');
let airBlend = 0; // 0 = resting pose, 1 = swaying with the music
const timeData = new Uint8Array(1024);
const freqData = new Uint8Array(128);
let level = 0;
let lastSlow = 0;
const liveBars = [];
const liveSilent = $('#live-silent');
for (let i = 0; i < 32; i++) {
  const s = document.createElement('span');
  $('#live-bars').append(s);
  liveBars.push(s);
}

function isOnAir() {
  const st = S.state;
  return !!(st && (st.live.on || (st.playback.playing && S.file && S.file.buffer)));
}

function frame(ts) {
  requestAnimationFrame(frame);

  // Output loudness drives the listener's folder fan.
  let rms = 0;
  if (S.analyser && S.role) {
    S.analyser.getByteTimeDomainData(timeData);
    let sum = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = (timeData[i] - 128) / 128;
      sum += v * v;
    }
    rms = Math.sqrt(sum / timeData.length);
  }
  level = rms > level ? rms : level * 0.9;
  const l = Math.min(1, level * 2.6);

  const t = sharedSeconds();
  setPalette(t);
  if (!reducedMotion) moveMeshes(t, S.role === 'listener' ? l : 0);
  drawGlyphs(t, S.role === 'listener' ? l : 0);

  if (S.role === 'listener') {
    const onAir = isOnAir() && S.clock.synced;
    if (onAir !== document.body.classList.contains('on-air')) document.body.classList.toggle('on-air', onAir);
    // The card rests at an angle; while music plays it sways on the shared
    // clock, so every phone's card moves together. Set on the card only.
    airBlend += ((onAir ? 1 : 0) - airBlend) * 0.06;
    const b = reducedMotion ? 0 : airBlend;
    const ry = -18 * (1 - b) + b * (Math.sin(t * 0.55) * 14 + l * 6);
    const rx = 6 * (1 - b) + b * (Math.cos(t * 0.42) * 5);
    const sc = 0.92 + b * (0.08 + l * 0.03);
    card3d.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
    card3d.style.setProperty('--rx', `${rx.toFixed(2)}deg`);
    card3d.style.setProperty('--sc', sc.toFixed(4));
  }

  if (S.role === 'host' && S.capture && S.capture.analyser) {
    S.capture.analyser.getByteFrequencyData(freqData);
    // Nudge the host if the shared tab stays silent (Spotify not playing yet).
    let peak = 0;
    for (let i = 0; i < freqData.length; i++) if (freqData[i] > peak) peak = freqData[i];
    const cap = S.capture;
    if (peak > 12) cap.silentSince = null;
    else if (cap.silentSince == null) cap.silentSince = ts;
    const silent = cap.silentSince != null && ts - cap.silentSince > 3500;
    if (silent === liveSilent.hidden) liveSilent.hidden = !silent;
    for (let i = 0; i < liveBars.length; i++) {
      // Low frequencies get more bars, like a real spectrum display.
      const a = Math.floor(Math.pow(i / liveBars.length, 1.6) * 90);
      const b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / liveBars.length, 1.6) * 90));
      let v = 0;
      for (let j = a; j < b; j++) v = Math.max(v, freqData[j]);
      liveBars[i].style.transform = `scaleY(${Math.max(0.04, v / 255).toFixed(3)})`;
    }
  }

  if (ts - lastSlow > 250) {
    lastSlow = ts;
    slowUpdate();
  }
}
requestAnimationFrame(frame);

function slowUpdate() {
  const st = S.state;
  if (S.role === 'listener') setIslandStatus(syncStatus());
  if (S.scheduler) {
    for (const el of $$('.diag')) {
      const st2 = S.scheduler.stats;
      el.textContent = `drift ${(Math.abs(st2.err) < 0.05 ? 0 : st2.err).toFixed(1)} ms · resyncs ${st2.resyncs} · ping ${S.clock.rtt == null ? '–' : Math.round(S.clock.rtt)} ms`;
    }
  }
  // Song position (host)
  if (S.role === 'host' && st && st.track && S.file && S.file.buffer) {
    const pos = S.file.positionAt(S.clock.now());
    const dur = S.file.duration;
    if (!S.seeking) {
      $('#t-pos').textContent = fmtTime(Math.min(pos, dur));
      $('#seek').value = dur ? Math.round((Math.min(pos, dur) / dur) * 1000) : 0;
      paintBar($('#seek').closest('[data-bar]'));
    }
    const key = st.playback.startAt;
    if (st.playback.playing && !st.live.on && pos >= dur + 0.3 && S.stopSentFor !== key) {
      S.stopSentFor = key;
      send({ type: 'stop' });
    }
  }
  // Song position (listener): big thin elapsed time on the card
  if (S.role === 'listener' && st && st.track && !st.live.on && S.file && S.file.buffer && !S.loadingId) {
    const dur = S.file.duration;
    const pos = Math.min(S.file.positionAt(S.clock.now()), dur);
    $('#np-fill').style.width = `${dur ? (pos / dur) * 100 : 0}%`;
    $('#card-big').textContent = fmtTime(pos);
    $('#np-dur').textContent = `-${fmtTime(dur - pos)}`;
  }
  // iOS/Android can suspend audio (calls, locking the screen). Offer a tap to resume.
  const suspended = !!(S.role && S.ctx && S.ctx.state !== 'running');
  $('#resume').hidden = !(suspended && S.role === 'listener');
  if (S.role === 'host') {
    setIslandStatus(suspended && S.playLocal ? { cls: 'meh', text: 'Click anywhere for sound' } : null);
  }
}

// ------------------------------------------------------------- Live capture

async function startLive() {
  if (!canShareTab) {
    toast('Needs Chrome on a computer');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        suppressLocalAudioPlayback: true,
      },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      preferCurrentTab: false,
    });
  } catch (err) {
    if (err && err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
      toast('Couldn’t share. Try again.');
    }
    return;
  }
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) {
    stream.getTracks().forEach((t) => t.stop());
    toast('No sound shared. Pick a tab and keep audio on.', 6000);
    return;
  }
  try {
    if (!S.workletReady) {
      await S.ctx.audioWorklet.addModule('/capture-worklet.js');
      S.workletReady = true;
    }
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    toast('Open this page at localhost to stream', 6000);
    return;
  }
  S.ctx.resume?.();

  const src = S.ctx.createMediaStreamSource(new MediaStream([audioTrack]));
  const node = new AudioWorkletNode(S.ctx, 'capture-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { chunk: 2048, channels: 2 },
  });
  const sink = S.ctx.createGain();
  sink.gain.value = 0;
  const analyser = S.ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.7;
  src.connect(node);
  src.connect(analyser);
  node.connect(sink);
  sink.connect(S.ctx.destination);

  const videoTrack = stream.getVideoTracks()[0];
  const surface = videoTrack && videoTrack.getSettings ? videoTrack.getSettings().displaySurface : 'browser';
  const cap = {
    stream,
    src,
    node,
    sink,
    analyser,
    seq: 0,
    t: null,
    silentSince: null,
    label: surface === 'monitor' ? 'your screen' : surface === 'window' ? 'a window' : 'a browser tab',
  };
  node.port.onmessage = (e) => onCaptured(cap, e.data);
  for (const t of stream.getTracks()) {
    t.addEventListener('ended', () => {
      if (S.capture === cap) stopLive();
    });
  }
  S.capture = cap;

  if (surface !== 'browser' && S.playLocal) {
    // Whole-screen audio still plays from this computer's speakers, so playing
    // it here a second time would echo.
    setPlayLocal(false);
    toast('Sound here turned off to avoid echo', 5000);
  }
  send({ type: 'live', on: true });
  render();
}

function onCaptured(cap, ab) {
  if (S.capture !== cap) return;
  const ch = 2;
  const pcm = new Int16Array(ab);
  const frames = pcm.length / ch;
  const sr = S.ctx.sampleRate;
  const durMs = (frames / sr) * 1000;

  // Timestamp = server time this chunk started, kept on a smooth sample-count
  // timeline and gently steered toward the wall clock.
  const est = S.clock.now() - durMs;
  if (cap.t === null) cap.t = est;
  else {
    const diff = est - cap.t;
    if (Math.abs(diff) > 250) cap.t = est;
    else cap.t += diff * 0.01;
  }
  const packet = packLive({ seq: cap.seq++, t: cap.t, sampleRate: sr, channels: ch, pcm });
  cap.t += durMs;

  if (S.ws && S.ws.readyState === 1) S.ws.send(packet);
  if (S.state && S.state.live.on) S.live.handle(packet);
}

function stopLive({ notify = true } = {}) {
  const cap = S.capture;
  if (!cap) return;
  S.capture = null;
  cap.node.port.onmessage = null;
  cap.stream.getTracks().forEach((t) => t.stop());
  try {
    cap.src.disconnect();
    cap.node.disconnect();
    cap.sink.disconnect();
  } catch {}
  for (const b of liveBars) b.style.transform = 'scaleY(0.04)';
  liveSilent.hidden = true;
  if (notify) send({ type: 'live', on: false });
  render();
}

function setPlayLocal(on) {
  S.playLocal = on;
  if (S.out) S.out.gain.value = on ? 1 : 0;
  render();
}

// --------------------------------------------------------------- File upload

function uploadFile(f) {
  if (f.size > 80 * 1024 * 1024) {
    toast('File too big (max 80 MB)');
    return;
  }
  if (S.capture) stopLive();
  const name = f.name.replace(/\.[^.]+$/, '') || 'Untitled';
  S.upload = { name, pct: 0 };
  render();
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/upload?room=${encodeURIComponent(S.room)}&name=${encodeURIComponent(name)}`);
  xhr.setRequestHeader('Content-Type', f.type || 'application/octet-stream');
  xhr.setRequestHeader('X-Host-Key', S.hostKey);
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable && S.upload) {
      S.upload.pct = e.loaded / e.total;
      render();
    }
  };
  xhr.onload = () => {
    S.upload = null;
    if (xhr.status !== 200) {
      let msg = 'Upload failed. Try again.';
      try {
        msg = JSON.parse(xhr.responseText).error || msg;
      } catch {}
      toast(msg);
    }
    render();
  };
  xhr.onerror = () => {
    S.upload = null;
    toast('Upload failed. Try again.');
    render();
  };
  xhr.send(f);
}

// -------------------------------------------------------------- Invite link

async function setupInvite() {
  let base = location.origin;
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (isLocal) {
    try {
      const info = await (await fetch('/api/info')).json();
      if (info.lan && info.lan.length) base = info.lan[0];
    } catch {}
  }
  S.inviteLink = `${base}/?r=${S.room}`;
  const qrSrc = `/qr.svg?text=${encodeURIComponent(S.inviteLink)}`;
  $('#qr').src = qrSrc;
  $('#bigqr-img').src = qrSrc;
  $('#bigqr-link').textContent = `or go to ${base.replace(/^https?:\/\//, '')} and enter`;
  $('#bigqr-code').textContent = S.room;
  $('#copy-link-text').textContent = canShare() ? 'Share link' : 'Copy link';
}

function canShare() {
  return typeof navigator.share === 'function' && /Android|iPhone|iPad/.test(navigator.userAgent);
}

// Full-screen QR code to point at the room.
let bigQrReturnFocus = null;
function openBigQr() {
  if (!S.inviteLink) return;
  bigQrReturnFocus = document.activeElement;
  $('#bigqr').hidden = false;
  $('#bigqr-close').focus();
}
function closeBigQr() {
  if ($('#bigqr').hidden) return;
  $('#bigqr').hidden = true;
  if (bigQrReturnFocus && bigQrReturnFocus.focus) bigQrReturnFocus.focus();
}

// ------------------------------------------------------------- Join / leave

function startSession(role, room, hostKey) {
  setupAudio();
  S.role = role;
  S.room = room;
  S.hostKey = hostKey || null;
  S.leaving = false;
  S.state = null;
  S.members = [];
  if (role === 'host') S.tab = canShareTab ? 'live' : 'file';
  S.out.gain.value = role === 'host' && !S.playLocal ? 0 : 1;
  if (role === 'listener') setIslandStatus({ cls: '', text: 'Joining…' });
  connect();
}

function leave() {
  S.leaving = true;
  stopLive({ notify: false });
  if (S.ws) {
    try {
      S.ws.close();
    } catch {}
  }
  S.ws = null;
  stopPings();
  if (S.scheduler) S.scheduler.stopAll();
  if (S.file) S.file.clear();
  if (S.role === 'host') session.set('js.host', null);
  S.role = null;
  S.state = null;
  S.loadingId = null;
  S.loadError = null;
  if (S.wakeLock) S.wakeLock.release().catch(() => {});
  history.replaceState(null, '', '/');
  airBlend = 0;
  closeSheet();
  showScreen('home');
  renderHome();
}

function renderHome() {
  const saved = session.get('js.host', null);
  const btn = $('#resume-host-btn');
  btn.hidden = !saved;
  if (saved) btn.querySelector('b').textContent = saved.room;
}

// ------------------------------------------------------------------ Wiring

const codeInput = $('#code-input');
const otpCells = $$('[data-otp] .otp-cell');
// Phones get an automatic name (e.g. "iPhone 42"), remembered between visits.
const deviceName = local.get('js.name', '') || defaultName();
local.set('js.name', deviceName);

function paintOtp() {
  const v = codeInput.value;
  const focused = document.activeElement === codeInput;
  otpCells.forEach((c, i) => {
    c.textContent = v[i] || '';
    c.classList.toggle('filled', !!v[i]);
    c.classList.toggle('active', focused && i === v.length);
  });
}

const params = new URLSearchParams(location.search);
if (params.get('r')) {
  codeInput.value = params.get('r').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  $('#home .panel-title').textContent = 'Join the party';
}
paintOtp();

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  paintOtp();
});
for (const ev of ['focus', 'blur', 'keyup', 'click']) codeInput.addEventListener(ev, paintOtp);

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 4) {
    toast('Enter the 4-letter code');
    codeInput.focus();
    return;
  }
  S.name = deviceName;
  startSession('listener', code);
});

$('#host-btn').addEventListener('click', () => {
  S.name = 'Host';
  startSession('host', null);
});

$('#resume-host-btn').addEventListener('click', () => {
  const saved = session.get('js.host', null);
  if (!saved) return;
  S.name = 'Host';
  startSession('host', saved.room, saved.hostKey);
});

// Settings sheet (host) / Timing sheet (phones)
let sheetReturnFocus = null;
function openSheet() {
  sheetReturnFocus = document.activeElement;
  const host = S.role === 'host';
  for (const el of $$('#settings .host-only')) el.hidden = !host;
  if (host) $('#delay-field').hidden = S.tab !== 'live' && !(S.state && S.state.live.on);
  $('#settings-title').textContent = host ? 'Settings' : 'Timing';
  $('#settings').hidden = false;
  $('#settings-close').focus();
}
function closeSheet() {
  if ($('#settings').hidden) return;
  $('#settings').hidden = true;
  if (sheetReturnFocus && sheetReturnFocus.focus) sheetReturnFocus.focus();
}
$('#settings-btn').addEventListener('click', openSheet);
$('#timing-btn').addEventListener('click', openSheet);
$('#settings-close').addEventListener('click', closeSheet);
$('#settings').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeSheet();
});

for (const b of $$('[data-leave]')) {
  b.addEventListener('click', () => {
    if (S.role === 'host' && !confirm('End the party? Phones will stop getting music from this device.')) return;
    leave();
  });
}

for (const b of $$('.seg [data-tab]')) {
  b.addEventListener('click', () => {
    S.tab = b.dataset.tab;
    renderHost();
  });
}

$('#live-start').addEventListener('click', () => startLive());
$('#live-stop').addEventListener('click', () => stopLive());

for (const input of $$('.file-input')) {
  input.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) uploadFile(f);
  });
}

$('#restart-btn').addEventListener('click', () => {
  if (!S.state || !S.state.track) return;
  S.ctx.resume?.();
  if (S.capture) stopLive();
  send({ type: 'play', offset: 0 });
});

$('#play-btn').addEventListener('click', () => {
  const st = S.state;
  if (!st || !st.track) return;
  S.ctx.resume?.();
  if (st.playback.playing && !st.live.on) {
    send({ type: 'pause' });
  } else {
    if (S.capture) stopLive();
    const atEnd = S.file.duration && st.playback.offset >= S.file.duration - 0.25;
    send({ type: 'play', offset: atEnd ? 0 : undefined });
  }
});

const seek = $('#seek');
seek.addEventListener('input', () => {
  S.seeking = true;
  $('#t-pos').textContent = fmtTime((seek.value / 1000) * S.file.duration);
  paintBar(seek.closest('[data-bar]'));
});
seek.addEventListener('change', () => {
  S.seeking = false;
  send({ type: 'seek', offset: (seek.value / 1000) * S.file.duration });
});

const delay = $('#delay');
delay.addEventListener('input', () => {
  $('#delay-val').textContent = fmtDelay(Number(delay.value));
  paintBar(delay.closest('[data-bar]'));
});
delay.addEventListener('change', () => send({ type: 'set', delay: Number(delay.value) }));

$('#beeps-btn').addEventListener('click', () => {
  S.ctx.resume?.();
  send({ type: 'beeps' });
});

$('#local-toggle').addEventListener('change', (e) => setPlayLocal(e.target.checked));
$('#loud-toggle').addEventListener('change', (e) => send({ type: 'set', loud: e.target.checked }));

// Timing fine-tune slider, shared by host and listener screens.
const tpl = $('#nudge-tpl');
for (const slot of $$('[data-nudge]')) {
  slot.append(tpl.content.cloneNode(true));
  const input = slot.querySelector('.nudge');
  const val = slot.querySelector('.nudge-val');
  const bar = slot.querySelector('[data-bar]');
  const show = (v) => (val.textContent = `${v > 0 ? '+' : ''}${v} ms`);
  const saved = local.get('js.nudge', 0);
  input.value = saved;
  show(saved);
  paintBar(bar);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    show(v);
    paintBar(bar);
    if (S.scheduler) S.scheduler.nudgeMs = v;
    local.set('js.nudge', v);
  });
  input.addEventListener('change', sendStatus);
}
for (const bar of $$('[data-bar]')) paintBar(bar);

$('#resume-btn').addEventListener('click', () => {
  if (!S.ctx) return;
  setupAudio();
  S.ctx.resume?.().then(() => ($('#resume').hidden = true));
});

$('#copy-link').addEventListener('click', async () => {
  if (!S.inviteLink) return;
  if (canShare()) {
    try {
      await navigator.share({ title: 'Join my Joint Speaker party', text: `Party code ${S.room}`, url: S.inviteLink });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(S.inviteLink);
    toast('Link copied');
  } catch {
    toast(S.inviteLink, 8000);
  }
});

$('#qr-open').addEventListener('click', openBigQr);
$('#show-room').addEventListener('click', openBigQr);
$('#bigqr-close').addEventListener('click', closeBigQr);
$('#bigqr').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeBigQr();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeBigQr();
    closeSheet();
  }
});

// A party started without a click (from the launcher) has its sound off until
// the first click anywhere — browsers require that.
document.addEventListener('pointerdown', () => {
  if (S.ctx && S.ctx.state !== 'running') setupAudio();
}, true);

renderHome();

// Opened by "Start Joint Speaker" on the Mac: go straight into a new party.
if (params.has('host')) {
  S.name = 'Host';
  startSession('host', null);
}
