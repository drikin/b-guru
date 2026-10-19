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

    /// Sending also shrinks the composer (and a LazyVStack only estimates rows it
    /// hasn't drawn), so one scroll can land short of the bottom. Scroll now, then
    /// again once the layout has settled.
    private func toBottom(animated: Bool) {
        if animated {
            withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("bottom", anchor: .bottom) }
        } else {
            proxy.scrollTo("bottom", anchor: .bottom)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { proxy.scrollTo("bottom", anchor: .bottom) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { proxy.scrollTo("bottom", anchor: .bottom) }
    }

    func body(content: Content) -> some View {
        content
            .keepsBottomOnResize(atBottom)
            .modifier(BottomTracker(atBottom: $atBottom))
            .onChange(of: store.rows.last?.id) { _, _ in
                guard store.scrollTarget == nil, let last = store.rows.last?.message else { return }
                if last.isAuthor && last.id < 0 {
                    // My own message just went out: show it, and keep following while it
                    // settles (sending → sent, photos loading) — drikin 2026-10-19
                    // "投稿した時にスクロール位置が更新されない時がある".
                    atBottom = true
                    toBottom(animated: store.isVisible)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { if atBottom { proxy.scrollTo("bottom", anchor: .bottom) } }
                } else if atBottom {
                    toBottom(animated: store.isVisible)
                } else if !last.isAuthor && !last.isNotice {
                    newBelow += 1
                }
            }
            .onChange(of: store.openSeq) { _, _ in
                guard let id = store.unreadMarkerId,
                      let row = store.rows.first(where: { $0.message.id == id }) else { return }
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
                .font(.caption.weight(.semibold))
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
            Text("ここから未読").font(.caption2.weight(.semibold)).foregroundStyle(Color.accentGreen)
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
