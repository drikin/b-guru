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
/// newline, as before.
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
        tv.placeholderLabel.text = placeholder
        tv.text = text
        tv.updatePlaceholder()
        return tv
    }

    func updateUIView(_ tv: ComposerUITextView, context: Context) {
        context.coordinator.parent = self
        tv.onUpArrowWhenEmpty = onUpArrowWhenEmpty
        tv.onEscape = onEscape
        tv.placeholderLabel.text = placeholder
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
            guard repl == "\n", let ctv = tv as? ComposerUITextView, ctv.hardwareKeyboard, !ctv.shiftOnReturn else { return true }
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

    func updatePlaceholder() { placeholderLabel.isHidden = !text.isEmpty || markedTextRange != nil }

    /// Height of the on-screen keyboard last time it moved. With an external
    /// keyboard only the small shortcut bar (or nothing) is shown.
    private var softKeyboardHeight: CGFloat = 0
    private var returnShift = false

    /// A hardware keyboard is in use: GameController says so, or the on-screen
    /// keyboard is not up while we are editing (either signal is enough).
    var hardwareKeyboard: Bool {
        GCKeyboard.coalesced != nil || (isFirstResponder && softKeyboardHeight < 120)
    }

    /// Shift held with Return (Shift+Return = newline).
    var shiftOnReturn: Bool {
        if returnShift { return true }
        guard let input = GCKeyboard.coalesced?.keyboardInput else { return false }
        return input.button(forKeyCode: .leftShift)?.isPressed == true || input.button(forKeyCode: .rightShift)?.isPressed == true
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        NotificationCenter.default.removeObserver(self)
        guard window != nil else { return }
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardFrame(_:)),
                                               name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardFrame(_:)),
                                               name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    @objc private func keyboardFrame(_ note: Notification) {
        guard let end = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
              let screen = window?.windowScene?.screen else { return }
        softKeyboardHeight = note.name == UIResponder.keyboardWillHideNotification
            ? 0 : max(0, screen.bounds.intersection(end).height)
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if let key = presses.first?.key, key.keyCode == .keyboardReturnOrEnter || key.keyCode == .keypadEnter {
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

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        super.pressesEnded(presses, with: event)
        if presses.contains(where: { $0.key?.keyCode == .keyboardReturnOrEnter || $0.key?.keyCode == .keypadEnter }) {
            DispatchQueue.main.async { self.returnShift = false }
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
