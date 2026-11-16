import Foundation

/// The party this iPhone is hosting. The app writes it whenever the party page
/// starts or ends a party; the broadcast extension reads it to know where to
/// send the sound. They share it through their App Group.
nonisolated struct PartySession: Codable, Equatable, Sendable {
  var server: URL
  var room: String
  var hostKey: String
  var savedAt: Date

  /// `ws(s)://…/ws` on the same server that serves the party page.
  var socketURL: URL? {
    guard var parts = URLComponents(url: server, resolvingAgainstBaseURL: false) else { return nil }
    parts.scheme = parts.scheme == "https" ? "wss" : "ws"
    parts.path = "/ws"
    parts.query = nil
    parts.fragment = nil
    return parts.url
  }

  static func load() -> PartySession? {
    guard let data = store?.data(forKey: key) else { return nil }
    return try? JSONDecoder().decode(PartySession.self, from: data)
  }

  func save() {
    guard let data = try? JSONEncoder().encode(self) else { return }
    Self.store?.set(data, forKey: Self.key)
  }

  static func clear() {
    store?.removeObject(forKey: key)
  }

  private static let key = "party"

  /// The App Group's shared defaults. Its identifier comes from Info.plist
  /// (`JSAppGroup`), which is filled in from Config.xcconfig at build time.
  private static var store: UserDefaults? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "JSAppGroup") as? String, !group.isEmpty else {
      return nil
    }
    return UserDefaults(suiteName: group)
  }
}
