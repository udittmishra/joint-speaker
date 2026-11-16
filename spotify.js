// Spotify speaker: runs librespot (an open-source Spotify Connect player) so a
// party shows up in Spotify's speaker list as "Joint Speaker ABCD". Spotify
// then plays into the server instead of out of the host's phone, and every
// phone — the host's too — plays the same sound at the same moment.
//
// librespot is unofficial: Spotify's terms don't allow it, so this is for
// personal use and stays off unless LIBRESPOT_BIN names a librespot program.
// Since 2025 Spotify refuses librespot the keys to unlock songs on many
// accounts (librespot issue #1649), so on those it connects but plays nothing.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const RATE = 44100; // librespot always plays 44.1 kHz, 16-bit, stereo
const CHANNELS = 2;
const FRAMES = 512; // ~12 ms per packet, like the iPhone's broadcast
const PACKET_BYTES = FRAMES * CHANNELS * 2;
const PACKET_MS = (FRAMES / RATE) * 1000;
const HEADER_BYTES = 24;
const START_BYTES = PACKET_BYTES * 8; // ~0.1 s in hand before sound starts, so it never stutters
const DRY_MS = 200; // no sound for this long: Spotify paused or stopped
// Nobody hears Spotify before the phones do, so packets can leave a little
// before their time; a hiccup in the server's timer then never makes them late.
const SEND_AHEAD_MS = 60;

export function findLibrespot() {
  const bin = process.env.LIBRESPOT_BIN;
  return bin && existsSync(bin) ? bin : null;
}

/** The live packet every phone understands (see packLive in public/audio.js). */
function pack(seq, t, pcm) {
  const out = Buffer.allocUnsafe(HEADER_BYTES + pcm.length);
  out.writeUInt8(1, 0);
  out.writeUInt8(CHANNELS, 1);
  out.writeUInt16LE(0, 2);
  out.writeUInt32LE(RATE, 4);
  out.writeUInt32LE(seq >>> 0, 8);
  out.writeUInt32LE(FRAMES, 12);
  out.writeDoubleLE(t, 16);
  pcm.copy(out, HEADER_BYTES);
  return out;
}

export class SpotifySpeaker {
  /**
   * @param {object} o
   * @param {string} o.bin      librespot program
   * @param {string} o.name     name shown in Spotify's speaker list
   * @param {string} o.cacheDir where librespot keeps the Spotify sign-in
   * @param {() => number} o.now server clock (ms)
   * @param {(packet: Buffer) => void} o.onPacket
   * @param {(playing: boolean) => void} o.onPlaying
   * @param {(info: {code: number|null}) => void} o.onExit
   */
  constructor(o) {
    this.o = o;
    this.proc = null;
    this.timer = null;
    this.nextT = null; // server ms of the next packet's first sample
    this.dryAt = null;
    this.seq = 0;
    this.playing = false;
    this.log = [];
  }

  start() {
    const { bin, name, cacheDir } = this.o;
    mkdirSync(cacheDir, { recursive: true });
    // Signed in once (see README): Spotify lists the speaker on your account on
    // any network. Otherwise it can only be found on the same Wi-Fi, which
    // many networks (schools, offices) block.
    const signedIn = existsSync(path.join(cacheDir, 'credentials.json'));
    this.proc = spawn(
      bin,
      [
        ...(signedIn ? ['--disable-discovery'] : []),
        '--name', name,
        '--device-type', 'speaker',
        '--backend', 'pipe', // raw sound to stdout
        '--format', 'S16',
        '--bitrate', '320',
        '--initial-volume', '100',
        '--volume-ctrl', 'fixed', // each phone sets its own volume
        '--system-cache', cacheDir,
        '--disable-audio-cache',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // Pull sound only as fast as it plays; librespot waits while the pipe is full.
    this.proc.stdout.on('readable', () => {});
    this.proc.stderr.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        if (!line.trim() || line.includes('libmdns')) continue; // Wi-Fi discovery noise
        this.log.push(line.trim());
        console.log(`  [${name}] ${line.trim()}`);
      }
      if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    });
    this.proc.on('exit', (code) => {
      this.stopTimer();
      this.proc = null;
      this.setPlaying(false);
      this.o.onExit({ code });
    });
    this.proc.on('error', () => {});
    this.timer = setInterval(() => this.tick(), 4);
  }

  stop() {
    this.stopTimer();
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    this.setPlaying(false);
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setPlaying(on) {
    if (this.playing === on) return;
    this.playing = on;
    this.o.onPlaying(on);
  }

  /** Sends every packet that's due, on a steady timeline at real-time pace. */
  tick() {
    const out = this.proc && this.proc.stdout;
    if (!out) return;
    const now = this.o.now();
    if (this.nextT === null) {
      if (out.readableLength < START_BYTES) {
        out.read(0); // keep the pipe flowing into the buffer
        return;
      }
      this.nextT = now + SEND_AHEAD_MS;
      this.dryAt = null;
    }
    if (now - this.nextT > 250) this.nextT = now + SEND_AHEAD_MS; // the server stalled: don't race to catch up
    while (this.nextT <= now + SEND_AHEAD_MS) {
      const pcm = out.read(PACKET_BYTES);
      if (!pcm) {
        this.dryAt ??= now;
        if (now - this.dryAt > DRY_MS + SEND_AHEAD_MS) {
          this.nextT = null; // paused: start a fresh timeline when sound comes back
          this.setPlaying(false);
        }
        return;
      }
      this.dryAt = null;
      this.o.onPacket(pack(this.seq++, this.nextT, pcm));
      this.nextT += PACKET_MS;
      this.setPlaying(true);
    }
  }
}
