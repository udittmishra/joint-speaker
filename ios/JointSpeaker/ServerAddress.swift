import Foundation

/// Which Joint Speaker server the app talks to.
enum ServerAddress {
  /// The server built into the app (`JS_SERVER_HOST` in Config.xcconfig).
  /// When it's set, people are never asked — the app just opens.
  static var fixed: URL? {
    guard let host = Bundle.main.object(forInfoDictionaryKey: "JSServerHost") as? String else { return nil }
    return parse(host)
  }

  /// The address typed in last time, for testing without a built-in server.
  static var lastTyped: String {
    get { UserDefaults.standard.string(forKey: "serverAddress") ?? "" }
    set { UserDefaults.standard.set(newValue, forKey: "serverAddress") }
  }

  /// Turns what someone types into a URL. A computer on this Wi-Fi
  /// (`192.168.1.20:3000`, `my-mac.local:3000`) gets http; anything else https.
  static func parse(_ text: String) -> URL? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard !trimmed.isEmpty else { return nil }
    if trimmed.contains("://") {
      guard let url = URL(string: trimmed), url.host != nil, ["http", "https"].contains(url.scheme ?? "") else { return nil }
      return url
    }
    let host = trimmed.split(separator: "/").first.map { String($0.split(separator: ":").first ?? "") } ?? ""
    let isLocal = host == "localhost" || host.hasSuffix(".local") || host.wholeMatch(of: /\d{1,3}(\.\d{1,3}){3}/) != nil
    guard let url = URL(string: "\(isLocal ? "http" : "https")://\(trimmed)"), url.host != nil else { return nil }
    return url
  }
}
