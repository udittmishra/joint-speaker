// Joint Speaker — sync server.
// Serves the web app, keeps a shared clock, relays live audio from the host
// to every phone in the room, and stores uploaded songs for file playback.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;
const PLAY_LEAD_MS = 1000; // how far in the future a "play" starts, so every phone can schedule it
const SEEK_LEAD_MS = 700;
const PAUSE_LEAD_MS = 250;
const MAX_CLIENT_BACKLOG = 1 << 20; // skip live packets for phones that can't keep up

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
    delay: 1000,
    loud: false, // Loud mode: every phone runs a loudness boost on the audio
    live: { on: false },
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
    delay: room.delay,
    loud: room.loud,
    live: room.live,
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

function leaveRoom(ws) {
  const room = rooms.get(ws.info.room);
  if (!room) return;
  if (room.host === ws) room.host = null;
  room.clients.delete(ws);
  if (!room.host && room.clients.size === 0) room.emptySince = Date.now();
  broadcastState(room);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------- WebSocket

function handleHello(ws, m) {
  ws.info.name = String(m.name || 'Phone').slice(0, 24);
  ws.info.id = String(m.clientId || crypto.randomUUID()).slice(0, 64);

  let room;
  if (m.role === 'host') {
    room = m.room && rooms.get(String(m.room).toUpperCase());
    if (!room || room.hostKey !== m.hostKey) room = createRoom();
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
      room.live = { on: !!m.on };
      if (room.live.on && room.playback.playing) {
        room.playback = { playing: false, startAt: 0, offset: currentPos(room, t), pauseAt: t };
      }
      break;
    case 'play': {
      if (!room.track) return;
      room.live = { on: false };
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
    // Live audio packet from the host: fan it out untouched.
    if (!room || room.host !== ws || !room.live.on) return;
    for (const c of room.clients) {
      if (c.readyState === 1 && c.bufferedAmount < MAX_CLIENT_BACKLOG) c.send(data, { binary: true });
    }
    return;
  }

  let m;
  try {
    m = JSON.parse(data.toString());
  } catch {
    return;
  }

  if (m.type === 'ping') {
    // Answer immediately — the round-trip time is what the clock sync measures.
    send(ws, { type: 'pong', t0: m.t0, ts: now() });
    return;
  }
  if (m.type === 'hello') return handleHello(ws, m);
  if (!room) return;

  if (m.type === 'status') {
    ws.info.rtt = typeof m.rtt === 'number' ? Math.round(m.rtt) : null;
    ws.info.ready = m.ready ? String(m.ready) : null;
    ws.info.nudge = typeof m.nudge === 'number' ? m.nudge : 0;
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
  const chunks = [];
  let size = 0;
  let tooBig = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) {
      tooBig = true;
      break;
    }
    chunks.push(chunk);
  }
  if (tooBig) return json(res, 413, { error: 'File too big (max 80 MB)' });
  if (!size) return json(res, 400, { error: 'That file is empty' });

  room.track = {
    id: crypto.randomBytes(6).toString('hex'),
    name: String(url.searchParams.get('name') || 'Untitled').slice(0, 120),
    type: req.headers['content-type'] || 'application/octet-stream',
    data: Buffer.concat(chunks),
  };
  room.live = { on: false };
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

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024 });

wss.on('connection', (ws) => {
  ws.info = { id: crypto.randomUUID(), name: 'Phone', role: null, room: null, rtt: null, ready: null, nudge: 0 };
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
    if (room.emptySince && room.emptySince < cutoff) rooms.delete(code);
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
});
