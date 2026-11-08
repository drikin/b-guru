import SwiftUI

// The chat's actions on one message — the hover buttons and the menu — shared by the chat (MessageRow)
// and ✉️👥 DM (DMMessageContent), so the two look and work the same (docs/dm-chat-parity-spec.md).

/// The buttons that hang off a bubble's outer top corner on hover: ❤️ in one click, 😊 for the picker,
/// ↩️ to reply (others'), ✏️ for your own. Hidden (and not hit-testable) until `hovering`.
struct MessageActionBar: View {
    let mine: Bool
    let canReact: Bool
    /// ✏️ is offered (the caller has checked it is mine and may be edited).
    let canEdit: Bool
    /// The message is stored and sent (not on its way / failed).
    let active: Bool
    let hovering: Bool
    var authorName: String? = nil
    var editHelp = "編集"
    let onReact: (String) -> Void
    let onEdit: () -> Void
    /// ↩️ Reply with an @mention (others' messages only; nil = no button).
    var onReply: (() -> Void)? = nil
    @State private var pickerOpen = false

    private var show: Bool { (hovering || pickerOpen || MessageRow.debugForceActions) && active }

    var body: some View {
        if canReact || canEdit || (!mine && onReply != nil) {
            HStack(spacing: 0) {
                if canReact {
                    ActionButton(systemImage: nil, text: "❤️", help: "❤️ を付ける（ダブルクリックでも）") { onReact("❤️") }
                    ActionButton(systemImage: "face.smiling", text: nil, help: "リアクションを選ぶ") { pickerOpen = true }
                        .popover(isPresented: $pickerOpen, arrowEdge: .bottom) {
                            ReactionPicker(onPick: { emoji in
                                pickerOpen = false
                                onReact(emoji)
                            }, onClose: { pickerOpen = false })
                            .presentationCompactAdaptation(.popover) // iPhone: stay a popover, not a full sheet
                        }
                }
                if let onReply, !mine {
                    ActionButton(systemImage: "arrowshape.turn.up.left", text: nil,
                                 help: "\(authorName ?? "") さんに返信（@メンション）", action: onReply)
                }
                if canEdit {
                    ActionButton(systemImage: "pencil", text: nil, help: editHelp, action: onEdit)
                }
            }
            .padding(2)
            .background(Capsule().fill(.background).shadow(color: .black.opacity(0.12), radius: 2, y: 1))
            .opacity(show ? 1 : 0)
            .animation(.easeOut(duration: 0.12), value: show)
            .allowsHitTesting(show)
            .accessibilityHidden(true) // exposed as accessibility actions on the row instead
        }
    }
}

extension View {
    /// Lays `bar` over this bubble's outer top corner. An overlay takes no space, so bubbles keep their
    /// full width and nothing jumps.
    func messageActionBar(mine: Bool, _ bar: some View) -> some View {
        overlay(alignment: mine ? .topLeading : .topTrailing) {
            bar
                .fixedSize()
                .alignmentGuide(mine ? .leading : .trailing) { d in
                    mine ? d[.trailing] - 14 : d[.leading] + 14
                }
                .offset(y: -12)
        }
    }
}

/// The long-press / right-click menu of a message: reply, DM, the quick reactions, 編集, copy, select.
struct MessageMenuItems: View {
    let mine: Bool
    /// The message is stored (id > 0).
    let stored: Bool
    let canReact: Bool
    /// 「編集」 is offered (mine and editable).
    let canEdit: Bool
    let text: String
    let onReact: (String) -> Void
    let onEdit: () -> Void
    var onReply: (() -> Void)? = nil
    var onDM: (() -> Void)? = nil
    /// iOS: 「テキストを選択」 (nil = not offered).
    var onSelect: (() -> Void)? = nil

    var body: some View {
        if let onReply, !mine, stored {
            Button("返信（@メンション）", systemImage: "arrowshape.turn.up.left", action: onReply)
        }
        if let onDM, !mine, stored {
            Button("DM を送る", systemImage: "envelope", action: onDM)
        }
        if canReact && stored {
            ForEach(MessageRow.quick, id: \.self) { e in Button(e) { onReact(e) } }
            Divider()
        }
        if canEdit && stored { Button("編集", action: onEdit) }
        Button("テキストをコピー", systemImage: "doc.on.doc") {
            Platform.copy(text)
        }
        #if os(iOS)
        if let onSelect { Button("テキストを選択", systemImage: "selection.pin.in.out", action: onSelect) }
        #endif
    }
}
