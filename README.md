# Joint Speaker

Turn every phone in the room into one big, synchronized speaker.

One device hosts the party. Friends scan a QR code (or type a 4-letter code) in their phone's browser. There's nothing to install. Every phone then plays the same audio at the same moment, so together they sound like one loud speaker. Each screen also turns into a coloured light that changes in step with all the others.

## Start a party (Mac)

**Double-click `Start Joint Speaker.command`.** It starts everything, opens Chrome straight into a new party, and keeps your Mac awake. Keep the Terminal window it opens running during the party; close it to stop.

- If macOS asks whether to allow `node` to accept incoming connections, click **Allow**.
- To bring the invite up big, click **Show to the room** (or the QR code) and turn your laptop towards everyone.
- Friends scan the QR code with their phone camera and tap **Join party**. Phones must be on the **same Wi-Fi** as your Mac.

Prefer the terminal? Run `npm install` once, then `npm start`, and open `http://localhost:3000` in Chrome.

## Two ways to play music

### 1. Stream a tab (Spotify, YouTube, SoundCloud, anything)
On the laptop (Chrome, Edge or Brave):
1. Click **Open Spotify** on the host page and log in. A free account works.
2. Back on the host page, click **Share a tab**, pick the Spotify tab, and keep **Also share tab audio** on.
3. Press play in Spotify. If the shared tab stays silent, the host page reminds you to press play.

Friends don't need Spotify or an account; their phones just play the sound.

Control the music in that tab as normal. Every phone (and the laptop) plays it about 1 second later, all together. The **Live buffer** slider sets that delay. Lower it for less lag, or raise it if phones stutter on weak Wi-Fi.

### 2. Play a song file
Pick an MP3/M4A/WAV from any device, including a phone acting as host. It's sent to every phone, and you get play, pause and seek controls. This mode has the tightest sync because each phone has the whole song in advance.

## Why not Spotify *on a phone*?

iOS and Android don't let any app capture the sound coming out of another app like Spotify or Apple Music, and the music services block it too. That's why the music has to come from a laptop browser tab or a song file. Every "phones as one speaker" app runs into this same limit.

## Getting the sync tight

- On the host, press **Play test**. Every speaker clicks at the same moments.
- If one phone sounds late (common with **Bluetooth** speakers or earbuds), open **Fine-tune timing** on that phone and slide right until the clicks line up. Each phone remembers its setting.
- Turn every phone's volume all the way up, and keep the screen on with the page open. Phones pause web audio when the screen locks.
- On iPhone, the silent switch is handled automatically on iOS 17 and later.

## How the sync works

1. **Shared clock:** each device pings the server every 1.5 s and works out its clock offset, NTP-style. It trusts only the fastest round trips, which typically puts devices within a few milliseconds of each other on Wi-Fi.
2. **Timestamped audio:** each piece of audio carries the server time it should be *heard*. Each device converts that to its own audio clock, including its speaker's output latency, and schedules it with the Web Audio API.
3. **Drift correction:** phone audio clocks run slightly fast or slow. Each device measures its drift and adjusts playback speed by up to ±0.3% (too small to hear) to stay locked.

## Files

| Path | What it does |
| --- | --- |
| `server.js` | Web server and WebSocket hub: rooms, clock pings, live-audio relay, song uploads, QR codes |
| `public/audio.js` | Clock sync, the drift-correcting scheduler, live and file players |
| `public/capture-worklet.js` | Captures the shared tab's audio on the host |
| `public/app.js` | Screens, controls and networking |
| `public/index.html`, `public/styles.css` | The interface |

## Using it outside one Wi-Fi network

Deploy the folder to any Node host that supports WebSockets (Render, Railway, Fly.io and so on). With HTTPS, phones also keep their screens awake automatically. Live streaming uses about 1.5 Mbit/s per phone.
