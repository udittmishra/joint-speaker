import SwiftUI

/// Asks for the server address. Only shown in testing builds with no built-in
/// server (Config.xcconfig → JS_SERVER_HOST); the public app never asks.
struct ServerSetupView: View {
  let onConnect: (URL) -> Void

  @State private var address = ServerAddress.lastTyped
  @FocusState private var focused: Bool

  private var url: URL? { ServerAddress.parse(address) }

  var body: some View {
    GlassCard {
      Text("Joint Speaker")
        .font(.system(size: 26, weight: .semibold))
      Text("Server address")
        .font(.subheadline)
        .foregroundStyle(.white.opacity(0.65))

      TextField("192.168.1.20:3000", text: $address)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .keyboardType(.URL)
        .submitLabel(.go)
        .focused($focused)
        .onSubmit(connect)
        .padding(.horizontal, 16)
        .frame(height: 50)
        .background(.white.opacity(0.12), in: .rect(cornerRadius: 14))
        .padding(.top, 8)

      PillButton(title: "Connect", style: .white, action: connect)
        .disabled(url == nil)
        .opacity(url == nil ? 0.5 : 1)

      Text("The address the server prints when it starts, or your online server")
        .font(.footnote)
        .foregroundStyle(.white.opacity(0.5))
        .multilineTextAlignment(.center)
    }
    .onAppear { focused = address.isEmpty }
  }

  private func connect() {
    guard let url else { return }
    ServerAddress.lastTyped = address
    onConnect(url)
  }
}

/// While the party page loads. A server that was asleep can take a while.
struct ConnectingView: View {
  @State private var slow = false

  var body: some View {
    GlassCard {
      ProgressView()
        .tint(.white)
        .controlSize(.large)
        .padding(.bottom, 4)
      Text(slow ? "Waking up the party server" : "Connecting")
        .font(.system(size: 20, weight: .semibold))
      if slow {
        Text("This can take up to a minute the first time.")
          .font(.subheadline)
          .foregroundStyle(.white.opacity(0.65))
          .multilineTextAlignment(.center)
      }
    }
    .task {
      try? await Task.sleep(for: .seconds(6))
      slow = true
    }
  }
}

/// Shown when the party page can't be reached. Keeps retrying by itself.
struct OfflineView: View {
  let retry: () -> Void
  var changeServer: (() -> Void)?

  var body: some View {
    GlassCard {
      Text("Can’t reach the party")
        .font(.system(size: 22, weight: .semibold))
      Text("Check your internet connection. Trying again…")
        .font(.subheadline)
        .foregroundStyle(.white.opacity(0.65))
        .multilineTextAlignment(.center)
        .padding(.bottom, 6)
      PillButton(title: "Try again", style: .white, action: retry)
      // Only in testing builds without a built-in server.
      if let changeServer {
        PillButton(title: "Change server", style: .dark, action: changeServer)
      }
    }
    .task {
      try? await Task.sleep(for: .seconds(8))
      if !Task.isCancelled { retry() }
    }
  }
}

// MARK: - Pieces matching the web app's look

/// The vivid pink-and-blue art behind a dark glass card.
private struct GlassCard<Content: View>: View {
  @ViewBuilder let content: Content

  var body: some View {
    ZStack {
      LinearGradient(
        colors: [Color(red: 1, green: 0.18, blue: 0.53), Color(red: 0.55, green: 0.3, blue: 1),
                 Color(red: 0.3, green: 0.49, blue: 1)],
        startPoint: .topLeading, endPoint: .bottomTrailing
      )
      .ignoresSafeArea()

      VStack(spacing: 12) { content }
        .foregroundStyle(.white)
        .padding(28)
        .frame(maxWidth: 380)
        .background(.black.opacity(0.55), in: .rect(cornerRadius: 32))
        .background(.ultraThinMaterial, in: .rect(cornerRadius: 32))
        .overlay(RoundedRectangle(cornerRadius: 32).strokeBorder(.white.opacity(0.14)))
        .padding(.horizontal, 16)
    }
  }
}

private struct PillButton: View {
  enum Style { case white, dark }

  let title: String
  let style: Style
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(title)
        .font(.system(size: 17, weight: .semibold))
        .frame(maxWidth: .infinity, minHeight: 52)
        .foregroundStyle(style == .white ? .black : .white)
        .background(style == .white ? Color.white : Color.white.opacity(0.12), in: .capsule)
    }
    .buttonStyle(.plain)
  }
}
