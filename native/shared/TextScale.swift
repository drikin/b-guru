import SwiftUI
import Observation

/// How large the app's text is drawn (drikin 2026-10-24: 老眼対策で文字を大きく).
/// macOS has no Dynamic Type — `dynamicTypeSize` changes nothing there (measured) — so the
/// Mac draws every text style at its own size × `scale`, chosen in the panel (⌘+ / ⌘− / ⌘0,
/// ⋯ menu). iPhone / iPad keep the system's text size setting (scale stays 1 there).
/// Every `.font` in the app goes through `Font.app`; a body that reads it is redrawn when
/// the scale changes (it is observed), with its state kept (scroll position, drafts).
@MainActor
@Observable
final class TextScale {
    static let shared = TextScale()

    /// The choices, smallest first (1 = the system's size).
    static let steps: [CGFloat] = [0.9, 1.0, 1.1, 1.2, 1.35, 1.5, 1.7, 2.0]

    private(set) var scale: CGFloat

    private init() {
        #if os(macOS)
        let saved = UserDefaults.standard.double(forKey: "textScale")
        scale = Self.steps.contains(CGFloat(saved)) ? CGFloat(saved) : 1
        #else
        scale = 1
        #endif
    }

    func set(_ s: CGFloat) {
        let s = Self.steps.min { abs($0 - s) < abs($1 - s) } ?? 1
        guard s != scale else { return }
        scale = s
        UserDefaults.standard.set(Double(s), forKey: "textScale")
    }
    func larger() { if let i = Self.steps.firstIndex(of: scale), i + 1 < Self.steps.count { set(Self.steps[i + 1]) } }
    func smaller() { if let i = Self.steps.firstIndex(of: scale), i > 0 { set(Self.steps[i - 1]) } }
    func reset() { set(1) }
    var canGrow: Bool { scale < Self.steps.last! }
    var canShrink: Bool { scale > Self.steps.first! }
    var percent: Int { Int((scale * 100).rounded()) }

    #if os(macOS)
    /// macOS's own sizes of the text styles (points) — what `.font(.caption)` etc. draw at.
    static func points(_ style: Font.TextStyle) -> CGFloat {
        switch style {
        case .largeTitle: return 26
        case .title: return 22
        case .title2: return 17
        case .title3: return 15
        case .headline, .body: return 13
        case .callout: return 12
        case .subheadline: return 11
        case .footnote, .caption: return 10
        case .caption2: return 10
        @unknown default: return 13
        }
    }
    #endif
}

extension Font {
    /// A text style at the app's text size (`TextScale`).
    @MainActor static func app(_ style: Font.TextStyle, weight: Font.Weight? = nil, design: Font.Design? = nil) -> Font {
        #if os(macOS)
        let w = weight ?? (style == .headline ? .bold : .regular)
        return .system(size: TextScale.points(style) * TextScale.shared.scale, weight: w, design: design ?? .default)
        #else
        return .system(style, design: design, weight: weight)
        #endif
    }

    /// A fixed size (icons, emoji) at the app's text size.
    @MainActor static func app(size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default) -> Font {
        .system(size: size * TextScale.shared.scale, weight: weight, design: design)
    }
}
