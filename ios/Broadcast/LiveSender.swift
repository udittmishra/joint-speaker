import Foundation
import QuartzCore
import os

/// Why streaming ended.
enum StreamEnd: Sendable, Equatable {
  /// The broadcast was stopped on the iPhone (Control Center, the red pill…).
  case finished
  /// The host pressed Stop, or switched the party to a song.
  case stoppedByHost
  /// The party is gone (ended, or the server restarted).
  case partyEnded
  /// No party has been started in the app yet.
  case noParty
}

/// Where to send the sound.
struct StreamTarget: Sendable {
  var socketURL: URL
  var room: String
  var hostKey: String
}

/// Sends captured sound to the party server as its "source", keeping the
/// connection alive and the clock in sync for as long as the broadcast runs.
///
/// Sound arrives through an `AsyncStream` and is handled in order on this
/// actor; pings and server messages interleave between chunks.
actor LiveSender {
  private let target: @Sendable () -> StreamTarget?
  private let volume: @Sendable () -> Double?
  private let session: URLSession
  private let log = Logger(subsystem: "JointSpeaker", category: "stream")

  private var socket: URLSessionWebSocketTask?
  private var welcomed = false
  private var clock = ServerClock()
  private var packer = Packetizer()
  private var failures = 0
  private var refusals = 0
  private var levelPeak: Float = 0
  private var levelSentAt = 0.0
  private var capture = CaptureWindow()
  private var ending: StreamEnd?
  private var input: AsyncStream<PCMChunk>.Continuation?

  /// `target` is read again on every reconnect, so a party restarted in the
  /// app is picked up without restarting the broadcast. `volume` is this
  /// iPhone's own speaker volume (0...1), sent along with the level so the
  /// app can warn when the host is playing out loud, ahead of everyone.
  init(target: @escaping @Sendable () -> StreamTarget?, volume: @escaping @Sendable () -> Double? = { nil }) {
    self.target = target
    self.volume = volume
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 15
    session = URLSession(configuration: config)
  }

  /// Streams until the chunks run out (the broadcast ended) or the party says stop.
  func run(_ chunks: AsyncStream<PCMChunk>, input: AsyncStream<PCMChunk>.Continuation) async -> StreamEnd {
    self.input = input
    async let _ = keepConnected()
    for await chunk in chunks {
      await send(chunk)
    }
    let reason = ending ?? .finished
    ending = reason
    socket?.cancel(with: .normalClosure, reason: nil)
    return reason
  }

  // MARK: Connection

  private func keepConnected() async {
    while ending == nil, !Task.isCancelled {
      guard let target = target() else { return end(.noParty) }
      await connect(to: target)
      welcomed = false
      socket = nil
      packer.reset()
      guard ending == nil, !Task.isCancelled else { return }
      failures += 1
      do {
        try await Task.sleep(for: .seconds(min(1.5 * Double(failures), 6)))
      } catch {
        return
      }
    }
  }

  private func connect(to target: StreamTarget) async {
    let task = session.webSocketTask(with: target.socketURL)
    socket = task
    task.resume()
    async let _ = keepPinging(task)
    do {
      try await task.send(.string(encode(Hello(room: target.room, hostKey: target.hostKey))))
      while ending == nil {
        let message = try await task.receive()
        guard case .string(let text) = message,
          let incoming = try? JSONDecoder().decode(Incoming.self, from: Data(text.utf8))
        else { continue }
        if let reply = handle(incoming) {
          try await task.send(.string(reply))
        }
      }
    } catch {
      if ending == nil { log.info("Connection dropped: \(error.localizedDescription, privacy: .public)") }
    }
    task.cancel(with: .goingAway, reason: nil)
  }

  /// Reacts to a server message; returns a reply to send, if any.
  private func handle(_ m: Incoming) -> String? {
    switch m.type {
    case "pong":
      if let t0 = m.t0, let ts = m.ts { clock.add(t0: t0, serverTs: ts) }
    case "welcome":
      welcomed = true
      failures = 0
      refusals = 0
      return encode(Live(on: true))  // start playing this iPhone's sound on every phone
    case "stop":
      end(.stoppedByHost)
    case "error" where m.code == "no-room":
      // The app may be about to save a new party (say, after a server
      // restart), so give it a few tries before giving up.
      refusals += 1
      if refusals >= 4 { end(.partyEnded) }
      socket?.cancel(with: .normalClosure, reason: nil)
    default:
      break
    }
    return nil
  }

  private func keepPinging(_ task: URLSessionWebSocketTask) async {
    // A quick burst to lock onto the server clock, then a steady trickle.
    var sent = 0
    while !Task.isCancelled {
      try? await task.send(.string(encode(Ping(t0: ServerClock.localMs()))))
      sent += 1
      do {
        try await Task.sleep(for: .milliseconds(sent < 10 ? 120 : 1500))
      } catch {
        return
      }
    }
  }

  private func end(_ reason: StreamEnd) {
    guard ending == nil else { return }
    ending = reason
    socket?.cancel(with: .normalClosure, reason: nil)
    input?.finish()
  }

  // MARK: Sound

  private func send(_ chunk: PCMChunk) async {
    levelPeak = max(levelPeak, chunk.peak)
    capture.add(chunk, now: CACurrentMediaTime())
    guard welcomed, let socket else { return }
    for packet in packer.add(chunk, offset: clock.isSynced ? clock.offset : nil) {
      do {
        try await socket.send(.data(packet))
      } catch {
        return
      }
    }
    // The host's meter, four times a second.
    let now = CACurrentMediaTime()
    if now - levelSentAt >= 0.25 {
      levelSentAt = now
      let level = Level(v: Double(levelPeak), vol: volume(), cap: capture.take())
      levelPeak = 0
      try? await socket.send(.string(encode(level)))
    }
  }

  // MARK: Messages

  private struct Hello: Encodable {
    let type = "hello"
    let role = "source"
    let room: String
    let hostKey: String
    let name = "iPhone"
  }

  private struct Ping: Encodable {
    let type = "ping"
    let t0: Double
  }

  private struct Live: Encodable {
    let type = "live"
    let on: Bool
  }

  private struct Level: Encodable {
    let type = "level"
    let v: Double
    let vol: Double?
    let cap: CaptureStats?
  }

  /// How late iPhone hands over the sound it plays, for tuning the party's delay.
  struct CaptureStats: Encodable {
    /// Age of a chunk's first sample when it leaves this iPhone (ms).
    let minMs: Double
    let maxMs: Double
    let frames: Int
    let rate: Int
    let chunks: Int
    /// Longest wait between two chunks (ms).
    let gapMs: Double
  }

  private struct CaptureWindow {
    private var minMs = Double.infinity
    private var maxMs = 0.0
    private var frames = 0
    private var rate = 0
    private var chunks = 0
    private var gapMs = 0.0
    private var lastAt = 0.0

    mutating func add(_ chunk: PCMChunk, now: Double) {
      let age = (now - chunk.hostTime) * 1000
      minMs = min(minMs, age)
      maxMs = max(maxMs, age)
      frames = chunk.frames
      rate = chunk.sampleRate
      chunks += 1
      if lastAt > 0 { gapMs = max(gapMs, (now - lastAt) * 1000) }
      lastAt = now
    }

    /// The stats since the last call, then starts a new window.
    mutating func take() -> CaptureStats? {
      defer { self = CaptureWindow(lastAt: lastAt) }
      guard chunks > 0 else { return nil }
      return CaptureStats(minMs: minMs, maxMs: maxMs, frames: frames, rate: rate, chunks: chunks, gapMs: gapMs)
    }

    init(lastAt: Double = 0) { self.lastAt = lastAt }
  }

  private struct Incoming: Decodable {
    let type: String
    let t0: Double?
    let ts: Double?
    let code: String?
  }

  private func encode(_ value: some Encodable) -> String {
    let data = (try? JSONEncoder().encode(value)) ?? Data("{}".utf8)
    return String(decoding: data, as: UTF8.self)
  }
}
