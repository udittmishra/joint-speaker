import {
  Clock,
  Scheduler,
  LiveReceiver,
  FilePlayer,
  packLive,
  unlockAudio,
  decodeAudio,
} from './audio.js';

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
const canShareTab = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) &&
  !/Android|iPhone|iPad/.test(navigator.userAgent);

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
const PALETTES = [
  ['#3B6FE0', '#F09199', '#A066B0', '#141830'], // iridescent
  ['#FF9F43', '#FF4F5E', '#B23A8A', '#2A0F24'], // solar
  ['#2BC4C4', '#3B6FE0', '#9BE7D8', '#08202B'], // lagoon
  ['#C86DD7', '#6E56CF', '#F7A8C8', '#1B1030'], // orchid
  ['#3DDC97', '#1FA2A6', '#D7F171', '#0B231C'], // emerald
];
const PALETTE_SECONDS = 20;
let paletteIdx = -1;

const BLOB_HTML = '<span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span><span class="blob b4"></span><span class="grain"></span>';
const meshes = $$('[data-mesh]').map((el) => {
  el.innerHTML = BLOB_HTML;
  return { el, blobs: [...el.querySelectorAll('.blob')] };
});

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
  const bgVisible = document.body.dataset.screen !== 'host';
  // Read visibility for every mesh first, then write, so the browser never
  // has to recalculate styles in the middle of the loop.
  const visible = meshes.filter(
    (m) => m.el.offsetParent && (bgVisible || !m.el.parentElement.classList.contains('bg'))
  );
  for (const m of visible) {
    m.blobs.forEach((b, i) => {
      const k = i + 1;
      const x = 32 * Math.sin(t * 0.21 * speed * k + i * 1.7);
      const y = 28 * Math.cos(t * 0.17 * speed * (k + 0.3) + i * 2.3);
      const s = 1 + 0.18 * Math.sin(t * 0.29 + i * 1.1) + energy * 0.12;
      b.style.transform = `translate(${x.toFixed(2)}%, ${y.toFixed(2)}%) scale(${s.toFixed(3)})`;
    });
  }
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
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.5;
  out.connect(analyser);
  analyser.connect(ctx.destination);
  S.ctx = ctx;
  S.out = out;
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
      if (S.role === 'listener') toast('Sync test: listen for the clicks');
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
      S.loadError = "This device couldn't open that song. MP3 and M4A files work on every phone.";
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

function renderHost() {
  const st = S.state;
  if (!st) return;
  const cells = $('#host-code').children;
  for (let i = 0; i < 4; i++) cells[i].textContent = st.room[i] || '·';
  $('#host-code').setAttribute('aria-label', `Party code ${st.room.split('').join(' ')}`);
  $('#speaker-count').textContent = st.speakers;

  // Source tabs
  $('.seg').dataset.active = S.tab;
  for (const b of $$('.seg [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
  $('#tab-live').hidden = S.tab !== 'live';
  $('#tab-file').hidden = S.tab !== 'file';
  const playingFile = st.track && st.playback.playing && !st.live.on;
  $('#source-status').textContent = st.live.on ? 'Streaming' : playingFile ? 'Playing' : '';

  // Live
  const sharing = !!S.capture;
  $('#live-idle').hidden = sharing;
  $('#live-on').hidden = !sharing;
  $('#live-start').hidden = !canShareTab;
  $('#live-unsupported').hidden = canShareTab;
  $('#live-delay-note').textContent = `${(st.delay / 1000).toFixed(1)} s`;

  // File
  $('#upload-box').hidden = !S.upload;
  if (S.upload) {
    $('#upload-name').textContent = S.upload.name;
    $('#upload-meter').style.width = `${Math.round(S.upload.pct * 100)}%`;
  }
  $('#file-pick-text').textContent = st.track ? 'Choose a different song' : 'Choose a song';
  const hasTrack = !!st.track && !S.upload;
  $('#track-box').hidden = !hasTrack;
  if (hasTrack) {
    $('#track-name').textContent = st.track.name;
    const { ready, total } = readyCount();
    let readyText = `Ready on ${ready} of ${total} speakers`;
    if (S.loadingId) readyText = `Loading on this device… ${Math.round(S.loadPct * 100)}%`;
    if (S.loadError) readyText = S.loadError;
    if (st.live.on) readyText = 'Paused while you stream a tab';
    $('#track-ready').textContent = readyText;
    const pb = $('#play-btn');
    pb.classList.toggle('playing', !!playingFile);
    pb.setAttribute('aria-label', playingFile ? 'Pause' : 'Play');
    pb.disabled = !S.file.buffer;
    $('#t-dur').textContent = fmtTime(S.file.duration);
    $('#seek').disabled = !S.file.buffer;
  }

  // Sync
  $('#delay-field').hidden = S.tab !== 'live' && !st.live.on;
  if (document.activeElement !== $('#delay')) {
    $('#delay').value = st.delay;
    $('#delay-val').textContent = `${st.delay} ms`;
    paintBar($('#delay').closest('[data-bar]'));
  }
  $('#local-toggle').checked = S.playLocal;
}

function renderMembers() {
  const ul = $('#member-list');
  ul.textContent = '';
  const st = S.state;
  const list = [...S.members].sort((a, b) => (b.host ? 1 : 0) - (a.host ? 1 : 0));
  for (const m of list) {
    const li = document.createElement('li');

    const av = document.createElement('span');
    av.className = 'avatar';
    av.style.setProperty('--h', hashHue(m.name || m.id));
    av.textContent = (m.name || '?').trim().charAt(0).toUpperCase();

    const main = document.createElement('span');
    main.className = 'm-main';
    const name = document.createElement('span');
    name.className = 'm-name';
    name.textContent = m.name;
    const sub = document.createElement('span');
    sub.className = 'm-sub';
    const bits = [];
    if (m.host) bits.push('This device');
    if (st && st.track && !st.live.on) bits.push(m.ready === st.track.id ? 'Song ready' : 'Loading song…');
    if (!bits.length) bits.push(st && st.live.on ? 'Streaming' : 'Connected');
    sub.textContent = bits.join(' · ');
    main.append(name, sub);

    const sig = document.createElement('span');
    const level = m.rtt == null ? 0 : m.rtt < 80 ? 3 : m.rtt < 250 ? 2 : 1;
    sig.className = `signal s${level}`;
    sig.innerHTML = '<i></i><i></i><i></i>';
    sig.title = m.rtt == null ? 'Measuring' : `${m.rtt} ms ping`;

    const ping = document.createElement('span');
    ping.className = 'm-ping mono';
    ping.textContent = m.rtt == null ? '–' : `${m.rtt} ms`;

    li.append(av, main, sig, ping);
    ul.append(li);
  }
  if (list.length <= 1) {
    const li = document.createElement('li');
    li.className = 'member-empty';
    li.innerHTML = 'No phones yet. Have friends scan the <b>QR code</b> or type the <b>party code</b>.';
    ul.append(li);
  }
}

function renderListener() {
  const st = S.state;
  if (!st) return;
  let label = 'Waiting for the host';
  let title = 'Nothing playing yet';
  if (st.live.on) {
    label = 'Live from the host';
    title = 'Streaming';
  } else if (st.track) {
    if (S.loadingId) {
      label = 'Getting the song';
      title = `${Math.round(S.loadPct * 100)}%`;
    } else if (S.loadError) {
      label = 'Problem';
      title = S.loadError;
    } else {
      label = st.playback.playing ? 'Now playing' : 'Paused';
      title = st.track.name;
    }
  }
  if (!st.hostOnline && !st.live.on && !(st.playback.playing && st.track)) {
    label = 'Host disconnected';
    title = 'Waiting for them to come back';
  }
  $('#now-label').textContent = label;
  $('#now-title').textContent = title;
  $('#now-meta').textContent = `Party ${st.room} · ${st.speakers} speaker${st.speakers === 1 ? '' : 's'}`;
}

function syncStatus() {
  const c = S.clock;
  if (!S.connected) return { cls: 'bad', text: 'Reconnecting…' };
  if (!c.synced) return { cls: '', text: 'Syncing clocks…' };
  const ms = Math.round(c.rtt);
  if (c.rtt > 250) return { cls: 'bad', text: `Weak Wi-Fi · ${ms} ms` };
  if (c.rtt > 80) return { cls: 'meh', text: `In sync · ${ms} ms` };
  return { cls: 'good', text: `In sync · ${ms} ms` };
}

// ------------------------------------------------------------ Frame loop

const stageOrb = $('.orb-stage');
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

  // Output loudness drives the orb.
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

  if (S.role === 'listener') {
    // Set on the orb itself, not <body>, so only the orb restyles each frame.
    stageOrb.style.setProperty('--pump', (1 + l * 0.06).toFixed(4));
    stageOrb.style.setProperty('--glow', l.toFixed(3));
    const onAir = isOnAir() && S.clock.synced;
    if (onAir !== document.body.classList.contains('on-air')) document.body.classList.toggle('on-air', onAir);
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
  // iOS/Android can suspend audio (calls, locking the screen). Offer a tap to resume.
  const suspended = !!(S.role && S.ctx && S.ctx.state !== 'running');
  $('#resume').hidden = !(suspended && S.role === 'listener');
  if (S.role === 'host') {
    setIslandStatus(suspended && S.playLocal
      ? { cls: 'meh', text: 'Click anywhere to turn on this computer’s sound' }
      : null);
  }
}

// ------------------------------------------------------------- Live capture

async function startLive() {
  if (!canShareTab) {
    toast('Sharing a tab needs Chrome, Edge or Brave on a computer.');
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
      toast(`Couldn't start sharing: ${err.message}`);
    }
    return;
  }
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) {
    stream.getTracks().forEach((t) => t.stop());
    toast('That share had no sound. Pick a Chrome tab and leave "Also share tab audio" on.', 6000);
    return;
  }
  try {
    if (!S.workletReady) {
      await S.ctx.audioWorklet.addModule('/capture-worklet.js');
      S.workletReady = true;
    }
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    toast('Streaming only works when this page is opened at http://localhost or over https.', 6000);
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
  $('#live-label').textContent = cap.label;

  if (surface !== 'browser' && S.playLocal) {
    // Whole-screen audio still plays from this computer's speakers, so playing
    // it here a second time would echo.
    setPlayLocal(false);
    toast('This computer already plays the original sound, so it won’t play the synced copy.', 6000);
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
    toast('That file is over 80 MB. Pick a smaller song file.');
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
    toast('Upload failed. Check this device is still connected to the party, then try again.');
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
  const isLan = isLocal || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(location.hostname);
  $('#wifi-note').hidden = !isLan;
  S.inviteLink = `${base}/?r=${S.room}`;
  const qrSrc = `/qr.svg?text=${encodeURIComponent(S.inviteLink)}`;
  $('#invite-link').textContent = S.inviteLink.replace(/^https?:\/\//, '');
  $('#qr').src = qrSrc;
  $('#bigqr-img').src = qrSrc;
  $('#bigqr-link').textContent = base.replace(/^https?:\/\//, '');
  $$('#bigqr-cells span').forEach((s, i) => (s.textContent = S.room[i]));
  $('#bigqr-cells').setAttribute('aria-label', `Party code ${S.room.split('').join(' ')}`);
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
  stageOrb.style.setProperty('--pump', 1);
  stageOrb.style.setProperty('--glow', 0);
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
const nameInput = $('#name-input');
const otpCells = $$('[data-otp] .otp-cell');
nameInput.value = S.name;

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
  // Arrived from an invite: put the join form within thumb reach.
  $('#home').classList.add('invited');
  $('#home h1').innerHTML = 'You’re invited.<br><span class="grad-text">Join in.</span>';
}
paintOtp();

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  paintOtp();
  if (codeInput.value.length === 4 && !nameInput.value) nameInput.focus();
});
for (const ev of ['focus', 'blur', 'keyup', 'click']) codeInput.addEventListener(ev, paintOtp);

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 4) {
    toast('Party codes are 4 letters. Ask the host for theirs.');
    codeInput.focus();
    return;
  }
  S.name = nameInput.value.trim() || defaultName();
  local.set('js.name', nameInput.value.trim());
  startSession('listener', code);
});

$('#host-btn').addEventListener('click', () => {
  S.name = nameInput.value.trim() || 'Host';
  startSession('host', null);
});

$('#resume-host-btn').addEventListener('click', () => {
  const saved = session.get('js.host', null);
  if (!saved) return;
  S.name = nameInput.value.trim() || 'Host';
  startSession('host', saved.room, saved.hostKey);
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

$('#file-input').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) uploadFile(f);
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
  $('#delay-val').textContent = `${delay.value} ms`;
  paintBar(delay.closest('[data-bar]'));
});
delay.addEventListener('change', () => send({ type: 'set', delay: Number(delay.value) }));

$('#beeps-btn').addEventListener('click', () => {
  S.ctx.resume?.();
  send({ type: 'beeps' });
});

$('#local-toggle').addEventListener('change', (e) => setPlayLocal(e.target.checked));

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
    toast('Invite link copied');
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
  if (e.key === 'Escape') closeBigQr();
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
