import AVFoundation
import ReplayKit
import os

/// The broadcast extension iOS runs while this iPhone "screen-broadcasts" to
/// Joint Speaker. Only the sound is used: every app's audio (Spotify, YouTube,
/// Apple Music…) is converted and streamed to the party; video is ignored.
///
/// ReplayKit calls these methods from its own queues, so the little state
/// they share sits behind a lock — hence `@unchecked Sendable`.
final class SampleHandler: RPBroadcastSampleHandler, @unchecked Sendable {
  /// Where captured sound goes while a broadcast is running.
  private let input = OSAllocatedUnfairLock<AsyncStream<PCMChunk>.Continuation?>(initialState: nil)

  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    guard PartySession.load() != nil else {
      return finish(.noParty)
    }
    // Hold about a second of sound if the network stalls; after that, newer
    // sound wins (phones skip ahead rather than fall further behind).
    let (chunks, input) = AsyncStream.makeStream(of: PCMChunk.self, bufferingPolicy: .bufferingNewest(48))
    // A quiet, mix-with-everything session just so the system volume reads
    // correctly; it never plays anything or interrupts Spotify.
    let audio = AVAudioSession.sharedInstance()
    try? audio.setCategory(.ambient, options: [.mixWithOthers])
    try? audio.setActive(true)
    let sender = LiveSender(
      target: {
        guard let party = PartySession.load(), let url = party.socketURL else { return nil }
        return StreamTarget(socketURL: url, room: party.room, hostKey: party.hostKey)
      },
      volume: { Double(AVAudioSession.sharedInstance().outputVolume) })
    self.input.withLock { $0 = input }
    Task { [weak self] in
      let reason = await sender.run(chunks, input: input)
      self?.finish(reason)
    }
  }

  override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
    guard sampleBufferType == .audioApp, let chunk = PCMChunk(sampleBuffer: sampleBuffer) else { return }
    _ = input.withLock { $0?.yield(chunk) }
  }

  override func broadcastFinished() {
    input.withLock { $0?.finish() }
  }

  /// Ends the broadcast with a message iOS shows to the person.
  private func finish(_ reason: StreamEnd) {
    let message: String
    switch reason {
    case .finished:
      return
    case .stoppedByHost:
      message = "Streaming stopped in Joint Speaker."
    case .partyEnded:
      message = "That party has ended. Start a new one in Joint Speaker."
    case .noParty:
      message = "Open Joint Speaker and start a party first."
    }
    finishBroadcastWithError(
      NSError(domain: "JointSpeaker", code: 1, userInfo: [NSLocalizedDescriptionKey: message]))
  }
}
