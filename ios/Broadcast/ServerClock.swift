import QuartzCore

/// This iPhone's estimate of the server's clock, NTP-style — the same method
/// the web app uses (public/audio.js `Clock`), so every device agrees.
struct ServerClock {
  private struct Sample {
    var rtt: Double
    var offset: Double
    var at: Double
  }

  private var samples: [Sample] = []
  /// Server milliseconds minus local milliseconds.
  private(set) var offset: Double?

  var isSynced: Bool { offset != nil && samples.count >= 3 }

  /// Local milliseconds on the host clock (the one ReplayKit stamps audio with).
  static func localMs() -> Double { CACurrentMediaTime() * 1000 }

  /// Records a ping that left at `t0` (local ms) and was answered at `serverTs`.
  mutating func add(t0: Double, serverTs: Double, now t1: Double = localMs()) {
    let rtt = t1 - t0
    guard rtt >= 0, rtt < 5000 else { return }
    samples.append(Sample(rtt: rtt, offset: serverTs - (t0 + t1) / 2, at: t1))
    samples.removeAll { $0.at < t1 - 40_000 }
    if samples.count > 40 { samples.removeFirst(samples.count - 40) }

    // The fastest round trips waited least in queues, so their midpoints are
    // the most trustworthy. Average the best quarter.
    let best = samples.sorted { $0.rtt < $1.rtt }.prefix(max(1, (samples.count + 3) / 4))
    let estimate = best.reduce(0) { $0 + $1.offset } / Double(best.count)
    if let current = offset, abs(estimate - current) <= 100 {
      offset = current + (estimate - current) * 0.3
    } else {
      offset = estimate
    }
  }
}
