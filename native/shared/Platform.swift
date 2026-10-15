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
