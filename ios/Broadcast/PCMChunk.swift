import AudioToolbox
import CoreMedia
import QuartzCore

/// A slice of captured sound in the form the party expects: 16-bit stereo,
/// plus the moment it was captured.
struct PCMChunk: Sendable {
  /// Interleaved left/right samples.
  var samples: [Int16]
  var sampleRate: Int
  /// Host-clock seconds (`CACurrentMediaTime`) when the first frame was captured.
  var hostTime: Double
  /// Loudest sample in the chunk, 0...1.
  var peak: Float

  var frames: Int { samples.count / 2 }
}

extension PCMChunk {
  /// Converts whatever ReplayKit delivers — 16/32-bit integer or 32-bit float,
  /// either byte order, mono or stereo, interleaved or not — to 16-bit stereo.
  /// (iOS has been seen handing over big-endian 16-bit app audio.)
  init?(sampleBuffer: CMSampleBuffer) {
    guard
      let format = CMSampleBufferGetFormatDescription(sampleBuffer),
      let description = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
      description.mFormatID == kAudioFormatLinearPCM,
      let encoding = SampleEncoding(description)
    else { return nil }

    let frames = CMSampleBufferGetNumSamples(sampleBuffer)
    let channels = Int(description.mChannelsPerFrame)
    guard frames > 0, channels > 0, description.mSampleRate > 0 else { return nil }

    // Ask how much room the buffer list needs, then fetch it.
    var listSize = 0
    guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer, bufferListSizeNeededOut: &listSize, bufferListOut: nil, bufferListSize: 0,
      blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil
    ) == noErr else { return nil }

    let listMemory = UnsafeMutableRawPointer.allocate(
      byteCount: listSize, alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { listMemory.deallocate() }
    let list = listMemory.bindMemory(to: AudioBufferList.self, capacity: 1)
    var block: CMBlockBuffer?
    guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: listSize,
      blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
      flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &block
    ) == noErr else { return nil }
    let buffers = UnsafeMutableAudioBufferListPointer(list)

    let interleaved = description.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
    func channel(_ c: Int) -> Channel? {
      let index = interleaved ? 0 : c
      guard index < buffers.count, let data = buffers[index].mData else { return nil }
      let samples = Int(buffers[index].mDataByteSize) / encoding.width
      return interleaved
        ? Channel(base: UnsafeRawPointer(data), first: c, stride: channels, frames: samples / channels)
        : Channel(base: UnsafeRawPointer(data), first: 0, stride: 1, frames: samples)
    }
    // Mono plays on both sides; anything past stereo is ignored.
    guard let left = channel(0), let right = channel(min(1, channels - 1)) else { return nil }

    let count = min(frames, left.frames, right.frames)
    var out = [Int16](repeating: 0, count: count * 2)
    var peak: Float = 0
    for i in 0..<count {
      let l = encoding.read(left.base, at: left.first + i * left.stride)
      let r = encoding.read(right.base, at: right.first + i * right.stride)
      peak = max(peak, abs(l), abs(r))
      out[2 * i] = Self.int16(l)
      out[2 * i + 1] = Self.int16(r)
    }

    let presented = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
    let now = CACurrentMediaTime()
    let duration = Double(count) / description.mSampleRate
    // ReplayKit stamps buffers on the host clock. If a stamp is ever missing
    // or on another clock, fall back to when the buffer arrived.
    let hostTime = presented.isFinite && abs(now - presented) < 2 ? presented : now - duration

    self.init(
      samples: out, sampleRate: Int(description.mSampleRate.rounded()), hostTime: hostTime, peak: min(1, peak))
  }

  private static func int16(_ x: Float) -> Int16 {
    let c = min(1, max(-1, x))
    return Int16(c < 0 ? c * 32768 : c * 32767)
  }
}

/// Where one channel's samples sit in a buffer.
private struct Channel {
  let base: UnsafeRawPointer
  let first: Int  // index of the first sample
  let stride: Int  // samples between consecutive frames
  let frames: Int
}

private enum SampleEncoding {
  case int16(bigEndian: Bool)
  case int32(bigEndian: Bool)
  case float32(bigEndian: Bool)

  init?(_ d: AudioStreamBasicDescription) {
    let big = d.mFormatFlags & kAudioFormatFlagIsBigEndian != 0
    let float = d.mFormatFlags & kAudioFormatFlagIsFloat != 0
    switch (float, d.mBitsPerChannel) {
    case (false, 16): self = .int16(bigEndian: big)
    case (false, 32): self = .int32(bigEndian: big)
    case (true, 32): self = .float32(bigEndian: big)
    default: return nil
    }
  }

  var width: Int {
    switch self {
    case .int16: 2
    case .int32, .float32: 4
    }
  }

  /// Sample `index` as -1...1.
  func read(_ base: UnsafeRawPointer, at index: Int) -> Float {
    switch self {
    case .int16(let big):
      let raw = base.loadUnaligned(fromByteOffset: index * 2, as: UInt16.self)
      return Float(Int16(bitPattern: big ? raw.byteSwapped : raw)) / 32768
    case .int32(let big):
      let raw = base.loadUnaligned(fromByteOffset: index * 4, as: UInt32.self)
      return Float(Int32(bitPattern: big ? raw.byteSwapped : raw)) / 2_147_483_648
    case .float32(let big):
      let raw = base.loadUnaligned(fromByteOffset: index * 4, as: UInt32.self)
      return Float(bitPattern: big ? raw.byteSwapped : raw)
    }
  }
}
