import SwiftUI
import UIKit
import GameController

/// The chat composer as a real UITextView, so Return on a hardware keyboard can
/// send WITHOUT stealing the Return that confirms a Japanese conversion.
///
/// Why not SwiftUI's TextField + onKeyPress: the input method consumes Return to
/// commit the conversion and only then does the key reach SwiftUI — by which time
/// the marked text is gone, so "is a conversion open?" is already false and the
/// message was sent mid-conversion (takuto 2026-10-16, iPad + external keyboard).
///
/// Here the rule is order-independent: a conversion confirmed with Return inserts
/// no "\n", while a plain Return does. So "\n" arriving from a hardware keyboard
/// (without Shift) = send. The on-screen keyboard's return key keeps inserting a
/// newline, as before. The rule for every platform: docs/composer-keys.md.
///
/// Hardware or on-screen is told by the key itself (2026-10-19): a hardware Return
/// arrives as a key press (pressesBegan) right before its "\n"; the on-screen return
/// key sends no press. (It used to be guessed from GameController and the keyboard's
/// height, which was wrong with a floating keyboard or a keyboard case left attached.)
struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    var placeholder: String
    var minLines = 1
    var maxLines = 6
    var onSubmit: () -> Void
    /// ↑ in an empty composer (hardware keyboard). Return true when handled.
    var onUpArrowWhenEmpty: () -> Bool = { false }
    /// Esc (hardware keyboard), not during a conversion. Return true when handled.
    var onEscape: () -> Bool = { false }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> ComposerUITextView {
        let tv = ComposerUITextView()
        tv.delegate = context.coordinator
        tv.font = .preferredFont(forTextStyle: .body)
        tv.adjustsFontForContentSizeCategory = true
        tv.backgroundColor = .clear
        tv.textContainerInset = .zero
        tv.textContainer.lineFragmentPadding = 0
        tv.isScrollEnabled = false
        tv.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        tv.placeholder = placeholder
        tv.text = text
        tv.updatePlaceholder()
        return tv
    }

    func updateUIView(_ tv: ComposerUITextView, context: Context) {
        context.coordinator.parent = self
        tv.onUpArrowWhenEmpty = onUpArrowWhenEmpty
        tv.onEscape = onEscape
        tv.onCommandReturn = onSubmit
        tv.placeholder = placeholder
        if tv.text != text {
            // Never fight an open conversion — except to clear after a send,
            // which must drop leftover marked text (voice input, IME).
            if text.isEmpty || tv.markedTextRange == nil {
                tv.text = text
                tv.selectedRange = NSRange(location: (text as NSString).length, length: 0)
            }
        }
        tv.updatePlaceholder()
        if isFocused, !tv.isFirstResponder {
            DispatchQueue.main.async { _ = tv.becomeFirstResponder() }
        } else if !isFocused, tv.isFirstResponder {
            DispatchQueue.main.async { _ = tv.resignFirstResponder() }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView tv: ComposerUITextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 300
        let line = tv.font?.lineHeight ?? 20
        let fitting = tv.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let maxHeight = line * CGFloat(maxLines)
        let scroll = fitting > maxHeight + 1
        if tv.isScrollEnabled != scroll { DispatchQueue.main.async { tv.isScrollEnabled = scroll } }
        return CGSize(width: width, height: min(max(fitting, line * CGFloat(minLines)), maxHeight))
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextView
        init(_ parent: ComposerTextView) { self.parent = parent }

        func textViewDidChange(_ tv: UITextView) {
            parent.text = tv.text
            (tv as? ComposerUITextView)?.updatePlaceholder()
        }

        func textView(_ tv: UITextView, shouldChangeTextIn range: NSRange, replacementText repl: String) -> Bool {
            guard repl == "\n", let ctv = tv as? ComposerUITextView, ctv.hardwareReturn, !ctv.shiftOnReturn else { return true }
            parent.onSubmit()
            return false
        }

        func textViewDidBeginEditing(_ tv: UITextView) { if !parent.isFocused { parent.isFocused = true } }
        func textViewDidEndEditing(_ tv: UITextView) { if parent.isFocused { parent.isFocused = false } }
    }
}

final class ComposerUITextView: UITextView {
    let placeholderLabel = UILabel()
    var onUpArrowWhenEmpty: (() -> Bool)?
    var onEscape: (() -> Bool)?
    /// ⌘Return on a hardware keyboard (sends, like Return).
    var onCommandReturn: (() -> Void)?
    /// The placeholder without the key hint.
    var placeholder = "" { didSet { updatePlaceholder() } }

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        placeholderLabel.textColor = .placeholderText
        placeholderLabel.font = .preferredFont(forTextStyle: .body)
        placeholderLabel.adjustsFontForContentSizeCategory = true
        placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(placeholderLabel)
        NSLayoutConstraint.activate([
            placeholderLabel.leadingAnchor.constraint(equalTo: leadingAnchor),
            placeholderLabel.topAnchor.constraint(equalTo: topAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func updatePlaceholder() {
        placeholderLabel.isHidden = !text.isEmpty || markedTextRange != nil
        // The key hint only when Return sends, i.e. with a hardware keyboard.
        let hint = GCKeyboard.coalesced != nil && !placeholder.isEmpty ? "（Enter 送信・⇧Enter 改行）" : ""
        if placeholderLabel.text != placeholder + hint { placeholderLabel.text = placeholder + hint }
    }

    /// The Return being handled came from a hardware key (its press is under way).
    private(set) var hardwareReturn = false
    private var returnShift = false

    /// Shift held with that Return (Shift+Return = newline).
    var shiftOnReturn: Bool { returnShift }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        NotificationCenter.default.removeObserver(self)
        guard window != nil else { return }
        // Keep the key hint in step with a keyboard being attached or removed.
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardsChanged),
                                               name: .GCKeyboardDidConnect, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardsChanged),
                                               name: .GCKeyboardDidDisconnect, object: nil)
    }

    @objc private func keyboardsChanged() { DispatchQueue.main.async { self.updatePlaceholder() } }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if let key = presses.first?.key, key.keyCode == .keyboardReturnOrEnter || key.keyCode == .keypadEnter {
            // ⌘Return sends (no "\n" is inserted for it); never during a conversion.
            if key.modifierFlags.contains(.command) {
                if markedTextRange == nil { onCommandReturn?() }
                return
            }
            hardwareReturn = true
            returnShift = key.modifierFlags.contains(.shift)
        }
        // ↑ / Esc belong to the input method while a conversion is open.
        if markedTextRange == nil, let key = presses.first?.key, key.modifierFlags.isDisjoint(with: [.shift, .command, .alternate, .control]) {
            switch key.keyCode {
            case .keyboardUpArrow where text.isEmpty:
                if onUpArrowWhenEmpty?() == true { return }
            case .keyboardEscape:
                if onEscape?() == true { return }
            default:
                break
            }
        }
        super.pressesBegan(presses, with: event)
    }

    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        super.pressesCancelled(presses, with: event)
        hardwareReturn = false
        returnShift = false
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        super.pressesEnded(presses, with: event)
        if presses.contains(where: { $0.key?.keyCode == .keyboardReturnOrEnter || $0.key?.keyCode == .keypadEnter }) {
            DispatchQueue.main.async { self.returnShift = false; self.hardwareReturn = false }
        }
    }

    override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
        super.setMarkedText(markedText, selectedRange: selectedRange)
        updatePlaceholder()
    }

    override func unmarkText() {
        super.unmarkText()
        updatePlaceholder()
    }
}
