# Joint Speaker

Turn every phone in the room into one big, synchronized speaker.

One device hosts the party: a laptop, or an iPhone with the Joint Speaker app. Friends scan a QR code (or type a 4-letter code) in their phone's browser; they install nothing. Every phone then plays the same audio at the same moment, so together they sound like one loud speaker. Each screen also turns into a coloured light that changes in step with all the others.

## Start a party (Mac)

**Double-click `Start Joint Speaker.command`.** It starts everything, opens Chrome straight into a new party, and keeps your Mac awake. Keep the Terminal window it opens running during the party; close it to stop.

- If macOS asks whether to allow `node` to accept incoming connections, click **Allow**.
- To bring the invite up big, click **Invite** (or the QR code) and turn your laptop towards everyone.
- Friends scan the QR code with their phone camera and tap **Join**. Phones must be on the **same Wi-Fi** as your Mac.

Prefer the terminal? Run `npm install` once, then `npm start`, and open `http://localhost:3000` in Chrome.

## Start a party (iPhone, no laptop)

The iPhone app is the same party page with one extra power: it can stream **whatever this iPhone is playing** — Spotify, YouTube, SoundCloud — to every phone.

1. Open **Joint Speaker** and tap **Start a party**. Friends scan the QR code.
2. On **Stream**, tap **Start streaming**, then **Start Broadcast** in the iOS sheet.
3. Open Spotify (or any music app) and press play. Every phone plays it about a second later, together.
4. Turn the host iPhone's own volume down: it plays the music immediately, so it would sound like an echo of everyone else. The other phones still get full sound. To stop, tap **Stop** in Joint Speaker, or the red pill at the top of the screen.

iOS shows a red recording pill while streaming; that's how it marks any app capturing sound. Only the sound is sent, never the screen. Apps that block screen recording (Apple Music, Netflix) stream as silence, and the host page says "Press play" when nothing is coming through.

Install it with [the steps below](#install-the-iphone-app). The app needs a server it can reach; put one [online](#put-the-server-online) so nobody needs a laptop at all.

## Two ways to play music

### 1. Stream (Spotify, YouTube, SoundCloud, anything)
From the iPhone app, see above. On a laptop (Chrome, Edge or Brave):
1. Open open.spotify.com in another Chrome tab and log in. A free account works.
2. On the host page, click **Share a tab**, pick the Spotify tab, and keep **Also share tab audio** on.
3. Press play in Spotify. If the shared tab stays silent, the host page reminds you to press play.

Friends don't need Spotify or an account; their phones just play the sound.

Control the music in that tab as normal. Every phone (and the laptop) plays it about 1 second later, all together. The **Delay** slider in Settings sets that delay. Lower it for less lag, or raise it if phones stutter on a weak connection.

### 2. Play a song file
Pick an MP3/M4A/WAV from any device, including a phone acting as host. It's sent to every phone, and you get play, pause and seek controls. This mode has the tightest sync because each phone has the whole song in advance.

## Why an app, and why only iPhone?

A web page can't hear other apps, so streaming Spotify from a phone takes a real app. On iPhone, the app uses screen broadcasting (ReplayKit), which hands it the sound of every app. Android has a similar feature, but Spotify and most music apps opt out of it, so an Android app would mostly stream silence. Android phones still join and play along in the browser.

## Getting the sync tight

- On the host, press **Test**. Every speaker clicks at the same moments.
- If one phone sounds late (common with **Bluetooth** speakers or earbuds), tap **Timing** on that phone and slide right until the clicks line up. Each phone remembers its setting.
- Turn every phone's volume all the way up, and keep the screen on with the page open. Phones pause web audio when the screen locks.
- On iPhone, the silent switch is handled automatically on iOS 17 and later.

## Making it sound louder

A phone can't play louder than its own maximum volume — nothing in a browser can change that. **Loud mode**, in the host's Settings, instead makes the most of that maximum on every phone at once:

- Cuts the deep bass a phone speaker can't really reproduce (it mostly just buzzes the case), freeing up headroom for everything else.
- Brings quiet passages up closer to the loud ones, so the song doesn't swing as hard between the two.
- Lifts the midrange slightly, where small speakers are clearest.
- A soft limiter keeps all of that from ever turning into harsh digital clipping.

It's one switch for the whole party — turning it on or off on the host applies it to every connected phone, immediately, with no clicks or pops. It helps most on quieter recordings; music that's already mastered loud won't change much. For more volume on top of that: keep Spotify's own volume at 100%, turn off its "Normalize volume" setting, and add more phones — each time you double the number of speakers, the room gets noticeably louder.

## How the sync works

1. **Shared clock:** each device pings the server every 1.5 s and works out its clock offset, NTP-style. It trusts only the fastest round trips, which typically puts devices within a few milliseconds of each other on Wi-Fi.
2. **Timestamped audio:** each piece of audio carries the server time it should be *heard*. Each device converts that to its own audio clock, including its speaker's output latency, and schedules it with the Web Audio API.
3. **Drift correction:** phone audio clocks run slightly fast or slow. Each device measures its drift and adjusts playback speed by up to ±0.3% (too small to hear) to stay locked.

## Put the server online

Online, nobody needs a laptop or the same Wi-Fi: any phone opens the address and starts or joins a party. The repo includes `render.yaml` for [Render](https://render.com):

1. Sign in to Render with GitHub, choose **New → Blueprint**, and pick this repository. Render reads `render.yaml` and deploys.
2. You get an address like `https://joint-speaker.onrender.com`. Phones can use it in the browser right away.
3. Put that host name in `ios/Config.xcconfig` (`JS_SERVER_HOST = joint-speaker.onrender.com`) and run the app again. It now opens straight into the party, with no address to type.

The free plan sleeps after 15 minutes without visitors and takes about a minute to wake. For a public launch, switch `plan` to `starter` in `render.yaml` so it's always on. Any Node host with WebSockets works too (Railway, Fly.io…).

**Data use:** live streaming sends about 1.4 Mbit/s (≈ 630 MB an hour) to *each* phone, and the server pays for all of it: a 10-phone party is ~6 GB an hour. Song mode sends each phone the file once. Check your host's bandwidth allowance before sharing the address widely.

Built-in limits keep one party or one person from overloading a shared server. Change them with environment variables:

| Variable | Default | Limits |
| --- | --- | --- |
| `MAX_ROOM_SPEAKERS` | 40 | Phones in one party, host included |
| `MAX_ROOMS` | 300 | Parties at once (empty ones are cleared first) |
| `ROOMS_PER_IP_PER_HOUR` | 20 | New parties per address per hour |
| `MAX_UPLOAD_MB` | 80 | One song file |
| `MAX_TOTAL_UPLOAD_MB` | 300 (200 on Render) | All songs held in memory |

## Install the iPhone app

You need a Mac with Xcode and an iPhone on iOS 17 or later. A free Apple ID works for your own phone.

1. Open `ios/JointSpeaker.xcodeproj` in Xcode.
2. In `ios/Config.xcconfig`, set `JS_BUNDLE_PREFIX` to something unique to you (for example `com.yourname`). Set `JS_SERVER_HOST` if your server is [online](#put-the-server-online).
3. In Xcode, open **Settings → Accounts** and sign in with your Apple ID. Then select the project, and on **Signing & Capabilities** choose your team for both the **JointSpeaker** and **Broadcast** targets.
4. Connect your iPhone with a cable, pick it at the top of the Xcode window, and press **Run** (▶).
5. On the iPhone, turn on **Settings → Privacy & Security → Developer Mode** if asked, and trust yourself under **Settings → General → VPN & Device Management**.

Apps signed with a free Apple ID stop opening after 7 days; press Run again to renew. To share the app with friends through TestFlight or the App Store, you need the paid Apple Developer Program, and Apple reviews the app first.

**Testing on your Wi-Fi without a server online:** leave `JS_SERVER_HOST` empty. The app asks for an address; type the one `npm start` prints for phones, such as `192.168.1.20:3000`.

The iOS Simulator runs the app but can't broadcast, so streaming only works on a real iPhone.

## Files

| Path | What it does |
| --- | --- |
| `server.js` | Web server and WebSocket hub: rooms, clock pings, live-audio relay, song uploads, QR codes, limits |
| `public/audio.js` | Clock sync, the drift-correcting scheduler, live and file players |
| `public/capture-worklet.js` | Captures the shared tab's audio on a laptop host |
| `public/app.js` | Screens, controls and networking (and the hand-off to the iPhone app) |
| `public/index.html`, `public/styles.css` | The interface |
| `render.yaml` | One-click deploy on Render |
| `ios/Config.xcconfig` | The iPhone app's two settings: your ID prefix and server |
| `ios/JointSpeaker/` | The iPhone app: the party page, plus the button that starts a broadcast |
| `ios/Broadcast/` | The broadcast extension: turns the iPhone's sound into live packets and streams them |
| `ios/Shared/` | The party details the app and extension share |
