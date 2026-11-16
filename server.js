// Joint Speaker — sync server.
// Serves the web app, keeps a shared clock, relays live audio to every phone
// in the room, and stores uploaded songs for file playback.
//
// Three kinds of connection:
//   host     — runs the party (a laptop browser, or the iPhone app's page)
//   listener — a phone that plays along
//   source   — the iPhone app's screen-broadcast extension, which sends the
//              sound of whatever app is playing (Spotify, YouTube…). It proves
//              it belongs to the party with the host key.
//
// A party can also be a Spotify speaker (spotify.js), when this computer has
// librespot: Spotify plays into the server and every phone plays it together.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { SpotifySpeaker, findLibrespot } from './spotify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const MB = 1024 * 1024;
// Limits that keep one busy party (or one bad actor) from sinking a shared server.
const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 80) * MB; // one song
const MAX_TOTAL_UPLOAD_BYTES = (Number(process.env.MAX_TOTAL_UPLOAD_MB) || 300) * MB; // all songs in memory
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 300;
const MAX_ROOM_SPEAKERS = Number(process.env.MAX_ROOM_SPEAKERS) || 40;
const ROOMS_PER_IP_PER_HOUR = Number(process.env.ROOMS_PER_IP_PER_HOUR) || 20;
const LIBRESPOT = findLibrespot();
const SPOTIFY_CACHE = path.join(os.homedir(), '.joint-speaker', 'spotify'); // the Spotify sign-in
const MAX_SPOTIFY_SPEAKERS = Number(process.env.MAX_SPOTIFY_SPEAKERS) || 3;
const MAX_MESSAGES_PER_SECOND = 60; // text messages; audio packets are checked separately
// Behind a hosting provider's proxy (Render, Railway, Fly…) the visitor's
// address arrives in X-Forwarded-For instead of on the socket.
const TRUST_PROXY = !!(process.env.TRUST_PROXY || process.env.RENDER || process.env.FLY_APP_NAME || process.env.RAILWAY_ENVIRONMENT);
const PLAY_LEAD_MS = 1000; // how far in the future a "play" starts, so every phone can schedule it
const SEEK_LEAD_MS = 700;
const PAUSE_LEAD_MS = 250;
const MAX_CLIENT_BACKLOG = 1 << 20; // skip live packets for phones that can't keep up
// While an iPhone streams, Spotify already plays on that iPhone, so the other
// phones play as soon after it as the network allows. Each phone reports the
// smallest delay that would have played its recent sound in time; the party
// uses the largest of those plus a little headroom.
const FAST_START_MS = 350; // until the phones have reported
const FAST_HEADROOM_MS = 25;
const FAST_MIN_MS = 40;
const FAST_SETTLE_MS = 8000; // jump straight to the measured delay this soon after going live

/** Server clock: milliseconds, sub-ms precision. Every device syncs to this. */
const now = () => performance.timeOrigin + performance.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/** @type {Map<string, Room>} */
const rooms = new Map();

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = {
    code: makeCode(),
    hostKey: crypto.randomBytes(16).toString('hex'),
    host: null,
    clients: new Set(),
    source: null, // the iPhone app's broadcast extension, when it's connected
    spotify: null, // a SpotifySpeaker while the party is a Spotify speaker
    spotifyPlaying: false,
    delay: 1000, // the host's choice, for a laptop sharing a tab
    fastDelay: FAST_START_MS, // set automatically while an iPhone streams
    fastSince: 0,
    fastChangedAt: 0,
    loud: false, // Loud mode: every phone runs a loudness boost on the audio
    live: { on: false, by: null }, // by: 'host' (tab share) or 'source' (iPhone)
    track: null, // { id, name, type, data }
    playback: { playing: false, startAt: 0, offset: 0, pauseAt: 0 },
    emptySince: null,
    membersTimer: null,
  };
  rooms.set(room.code, room);
  return room;
}

function currentPos(room, at = now()) {
  const pb = room.playback;
  if (!pb.playing) return pb.offset;
  return pb.offset + Math.max(0, at - pb.startAt) / 1000;
}

function publicState(room) {
  return {
    room: room.code,
    delay: liveDelay(room),
    loud: room.loud,
    live: room.live,
    source: !!room.source,
    spotify: {
      available: !!LIBRESPOT,
      on: !!room.spotify,
      name: spotifyName(room),
      playing: room.spotifyPlaying,
    },
    track: room.track
      ? { id: room.track.id, name: room.track.name, url: `/track/${room.code}/${room.track.id}` }
      : null,
    playback: room.playback,
    hostOnline: !!room.host,
    speakers: room.clients.size + (room.host ? 1 : 0),
  };
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function everyone(room) {
  const list = [...room.clients];
  if (room.host) list.push(room.host);
  return list;
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const ws of everyone(room)) if (ws.readyState === 1) ws.send(data);
}

function broadcastState(room) {
  broadcast(room, { type: 'state', state: publicState(room) });
  queueMembers(room);
}

function queueMembers(room) {
  if (room.membersTimer) return;
  room.membersTimer = setTimeout(() => {
    room.membersTimer = null;
    if (!room.host) return;
    const members = everyone(room).map((ws) => ({
      id: ws.info.id,
      name: ws.info.name,
      host: ws === room.host,
      rtt: ws.info.rtt,
      ready: ws.info.ready,
      nudge: ws.info.nudge,
    }));
    send(room.host, { type: 'members', members });
  }, 300);
}

function isEmpty(room) {
  return !room.host && !room.source && room.clients.size === 0;
}

function leaveRoom(ws) {
  const room = rooms.get(ws.info.room);
  if (!room) return;
  if (room.host === ws) room.host = null;
  if (room.source === ws) {
    room.source = null;
    if (room.live.by === 'source') room.live = { on: false, by: null };
  }
  room.clients.delete(ws);
  if (isEmpty(room)) room.emptySince = Date.now();
  broadcastState(room);
}

/**
 * Live sound that nobody hears first — the iPhone's broadcast (Spotify already
 * plays there) or the Spotify speaker (everyone plays the same copy) — plays
 * as soon after capture as the phones allow.
 */
const isFast = (by) => by === 'source' || by === 'spotify';

/** How long after capture every phone plays live sound. */
function liveDelay(room) {
  return room.live.on && isFast(room.live.by) ? room.fastDelay : room.delay;
}

const spotifyName = (room) => `Joint Speaker ${room.code}`;

/** Make the party a Spotify speaker: it appears in Spotify's list of speakers. */
function startSpotify(room) {
  if (room.spotify) return true;
  if (!LIBRESPOT) return false;
  let running = 0;
  for (const r of rooms.values()) if (r.spotify) running++;
  if (running >= MAX_SPOTIFY_SPEAKERS) return false;
  const speaker = new SpotifySpeaker({
    bin: LIBRESPOT,
    name: spotifyName(room),
    cacheDir: SPOTIFY_CACHE,
    now,
    onPacket: (packet) => {
      if (!(room.live.on && room.live.by === 'spotify')) return;
      // Every phone plays it — the host's too, since nobody hears Spotify directly.
      for (const c of everyone(room)) {
        if (c.readyState === 1 && c.bufferedAmount < MAX_CLIENT_BACKLOG) c.send(packet, { binary: true });
      }
    },
    onPlaying: (playing) => {
      room.spotifyPlaying = playing;
      broadcastState(room);
    },
    onExit: () => {
      if (room.spotify !== speaker) return;
      room.spotify = null;
      room.spotifyPlaying = false;
      if (room.live.by === 'spotify') room.live = { on: false, by: null };
      broadcastState(room);
    },
  });
  room.spotify = speaker;
  speaker.start();
  setLive(room, true, 'spotify');
  return true;
}

function stopSpotify(room) {
  const speaker = room.spotify;
  if (!speaker) return;
  room.spotify = null;
  room.spotifyPlaying = false;
  speaker.stop();
}

function deleteRoom(code, room) {
  stopSpotify(room);
  rooms.delete(code);
}

/** Turn live streaming on or off. Turning it off tells the iPhone to end its broadcast. */
function setLive(room, on, by, t = now()) {
  const wasSource = room.live.on && room.live.by === 'source';
  const wasBy = room.live.on ? room.live.by : null;
  if (on && isFast(by) && wasBy !== by) {
    room.fastDelay = FAST_START_MS;
    room.fastSince = t;
    room.fastChangedAt = t;
    for (const c of everyone(room)) c.info.need = null;
  }
  if (wasBy === 'spotify' && !(on && by === 'spotify')) stopSpotify(room);
  room.live = on ? { on: true, by } : { on: false, by: null };
  if (on && room.playback.playing) {
    room.playback = { playing: false, startAt: 0, offset: currentPos(room, t), pauseAt: t };
  }
  if (wasSource && !(on && by === 'source')) send(room.source, { type: 'stop' });
}

/**
 * Timing report while an iPhone streams (TIMING_LOG=1): how late iPhone hands
 * over its sound, what each phone needs, and the party's delay. For tuning.
 */
function noteCapture(room, cap) {
  const w = (room.capWindow ??= { min: Infinity, max: 0, gap: 0, frames: 0, rate: 0, since: now() });
  w.min = Math.min(w.min, Number(cap.minMs) || 0);
  w.max = Math.max(w.max, Number(cap.maxMs) || 0);
  w.gap = Math.max(w.gap, Number(cap.gapMs) || 0);
  w.frames = Number(cap.frames) || 0;
  w.rate = Number(cap.rate) || 0;
  if (!process.env.TIMING_LOG || now() - w.since < 2000) return;
  const needs = [...room.clients].map((c) => {
    const p = c.info.play || {};
    const need = c.info.need != null && now() - c.info.needAt < 4000 ? Math.round(c.info.need) : '–';
    return `${c.info.name || 'phone'} ${need} (audio ${p.ctx}, played ${p.played}, dropped ${p.drops}, skips ${p.resyncs}, speaker ${p.outMs} ms, gain ${p.gain})`;
  });
  console.log(
    `  [${room.code}] iPhone hands over ${w.frames}-frame chunks (${w.rate} Hz) ` +
      `${w.min.toFixed(0)}–${w.max.toFixed(0)} ms after they play, longest pause ${w.gap.toFixed(0)} ms` +
      ` · phones need ${needs.join(', ') || '–'} ms · delay ${liveDelay(room)} ms`,
  );
  room.capWindow = null;
}

/** While an iPhone streams: keep the delay as small as every phone can manage. */
function tuneFastDelay(room) {
  if (!(room.live.on && isFast(room.live.by))) return;
  const t = now();
  // The host plays the Spotify speaker too, so it counts; an iPhone's broadcast it doesn't.
  const players = room.live.by === 'spotify' ? everyone(room) : [...room.clients];
  const needs = players
    .filter((c) => c.info.need != null && t - c.info.needAt < 4000)
    .map((c) => c.info.need);
  if (!needs.length) return;
  const target = clamp(Math.round(Math.max(...needs) + FAST_HEADROOM_MS), FAST_MIN_MS, 3000);
  const d = room.fastDelay;
  let next = d;
  if (t - room.fastSince < FAST_SETTLE_MS) {
    next = target; // just went live: go straight to what the phones need
  } else if (target > d) {
    next = target + 15; // a phone was cutting out: give it room right away
  } else if (d - target > 20 && t - room.fastChangedAt > 3000) {
    // Creep closer, slowly: Wi-Fi delays come in bursts, and a delay that
    // dives after a calm spell cuts out at the next burst. Small steps also
    // glide in on every phone without a skip.
    next = d - 10;
  }
  if (next === d) return;
  room.fastDelay = next;
  room.fastChangedAt = t;
  broadcastState(room);
}

// ------------------------------------------------------------- Abuse limits

const roomsMadeBy = new Map(); // ip -> timestamps of rooms created in the last hour

function canCreateRoom(ip) {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const recent = (roomsMadeBy.get(ip) || []).filter((t) => t > hourAgo);
  roomsMadeBy.set(ip, recent);
  if (recent.length >= ROOMS_PER_IP_PER_HOUR) return false;
  if (rooms.size >= MAX_ROOMS) {
    // Make space by forgetting parties nobody is in any more.
    for (const [code, r] of rooms) if (isEmpty(r)) deleteRoom(code, r);
    if (rooms.size >= MAX_ROOMS) return false;
  }
  recent.push(Date.now());
  return true;
}

function storedSongBytes() {
  let total = 0;
  for (const r of rooms.values()) if (r.track) total += r.track.data.length;
  return total;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------- WebSocket

function handleHello(ws, m) {
  ws.info.name = String(m.name || 'Phone').slice(0, 24);
  ws.info.id = String(m.clientId || crypto.randomUUID()).slice(0, 64);

  let room;
  if (m.role === 'source') {
    room = m.room && rooms.get(String(m.room).toUpperCase());
    if (!room || room.hostKey !== m.hostKey) {
      send(ws, { type: 'error', code: 'no-room', message: 'That party has ended' });
      return;
    }
    if (room.source && room.source !== ws) {
      const old = room.source;
      old.info.room = null;
      try { old.close(4000, 'replaced'); } catch {}
    }
    room.source = ws;
    ws.info.role = 'source';
  } else if (m.role === 'host') {
    room = m.room && rooms.get(String(m.room).toUpperCase());
    if (!room || room.hostKey !== m.hostKey) {
      if (!canCreateRoom(ws.info.ip)) {
        send(ws, { type: 'error', code: 'busy', message: 'Too many parties right now. Try again soon.' });
        return;
      }
      room = createRoom();
    }
    if (room.host && room.host !== ws) {
      // Same host reconnecting from a new socket: retire the old one.
      const old = room.host;
      old.info.room = null;
      try { old.close(4000, 'replaced'); } catch {}
    }
    room.host = ws;
    ws.info.role = 'host';
  } else {
    room = m.room && rooms.get(String(m.room).toUpperCase());
    if (!room) {
      send(ws, { type: 'error', code: 'no-room', message: 'No party with that code' });
      return;
    }
    // Drop a stale socket for the same device, if it's still around.
    for (const other of room.clients) {
      if (other.info.id === ws.info.id && other !== ws) {
        room.clients.delete(other);
        other.info.room = null;
        try { other.close(4000, 'replaced'); } catch {}
      }
    }
    const speakers = room.clients.size + (room.host ? 1 : 0);
    if (speakers >= MAX_ROOM_SPEAKERS) {
      send(ws, { type: 'error', code: 'full', message: 'This party is full' });
      return;
    }
    room.clients.add(ws);
    ws.info.role = 'listener';
  }
  room.emptySince = null;
  ws.info.room = room.code;
  send(ws, {
    type: 'welcome',
    role: ws.info.role,
    room: room.code,
    hostKey: ws.info.role === 'host' ? room.hostKey : undefined,
    state: publicState(room),
  });
  broadcastState(room);
}

function handleHostCommand(room, m) {
  const t = now();
  switch (m.type) {
    case 'set':
      if (typeof m.delay === 'number') room.delay = clamp(Math.round(m.delay), 200, 5000);
      if (typeof m.loud === 'boolean') room.loud = m.loud;
      break;
    case 'live':
      // The iPhone app's page asks for 'source' (its broadcast extension);
      // a laptop sharing a tab streams itself.
      setLive(room, !!m.on, m.by === 'source' && room.source ? 'source' : 'host', t);
      break;
    case 'spotify':
      if (!m.on) {
        if (room.live.by === 'spotify') setLive(room, false, null, t);
        else stopSpotify(room);
      } else if (!startSpotify(room)) {
        send(room.host, LIBRESPOT
          ? { type: 'error', code: 'spotify-busy', message: 'Too many Spotify speakers on right now. Try again later.' }
          : { type: 'error', code: 'no-spotify', message: 'This server can’t be a Spotify speaker.' });
        return;
      }
      break;
    case 'play': {
      if (!room.track) return;
      setLive(room, false, null, t);
      const offset = typeof m.offset === 'number' ? m.offset : currentPos(room, t);
      room.playback = { playing: true, startAt: t + PLAY_LEAD_MS, offset: Math.max(0, offset), pauseAt: 0 };
      break;
    }
    case 'pause': {
      const at = t + PAUSE_LEAD_MS;
      room.playback = { playing: false, startAt: 0, offset: currentPos(room, at), pauseAt: at };
      break;
    }
    case 'seek': {
      const offset = Math.max(0, Number(m.offset) || 0);
      room.playback = room.playback.playing
        ? { playing: true, startAt: t + SEEK_LEAD_MS, offset, pauseAt: 0 }
        : { playing: false, startAt: 0, offset, pauseAt: 0 };
      break;
    }
    case 'stop':
      room.playback = { playing: false, startAt: 0, offset: 0, pauseAt: 0 };
      break;
    case 'beeps':
      broadcast(room, { type: 'beeps', at: t + 900, count: 12, interval: 500 });
      return;
    default:
      return;
  }
  broadcastState(room);
}

function onMessage(ws, data, isBinary) {
  const room = rooms.get(ws.info.room);

  if (isBinary) {
    // Live audio packet: fan it out untouched, but only from whoever is streaming.
    if (!room || !room.live.on) return;
    const streamer = room.live.by === 'source' ? room.source : room.host;
    if (ws !== streamer) return;
    for (const c of room.clients) {
      if (c.readyState === 1 && c.bufferedAmount < MAX_CLIENT_BACKLOG) c.send(data, { binary: true });
    }
    return;
  }

  // A device sends a few messages a second; ignore anything far beyond that.
  const sec = Math.floor(Date.now() / 1000);
  if (ws.info.rateSec !== sec) {
    ws.info.rateSec = sec;
    ws.info.rateCount = 0;
  }
  if (++ws.info.rateCount > MAX_MESSAGES_PER_SECOND) return;

  let m;
  try {
    m = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (!m || typeof m !== 'object') return;

  if (m.type === 'ping') {
    // Answer immediately — the round-trip time is what the clock sync measures.
    send(ws, { type: 'pong', t0: m.t0, ts: now() });
    return;
  }
  if (m.type === 'hello') return handleHello(ws, m);
  if (!room) return;

  if (ws.info.role === 'source') {
    if (ws !== room.source) return;
    if (m.type === 'live') {
      // The iPhone started (or stopped) sending sound.
      if (m.on) setLive(room, true, 'source');
      else if (room.live.by === 'source') room.live = { on: false, by: null };
      broadcastState(room);
    } else if (m.type === 'level') {
      // How loud the iPhone's sound is, for the host's meter.
      const vol = typeof m.vol === 'number' ? clamp(m.vol, 0, 1) : null;
      send(room.host, { type: 'level', v: clamp(Number(m.v) || 0, 0, 1), vol });
      if (m.cap && typeof m.cap === 'object') noteCapture(room, m.cap);
    }
    return;
  }

  if (m.type === 'status') {
    ws.info.rtt = typeof m.rtt === 'number' ? Math.round(m.rtt) : null;
    ws.info.ready = m.ready ? String(m.ready) : null;
    ws.info.nudge = typeof m.nudge === 'number' ? m.nudge : 0;
    ws.info.play = m.play && typeof m.play === 'object' ? m.play : null;
    if (typeof m.need === 'number' && Number.isFinite(m.need)) {
      ws.info.need = clamp(m.need, -1000, 5000);
      ws.info.needAt = now();
      tuneFastDelay(room);
    }
    queueMembers(room);
    return;
  }
  if (ws === room.host) handleHostCommand(room, m);
}

// --------------------------------------------------------------------- HTTP

function lanUrls() {
  const urls = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${PORT}`);
    }
  }
  return urls;
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function handleUpload(req, res, url) {
  const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
  if (!room || room.hostKey !== req.headers['x-host-key']) {
    req.resume();
    return json(res, 403, { error: 'Only the host can add songs' });
  }
  const maxMb = Math.round(MAX_UPLOAD_BYTES / MB);
  const declared = Number(req.headers['content-length']) || 0;
  if (declared > MAX_UPLOAD_BYTES) {
    req.resume();
    return json(res, 413, { error: `File too big (max ${maxMb} MB)` });
  }
  // Songs live in memory; the room's previous song is replaced by this one.
  const room0 = room.track ? room.track.data.length : 0;
  const budget = Math.min(MAX_UPLOAD_BYTES, MAX_TOTAL_UPLOAD_BYTES - (storedSongBytes() - room0));
  const chunks = [];
  let size = 0;
  let over = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > budget) {
      over = true;
      break;
    }
    chunks.push(chunk);
  }
  if (over && size > MAX_UPLOAD_BYTES) return json(res, 413, { error: `File too big (max ${maxMb} MB)` });
  if (over) return json(res, 503, { error: 'Server is busy. Try a smaller file.' });
  if (!size) return json(res, 400, { error: 'That file is empty' });

  room.track = {
    id: crypto.randomBytes(6).toString('hex'),
    name: String(url.searchParams.get('name') || 'Untitled').slice(0, 120),
    type: req.headers['content-type'] || 'application/octet-stream',
    data: Buffer.concat(chunks),
  };
  setLive(room, false, null);
  room.playback = { playing: false, startAt: 0, offset: 0, pauseAt: 0 };
  broadcastState(room);
  json(res, 200, { id: room.track.id });
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  try {
    if (req.method === 'POST' && p === '/api/upload') return await handleUpload(req, res, url);
    if (p === '/api/info') return json(res, 200, { lan: lanUrls(), port: PORT });
    if (p === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size });
    if (p === '/qr.svg') {
      const text = String(url.searchParams.get('text') || '').slice(0, 300);
      const svg = await QRCode.toString(text, {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#0E0B2B', light: '#00000000' },
      });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      return res.end(svg);
    }
    const trackMatch = p.match(/^\/track\/([A-Z]{4})\/([a-f0-9]+)$/);
    if (trackMatch) {
      const room = rooms.get(trackMatch[1]);
      const track = room && room.track;
      if (!track || track.id !== trackMatch[2]) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': track.type,
        'Content-Length': track.data.length,
        'Cache-Control': 'private, max-age=3600',
      });
      return res.end(track.data);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(res, p);
    res.writeHead(405);
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// A live packet is ~8 KB (2048 stereo frames); nothing legitimate is bigger than this.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

wss.on('connection', (ws, req) => {
  ws.info = {
    id: crypto.randomUUID(),
    name: 'Phone',
    role: null,
    room: null,
    rtt: null,
    ready: null,
    nudge: 0,
    ip: clientIp(req),
  };
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (data, isBinary) => onMessage(ws, data, isBinary));
  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => {});
});

// Drop dead sockets and forget rooms nobody has used for a while.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.emptySince && room.emptySince < cutoff) deleteRoom(code, room);
  }
  const hourAgo = Date.now() - 60 * 60 * 1000;
  for (const [ip, times] of roomsMadeBy) {
    if (!times.some((t) => t > hourAgo)) roomsMadeBy.delete(ip);
  }
}, 15000);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — Joint Speaker (or another app) is probably already running.`);
    console.error(`  Open http://localhost:${PORT}, or stop the other one first.`);
    console.error(`  To use a different port:  PORT=3001 npm start\n`);
    process.exit(1);
  }
  throw err;
});
wss.on('error', () => {}); // listen errors are reported once, above

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Joint Speaker is running.\n');
  console.log(`  On this computer:   http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  On phones (Wi-Fi):  ${u}`);
  console.log('\n  Phones must be on the same Wi-Fi as this computer.\n');
  if (LIBRESPOT) console.log('  Spotify speaker: on (librespot found)\n');
});

// Spotify speakers are separate programs: stop them with the server.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const room of rooms.values()) stopSpotify(room);
    process.exit(0);
  });
}
