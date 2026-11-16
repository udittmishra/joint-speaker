import ReplayKit
import SwiftUI
import WebKit
import os

/// The party page, served by the Joint Speaker server — the very same app
/// a laptop uses — plus one native power: streaming this iPhone's own sound.
struct PartyWebView: UIViewRepresentable {
  let server: URL
  /// Bump to load the page again (after being offline).
  let reloads: Int
  let onLoaded: () -> Void
  let onOffline: () -> Void

  func makeUIView(context: Context) -> PartyHostView {
    let view = PartyHostView(server: server)
    view.onLoaded = onLoaded
    view.onOffline = onOffline
    view.load()
    context.coordinator.reloads = reloads
    return view
  }

  func updateUIView(_ view: PartyHostView, context: Context) {
    view.onLoaded = onLoaded
    view.onOffline = onOffline
    if context.coordinator.reloads != reloads {
      context.coordinator.reloads = reloads
      view.load()
    }
  }

  static func dismantleUIView(_ view: PartyHostView, coordinator: Coordinator) {
    view.tearDown()
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  final class Coordinator {
    var reloads = 0
  }
}

/// Hosts the web view and the (invisible) system broadcast button.
final class PartyHostView: UIView, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  var onLoaded: () -> Void = {}
  var onOffline: () -> Void = {}

  private let server: URL
  private let webView: WKWebView
  private let log = Logger(subsystem: "JointSpeaker", category: "app")
  private let broadcastPicker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))

  init(server: URL) {
    self.server = server

    let config = WKWebViewConfiguration()
    config.allowsInlineMediaPlayback = true
    config.mediaTypesRequiringUserActionForPlayback = []
    config.applicationNameForUserAgent = "JointSpeakerApp/1.0"
    config.userContentController.addUserScript(
      WKUserScript(source: Self.bootScript(for: server), injectionTime: .atDocumentStart, forMainFrameOnly: true))
    webView = WKWebView(frame: .zero, configuration: config)

    super.init(frame: .zero)

    // The page lays itself out around the notch and home bar (viewport-fit=cover).
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.scrollView.bounces = false
    webView.isOpaque = false
    webView.backgroundColor = UIColor(named: "LaunchBackground")
    webView.navigationDelegate = self
    webView.uiDelegate = self
    #if DEBUG
      webView.isInspectable = true  // Safari ▸ Develop ▸ your iPhone
    #endif
    // Removed again in tearDown(); the content controller holds on to us.
    config.userContentController.add(self, name: "jointSpeaker")

    webView.frame = bounds
    webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(webView)

    // iOS only lets the system's own button start a broadcast. It stays out
    // of sight; the page's "Start streaming" button presses it.
    broadcastPicker.preferredExtension = Bundle.main.bundleIdentifier.map { "\($0).Broadcast" }
    broadcastPicker.showsMicrophoneButton = false
    broadcastPicker.alpha = 0.011
    broadcastPicker.isUserInteractionEnabled = false
    addSubview(broadcastPicker)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  func load() {
    // A free server can take most of a minute to wake up, so be patient.
    webView.load(URLRequest(url: server, cachePolicy: .reloadRevalidatingCacheData, timeoutInterval: 75))
  }

  func tearDown() {
    webView.configuration.userContentController.removeScriptMessageHandler(forName: "jointSpeaker")
  }

  /// Runs before the page's own code: tells it it's inside the app, and
  /// restores the party this iPhone was hosting if iOS closed the app.
  private static func bootScript(for server: URL) -> String {
    var restore = "null"
    if let party = PartySession.load(), party.server.host == server.host,
      party.savedAt > .now.addingTimeInterval(-6 * 60 * 60),
      let json = try? JSONEncoder().encode(["room": party.room, "hostKey": party.hostKey])
    {
      restore = String(decoding: json, as: UTF8.self)
    }
    return """
      window.JointSpeakerNative = { platform: 'ios', version: 1 };
      (function () {
        var saved = \(restore);
        try {
          if (saved && !sessionStorage.getItem('js.host')) sessionStorage.setItem('js.host', JSON.stringify(saved));
        } catch (e) {}
      })();
      """
  }

  // MARK: Messages from the page

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    // Only our own server's page may ask for anything.
    guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == server.host,
      let body = message.body as? [String: Any], let type = body["type"] as? String
    else { return }

    let room = body["room"] as? String
    let hostKey = body["hostKey"] as? String
    let origin = (body["server"] as? String).flatMap(URL.init(string:)) ?? server
    switch type {
    case "host":
      // A party started (or ended) on the page; the broadcast extension reads this.
      if let room, let hostKey {
        PartySession(server: origin, room: room, hostKey: hostKey, savedAt: .now).save()
      } else {
        PartySession.clear()
      }
    case "broadcast":
      guard let room, let hostKey else { return }
      PartySession(server: origin, room: room, hostKey: hostKey, savedAt: .now).save()
      showBroadcastSheet()
    default:
      break
    }
  }

  /// Opens iOS's "Screen Broadcast" sheet with Joint Speaker already chosen.
  private func showBroadcastSheet() {
    let buttons = broadcastPicker.subviews.compactMap { $0 as? UIButton }
    if buttons.isEmpty { log.error("Broadcast picker has no button to press") }
    for button in buttons { button.sendActions(for: .allTouchEvents) }
  }

  // MARK: Navigation

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async
    -> WKNavigationActionPolicy
  {
    // Stay on the party server; anything else opens in Safari.
    guard let url = navigationAction.request.url, let host = url.host, host != server.host,
      navigationAction.targetFrame?.isMainFrame ?? true
    else { return .allow }
    if ["http", "https"].contains(url.scheme ?? "") {
      await UIApplication.shared.open(url)
    }
    return .cancel
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    onLoaded()
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
    if (error as NSError).code != NSURLErrorCancelled { onOffline() }
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    webView.reload()
  }

  // MARK: Dialogs (the page asks "End the party?")

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
    await withCheckedContinuation { done in
      let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
      alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done.resume(returning: false) })
      alert.addAction(UIAlertAction(title: "OK", style: .destructive) { _ in done.resume(returning: true) })
      guard let presenter = topViewController() else { return done.resume(returning: true) }
      presenter.present(alert, animated: true)
    }
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
      let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
      alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done.resume() })
      guard let presenter = topViewController() else { return done.resume() }
      presenter.present(alert, animated: true)
    }
  }

  private func topViewController() -> UIViewController? {
    var top = window?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }
}
