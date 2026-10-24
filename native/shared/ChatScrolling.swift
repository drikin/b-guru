import SwiftUI

/// Where the chat list scrolls (drikin 2026-10-19, from member feedback):
/// - Coming on screen with unread messages, it opens at the first one (top of the
///   view, under a "ここから未読" line). When they all fit on one screen the list
///   just stops at the bottom, as before.
/// - It follows new messages only while the member is at the bottom (or sent one).
///   Reading further up, it stays put and a "↓ 新着 N" button appears instead.
struct ChatScrolling: ViewModifier {
    let store: ChatStore
    let proxy: ScrollViewProxy
    @Binding var atBottom: Bool
    @Binding var newBelow: Int
    /// Whether the chat is the tab / page on screen. The Mac keeps the chat built under the
    /// timeline: scrolling its hidden lazy list each time a message arrived (three scrollTo,
    /// animated, while the member read the timeline) is the shape of the hang that froze the
    /// panel for good before (a hidden lazy list kept updating and never settled — drikin
    /// 2026-10-22 / 10-23). Hidden, it does not scroll; it catches up when it shows.
    @Environment(\.screenVisibility) private var visibility
    private var onScreen: Bool { visibility?.chat ?? true }
    /// The panel opened with unread messages while the chat was hidden: go to them once it shows.
    @State private var openPending = false
    /// At the bottom when it went off screen: back to the newest when it shows (the messages that came
    /// in meanwhile are below, so `atBottom` itself went false).
    @State private var leftAtBottom = false
    /// When the list last went to the unread line: coming on screen in the same moment must
    /// not then send it to the bottom (that also zeroed 「↓ 新着 N」).
    @State private var wentToUnreadAt = Date.distantPast

    /// Sending also shrinks the composer (and a LazyVStack only estimates rows it
    /// hasn't drawn), so one scroll can land short of the bottom. Scroll now, then
    /// again once the layout has settled.
    private func toBottom(animated: Bool) {
        if animated {
            withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("bottom", anchor: .bottom) }
        } else {
            proxy.scrollTo("bottom", anchor: .bottom)
        }
        // (Not once the chat has gone off screen meanwhile; `visibility` is read when they run.)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { if onScreen { proxy.scrollTo("bottom", anchor: .bottom) } }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { if onScreen { proxy.scrollTo("bottom", anchor: .bottom) } }
    }

    private func scrollToUnread() {
        guard let id = store.unreadMarkerId,
              let row = store.rows.first(where: { $0.message.id == id }) else { return }
        wentToUnreadAt = Date()
        let unread = store.rows.filter { r in
            r.message.id >= id && !r.message.isAuthor && !r.message.isNotice
        }.count
        // Wait for the rows to be laid out (a freshly opened panel / first load),
        // then once more: a LazyVStack only estimates rows it has not drawn yet.
        DispatchQueue.main.async {
            proxy.scrollTo(row.id, anchor: .top)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                proxy.scrollTo(row.id, anchor: .top)
                newBelow = atBottom ? 0 : unread
            }
        }
    }

    func body(content: Content) -> some View {
        content
            .keepsBottomOnResize(atBottom && onScreen)
            .modifier(BottomTracker(atBottom: $atBottom))
            .onChange(of: store.rows.last?.id) { _, _ in
                guard store.scrollTarget == nil, let last = store.rows.last?.message else { return }
                if !onScreen {
                    if !atBottom, !last.isAuthor, !last.isNotice { newBelow += 1 }
                    return
                }
                if last.isAuthor && last.id < 0 {
                    // My own message just went out: show it, and keep following while it
                    // settles (sending → sent, photos loading) — drikin 2026-10-19
                    // "投稿した時にスクロール位置が更新されない時がある".
                    atBottom = true
                    toBottom(animated: store.isVisible)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { if atBottom, onScreen { proxy.scrollTo("bottom", anchor: .bottom) } }
                } else if atBottom {
                    toBottom(animated: store.isVisible)
                } else if !last.isAuthor && !last.isNotice {
                    newBelow += 1
                }
            }
            .onChange(of: store.openSeq) { _, _ in
                if onScreen {
                    openPending = false
                    scrollToUnread()
                } else {
                    openPending = true
                }
            }
            .onChange(of: onScreen) { _, shown in
                guard shown else { leftAtBottom = atBottom; return }
                // After the rows caught up (the list unfreezes in the same update) and after a
                // jump the same update asked for (a notification's message, the unread line).
                DispatchQueue.main.async {
                    if openPending {
                        openPending = false
                        scrollToUnread()
                    } else if atBottom || leftAtBottom, store.scrollTarget == nil, store.highlightId == nil,
                              Date().timeIntervalSince(wentToUnreadAt) > 1 {
                        atBottom = true
                        newBelow = 0
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
            }
            .onChange(of: atBottom) { _, bottom in
                if bottom { newBelow = 0 }
            }
            .overlay(alignment: .bottomTrailing) {
                if !atBottom {
                    JumpButton(arrow: "↓", count: newBelow) {
                        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                }
            }
            .animation(.easeOut(duration: 0.15), value: atBottom)
    }
}

/// "↓ 最新へ" / "↓ 新着 N" (chat) and "↑ 最新へ" / "↑ 新着 N" (timeline): back to the newest.
struct JumpButton: View {
    let arrow: String
    let count: Int
    let action: () -> Void

    var body: some View {
        let fresh = count > 0
        Button(action: action) {
            Text(fresh ? "\(arrow) 新着 \(count)" : "\(arrow) 最新へ")
                .font(.app(.caption, weight: .semibold))
                .monospacedDigit()
                .padding(.horizontal, 10).padding(.vertical, 6)
                .foregroundStyle(fresh ? Color.white : Color.primary)
                .background(fresh ? AnyShapeStyle(Color.accentGreen) : AnyShapeStyle(.regularMaterial), in: Capsule())
                .overlay(Capsule().strokeBorder(.separator.opacity(fresh ? 0 : 1)))
                .shadow(color: .black.opacity(0.12), radius: 3, y: 1)
        }
        .buttonStyle(.plain)
        .padding(10)
        .transition(.opacity)
        .accessibilityLabel(fresh ? "新着 \(count) 件、最新へ移動" : "最新へ移動")
    }
}

/// Whether the member is at the bottom, from where the list is scrolled to (macOS 15 /
/// iOS 18+). Only scrolling (or the view changing size) moves it: a new row growing the
/// content must not count as "scrolled up" — that made the list stop following right
/// after one's own message went out.
private struct BottomTracker: ViewModifier {
    @Binding var atBottom: Bool

    private struct Metrics: Equatable {
        /// Where the visible part starts (moves only when scrolled) and how tall it is.
        var top: CGFloat
        var height: CGFloat
        /// How far the visible part's bottom is from the end of the content.
        var below: CGFloat
    }

    func body(content: Content) -> some View {
        if #available(macOS 15.0, iOS 18.0, *) {
            content.onScrollGeometryChange(for: Metrics.self) { g in
                Metrics(top: g.visibleRect.minY, height: g.visibleRect.height,
                        below: g.contentSize.height - g.visibleRect.maxY)
            } action: { old, new in
                guard new.top != old.top || new.height != old.height else { return }
                // Near the end counts: a scroll to the bottom can land a little short while
                // rows the lazy stack only estimated get their real height.
                let bottom = new.below < 120
                if bottom != atBottom { atBottom = bottom }
            }
        } else {
            content
        }
    }
}

/// The last row of the list (the scroll target "bottom"). On systems without scroll
/// geometry it also tells whether the member is at the bottom.
struct ChatBottomSentinel: View {
    @Binding var atBottom: Bool
    var body: some View {
        if #available(macOS 15.0, iOS 18.0, *) {
            Color.clear.frame(height: 1).id("bottom")
        } else {
            Color.clear.frame(height: 1).id("bottom")
                .onAppear { atBottom = true }
                .onDisappear { atBottom = false }
        }
    }
}

/// "ここから未読" — drawn above the first message that was unread on opening.
struct UnreadDivider: View {
    var body: some View {
        HStack(spacing: 8) {
            Rectangle().fill(Color.accentGreen.opacity(0.5)).frame(height: 1)
            Text("ここから未読").font(.app(.caption2, weight: .semibold)).foregroundStyle(Color.accentGreen)
                .fixedSize()
            Rectangle().fill(Color.accentGreen.opacity(0.5)).frame(height: 1)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

extension View {
    func chatScrolling(store: ChatStore, proxy: ScrollViewProxy, atBottom: Binding<Bool>, newBelow: Binding<Int>) -> some View {
        modifier(ChatScrolling(store: store, proxy: proxy, atBottom: atBottom, newBelow: newBelow))
    }
}

// MARK: - The composer's state, shared by the list and the composer

/// What the message box holds. A class the list and the composer both see, so that typing
/// (draft), mention suggestions and the send button re-run only the composer — not the
/// whole chat with every row (each keystroke used to re-evaluate all of them).
@MainActor
@Observable
final class ChatComposerModel {
    var draft: String
    /// The message open in the composer for editing (the list marks its row).
    var editingId: Int?
    /// Photos attached to the next message (up to 4).
    let photos = PostDraft(maxImages: 4)
    /// iOS: the message box has the keyboard (bound to the text view).
    var focused = false
    /// Bumped when something asks the composer to take the focus (reply, edit, quote).
    private(set) var focusRequest = 0

    init(draft: String = "") { self.draft = draft }

    func requestFocus() {
        focused = true
        focusRequest += 1
    }

    /// 🐶 button: `@ビーグル ` at the start (once), so the question goes to Beagle (drikin 2026-10-24:
    /// typing the mention every time was a chore).
    func callBeagle() {
        if !BeagleOnDevice.asksBeagle(draft) {
            draft = "@\(BeagleOnDevice.name) " + draft.trimmingCharacters(in: .whitespaces)
        }
        requestFocus()
    }

    /// Reply to someone: `@name ` at the start of the composer (keeps what was typed).
    func replyTo(_ name: String) {
        let token = Mention.token(name)
        if !draft.hasPrefix(token) {
            draft = token + draft.trimmingCharacters(in: .whitespaces)
        }
        editingId = nil
        requestFocus()
    }

    func beginEdit(_ m: ChatMessage) {
        editingId = m.id
        draft = m.displayBody
        requestFocus()
    }

    func cancelEdit() {
        editingId = nil
        draft = ""
    }
}


/// 🐶 next to the camera: puts @ビーグル in the message box (only where this device can answer).
struct BeagleCallButton: View {
    let composer: ChatComposerModel
    var size: CGFloat
    var height: CGFloat

    var body: some View {
        Button { composer.callBeagle() } label: {
            Image(systemName: "dog").font(.app(size: size))
                .frame(width: size + 10, height: height)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .help("ビーグルに聞く（この端末の AI が答えて、チャットの全員に見えます）")
        .accessibilityLabel("ビーグルに聞く")
    }
}

/// 🐶 Beagle is writing an answer on this device.
struct BeagleThinkingLine: View {
    var body: some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.small)
            Text("🐶 ビーグルが考え中…（この端末の AI）").font(.app(.caption)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
        .transition(.opacity)
    }
}