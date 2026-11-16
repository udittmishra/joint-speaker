import SwiftUI

@main
struct JointSpeakerApp: App {
  var body: some Scene {
    WindowGroup {
      RootView()
    }
  }
}

/// The whole app: the party page from the server, full screen. Before a server
/// is known (only while testing — see Config.xcconfig) it asks for one first.
struct RootView: View {
  @State private var server = ServerAddress.fixed
  @State private var loaded = false
  @State private var offline = false
  @State private var reloads = 0

  var body: some View {
    ZStack {
      Color("LaunchBackground").ignoresSafeArea()
      if let server {
        PartyWebView(
          server: server, reloads: reloads,
          onLoaded: {
            loaded = true
            offline = false
          },
          onOffline: { offline = true }
        )
        .ignoresSafeArea()
        if offline {
          OfflineView(
            retry: {
              offline = false
              reloads += 1
            },
            changeServer: ServerAddress.fixed == nil ? { switchServer(to: nil) } : nil)
        } else if !loaded {
          ConnectingView()
        }
      } else {
        ServerSetupView { switchServer(to: $0) }
      }
    }
    // A party needs the screen on: the page shows the code and the live meter.
    .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
  }

  private func switchServer(to url: URL?) {
    server = url
    loaded = false
    offline = false
  }
}
