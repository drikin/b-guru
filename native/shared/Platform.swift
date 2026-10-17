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
    /// (macOS 15 / iOS 18+; older systems fall back to explicit scrolling.)
    @ViewBuilder func keepsBottomOnResize() -> some View {
        if #available(macOS 15.0, iOS 18.0, *) {
            self.defaultScrollAnchor(.bottom, for: .sizeChanges)
        } else {
            self
        }
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

extension PlatformImage {
    /// JPEG for upload: long side ≤ maxSide, redrawn so EXIF (GPS etc.) is dropped.
    func uploadJPEG(maxSide: CGFloat = 2048, quality: CGFloat = 0.82) -> Data? {
        #if os(iOS)
        let size = self.size
        let scale = min(1, maxSide / max(size.width, size.height))
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            self.draw(in: CGRect(origin: .zero, size: target))
        }
        return resized.jpegData(compressionQuality: quality)
        #else
        guard let cg = cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let w = CGFloat(cg.width), h = CGFloat(cg.height)
        let scale = min(1, maxSide / max(w, h))
        let tw = Int((w * scale).rounded()), th = Int((h * scale).rounded())
        guard let ctx = CGContext(data: nil, width: tw, height: th, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: tw, height: th))
        guard let out = ctx.makeImage() else { return nil }
        return NSBitmapImageRep(cgImage: out).representation(using: .jpeg, properties: [.compressionFactor: quality])
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
        self
            .onSubmit(action)
            .onKeyPress(keys: [.return], phases: .down) { press in
                guard press.modifiers.contains(.shift), !TextComposition.isActive,
                      let editor = NSApp.keyWindow?.firstResponder as? NSTextView else { return .ignored }
                editor.insertNewlineIgnoringFieldEditor(nil)
                return .handled
            }
        #else
        self
        #endif
    }
}
