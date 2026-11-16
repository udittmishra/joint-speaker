import Foundation

/// Cuts captured sound into the live packets every phone already understands
/// (see `packLive` in public/audio.js):
///
///     byte 0      1 (packet kind)
///     byte 1      channels
///     bytes 4-7   sample rate        UInt32 LE
///     bytes 8-11  sequence number    UInt32 LE
///     bytes 12-15 frames             UInt32 LE
///     bytes 16-23 capture time       Float64 LE, server milliseconds
///     bytes 24-   16-bit LE interleaved PCM
///
/// Phones play each packet at its capture time plus the party's delay.
struct Packetizer {
  /// About 12 ms of sound: small, so other phones can start playing it
  /// moments after this iPhone does.
  static let framesPerPacket = 512
  static let headerBytes = 24

  private var pending: [Int16] = []  // interleaved stereo not yet sent
  private var pendingStart = 0.0  // host seconds of pending's first frame
  private var sampleRate = 0
  private var timeline: Double?  // server ms where the next packet starts
  private var seq: UInt32 = 0

  /// Forget partial audio and the timeline, e.g. after reconnecting.
  mutating func reset() {
    pending.removeAll(keepingCapacity: true)
    timeline = nil
  }

  /// Adds captured sound and returns any packets that are now full.
  /// `offset` turns host milliseconds into server milliseconds; while the
  /// clock isn't synced yet it's nil and the sound is skipped.
  mutating func add(_ chunk: PCMChunk, offset: Double?) -> [Data] {
    if chunk.sampleRate != sampleRate {
      sampleRate = chunk.sampleRate
      reset()
    }
    let rate = Double(sampleRate)
    if pending.isEmpty {
      pendingStart = chunk.hostTime
    } else {
      // A hole in the capture (or a burst of dropped chunks): start afresh
      // rather than stitching sound from different moments together.
      let expected = pendingStart + Double(pending.count / 2) / rate
      if abs(chunk.hostTime - expected) > 0.1 {
        reset()
        pendingStart = chunk.hostTime
      }
    }
    pending.append(contentsOf: chunk.samples)

    let size = Self.framesPerPacket
    let packetMs = Double(size) / rate * 1000
    var packets: [Data] = []
    while pending.count >= size * 2 {
      if let offset {
        // Keep packet times on a smooth sample-count timeline, steered gently
        // toward the measured capture time, so phones never hear jitter.
        let measured = pendingStart * 1000 + offset
        var t = timeline ?? measured
        if abs(measured - t) > 250 { t = measured } else { t += (measured - t) * 0.01 }
        packets.append(Self.pack(seq: seq, t: t, sampleRate: sampleRate, samples: pending[0..<(size * 2)]))
        seq &+= 1
        timeline = t + packetMs
      } else {
        timeline = nil
      }
      pending.removeFirst(size * 2)
      pendingStart += Double(size) / rate
    }
    return packets
  }

  static func pack(seq: UInt32, t: Double, sampleRate: Int, samples: ArraySlice<Int16>) -> Data {
    var data = Data(capacity: headerBytes + samples.count * 2)
    data.append(contentsOf: [1, 2, 0, 0])
    data.appendLittleEndian(UInt32(sampleRate))
    data.appendLittleEndian(seq)
    data.appendLittleEndian(UInt32(samples.count / 2))
    data.appendLittleEndian(t.bitPattern)
    for sample in samples { data.appendLittleEndian(sample) }
    return data
  }
}

extension Data {
  mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
    Swift.withUnsafeBytes(of: value.littleEndian) { append(contentsOf: $0) }
  }
}
