import SwiftUI
#if os(macOS)
import AppKit
typealias PlatformImage = NSImage
#else
import UIKit
typealias PlatformImage = UIImage
#endif

/// The few AppKit / UIKit differences the shared views need, in one place.
enum Platform {
    static func copy(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }

    static func open(_ url: URL) {
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        UIApplication.shared.open(url)
        #endif
    }
}

extension Image {
    init(platformImage: PlatformImage) {
        #if os(macOS)
        self.init(nsImage: platformImage)
        #else
        self.init(uiImage: platformImage)
        #endif
    }
}

extension Color {
    static let accentGreen = Color(red: 0.086, green: 0.639, blue: 0.290) // B-guru #16a34a
}

extension View {
    /// When content height changes, keep the bottom edge fixed (chat reads
    /// bottom-up), so a row growing never pushes the latest messages out of view.
    /// Only while at the bottom: reading further up, new rows must not move the view.
    /// (macOS 15 / iOS 18+; older systems fall back to explicit scrolling.)
    @ViewBuilder func keepsBottomOnResize(_ enabled: Bool = true) -> some View {
        if #available(macOS 15.0, iOS 18.0, *) {
            self.defaultScrollAnchor(enabled ? .bottom : nil, for: .sizeChanges)
        } else {
            self
        }
    }

    /// Pull down at the top of the list to reload. iPhone / iPad: the system's
    /// .refreshable. Mac: SwiftUI has no pull there, so a trackpad pull past the top
    /// (the rubber band) does it, with a small spinner (macOS 15+).
    @ViewBuilder func pullToRefresh(_ action: @escaping @MainActor () async -> Void) -> some View {
        #if os(macOS)
        self.modifier(MacPullToRefresh(action: action))
        #else
        self.refreshable { await action() }
        #endif
    }

    /// A small text-link button (macOS has .link; iOS uses a borderless tinted button).
    @ViewBuilder func linkButton() -> some View {
        #if os(macOS)
        self.buttonStyle(.link)
        #else
        self.buttonStyle(.borderless)
        #endif
    }
}

/// True while an input method holds uncommitted text in the focused field —
/// Japanese conversion (Enter/↑/Esc belong to the IME then) or dictation.
/// SwiftUI's TextField does not expose this, so ask the text view itself.
@MainActor
enum TextComposition {
    static var isActive: Bool {
        #if os(macOS)
        return (NSApp.keyWindow?.firstResponder as? NSTextView)?.hasMarkedText() ?? false
        #else
        return (FirstResponderProbe.current() as? UITextInput)?.markedTextRange != nil
        #endif
    }
}

#if os(iOS)
/// UIKit has no public "current first responder"; a nil-targeted action reaches it.
@MainActor
private enum FirstResponderProbe {
    static weak var found: UIResponder?
    static func current() -> UIResponder? {
        found = nil
        UIApplication.shared.sendAction(#selector(UIResponder.bguruReportFirstResponder), to: nil, from: nil, for: nil)
        return found
    }
}

extension UIResponder {
    @objc fileprivate func bguruReportFirstResponder() { FirstResponderProbe.found = self }
}
#endif

/// Hide the software keyboard wherever it is (tap outside the composer, page switch).
/// macOS has no software keyboard: no-ops there.
@MainActor
enum Keyboard {
    static func dismiss() {
        #if os(iOS)
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        #endif
    }
}

extension View {
    /// Tapping this area (outside a text field) hides the keyboard. Simultaneous,
    /// so buttons, links and long-press menus inside keep working.
    @ViewBuilder func dismissesKeyboardOnTap() -> some View {
        #if os(iOS)
        simultaneousGesture(TapGesture().onEnded { Keyboard.dismiss() })
        #else
        self
        #endif
    }

    /// iOS-only modifiers that the shared timeline views use; no-ops on macOS.
    @ViewBuilder func inlineNavigationTitle() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }
}


/// Placeholder hint for composers that send on Return (Mac).
enum ComposerHint {
    static func with(_ base: String) -> String {
        #if os(macOS)
        return "\(base)（Enter 送信・⇧Enter 改行）"
        #else
        return base
        #endif
    }
}

extension View {
    /// Same keys as the chat composer, for the timeline's reply bar and new post (Mac):
    /// Return sends, ⇧Return inserts a newline at the caret, and the Return that
    /// confirms a Japanese conversion only confirms it (onSubmit does not fire for it).
    /// iOS: unchanged here (the on-screen keyboard's return key is a newline).
    @ViewBuilder func returnSends(_ action: @escaping () -> Void) -> some View {
        #if os(macOS)
        // Return is handled here, not by .onSubmit: on a multi-line (vertical) TextField
        // onSubmit sometimes did not fire and the message just stayed (drikin 2026-10-19
        // "Enter でチャットが送信できないときがある"). During a Japanese conversion the
        // Return belongs to the input method (it confirms the conversion).
        self
            .onKeyPress(keys: [.return], phases: .down) { press in
                guard !TextComposition.isActive else { return .ignored }
                if press.modifiers.contains(.shift) || press.modifiers.contains(.option) {
                    guard let editor = NSApp.keyWindow?.firstResponder as? NSTextView else { return .ignored }
                    editor.insertNewlineIgnoringFieldEditor(nil)
                    return .handled
                }
                guard press.modifiers.isDisjoint(with: [.command, .control]) else { return .ignored }
                action()
                return .handled
            }
        #else
        self
        #endif
    }
}

/// The text box of the timeline's reply bar and new post — the same keys as the chat:
/// iOS uses the chat's ComposerTextView (hardware Return sends, ⇧Return / the on-screen
/// return key = newline, conversion-confirming Return only confirms); macOS a TextField
/// with `returnSends` (Return sends, ⇧Return newline).
struct PostTextInput: View {
    @Binding var text: String
    @Binding var isFocused: Bool
    let placeholder: String
    var minLines = 1
    var maxLines = 6
    let onSubmit: () -> Void
    #if os(macOS)
    @FocusState private var focused: Bool
    #endif

    var body: some View {
        #if os(iOS)
        ComposerTextView(text: $text, isFocused: $isFocused, placeholder: placeholder,
                         minLines: minLines, maxLines: maxLines, onSubmit: onSubmit)
        #else
        TextField(ComposerHint.with(placeholder), text: $text, axis: .vertical)
            .lineLimit(minLines...maxLines)
            .focused($focused)
            .returnSends(onSubmit)
            .onChange(of: isFocused, initial: true) { _, v in if focused != v { focused = v } }
            .onChange(of: focused) { _, v in if isFocused != v { isFocused = v } }
        #endif
    }
}

#if os(macOS)
/// The Mac's pull-to-reload: pulling the list past its top by this much reloads once
/// (again only after it has gone back).
struct MacPullToRefresh: ViewModifier {
    let action: @MainActor () async -> Void
    @State private var pull: CGFloat = 0
    @State private var refreshing = false
    @State private var armed = true
    private let threshold: CGFloat = 56

    func body(content: Content) -> some View {
        if #available(macOS 15.0, *) {
            content
                .onScrollGeometryChange(for: CGFloat.self) { g in
                    -(g.contentOffset.y + g.contentInsets.top)
                } action: { _, over in
                    // Only while pulled past the top: plain scrolling must not update state
                    // every frame (it made all scrolling heavier).
                    let p = max(0, over)
                    if p != pull, p > 0 || pull > 0 { pull = p }
                    if over <= 1, !armed { armed = true }
                    guard over > threshold, armed, !refreshing else { return }
                    armed = false
                    refreshing = true
                    Task { @MainActor in
                        await action()
                        refreshing = false
                    }
                }
                .overlay(alignment: .top) {
                    if refreshing || pull > 6 {
                        ProgressView()
                            .controlSize(.small)
                            .padding(.top, 6)
                            .opacity(refreshing ? 1 : min(1, pull / threshold))
                            .allowsHitTesting(false)
                    }
                }
        } else {
            content
        }
    }
}
#endif
