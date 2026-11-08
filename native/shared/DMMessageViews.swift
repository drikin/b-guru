import SwiftUI

// ✉️👥 DM — what a message shows inside its bubble, with the chat's features (docs/dm-chat-parity-spec.md):
// photos, the text (links: B-guru's post links open the thread in the app through the environment's
// openURL, as in the chat; @mentions tinted; my mention = the chat's yellow), 📺 「みんなで見る」 under a
// YouTube link, the hover buttons and the menu (MessageActions.swift, the chat's own), ❤️ on a double tap
// (iPhone / iPad) and the reaction chips (ReactionChips, the chat's).

struct DMMessageContent: View {
    let mine: Bool
    let text: String
    let images: [String]
    /// Previews of photos still being sent (the stored message has their URLs instead).
    var localImages: [PlatformImage] = []
    /// Sent and stored (may be reacted to / edited).
    let stored: Bool
    var mentionsMe = false
    /// This message is open in the composer for editing.
    var editing = false
    let reactions: [Reaction]
    let canReact: Bool
    /// ✏️ offered (mine and editable).
    let canEdit: Bool
    /// The sender's name (the reply button's help, the select sheet's title).
    var authorName: String? = nil
    /// Tap on a photo: open it full screen (index into `images`).
    var onOpenImage: ((Int) -> Void)? = nil
    let onReact: (String) -> Void
    let onEdit: () -> Void
    /// ↩️ (group DM, others' messages): `@名前 ` into the composer.
    var onReply: (() -> Void)? = nil

    @Environment(\.watch) private var watch
    @State private var hovering = false
    @State private var selecting = false

    private var hasPhotos: Bool { !images.isEmpty || !localImages.isEmpty }

    var body: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 2) {
            if hasPhotos {
                // 📷 the chat's photo grid (one big, or two columns), tap = full screen.
                ChatPhotos(paths: images, local: images.isEmpty ? localImages : [], onOpen: onOpenImage)
                    .padding(.bottom, text.isEmpty ? 0 : 2)
            }
            if !text.isEmpty || !hasPhotos { textBubble }
            if let watch, let url = WatchStore.firstVideoURL(in: text) {
                // 📺 a YouTube link: 「みんなで見る」 under the bubble (as in the chat).
                WatchTogetherButton(watch: watch, url: url)
            }
            if !reactions.isEmpty {
                ReactionChips(reactions: reactions, enabled: canReact && stored, onTap: onReact)
            }
        }
        // The whole row's width (the chat puts the menu on the whole row): the hover buttons hang outside
        // the bubble and must stay inside what takes the taps. The 40pt keeps the other side's gap.
        .padding(mine ? .leading : .trailing, 40)
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .contextMenu {
            MessageMenuItems(mine: mine, stored: stored, canReact: canReact, canEdit: canEdit, text: text,
                             onReact: onReact, onEdit: onEdit, onReply: onReply, onSelect: { selecting = true })
        }
        .sheet(isPresented: $selecting) {
            SelectableTextSheet(author: authorName ?? "メッセージ", text: text)
        }
    }

    private var textBubble: some View {
        let emojiOnly = MessageRow.isEmojiOnly(text)
        return Text(MessageRow.attributed(text))
            .font(emojiOnly ? .app(size: 34) : .app(.body))
            #if os(macOS)
            .textSelection(.enabled)
            #endif
            .padding(.horizontal, emojiOnly ? 4 : 10)
            .padding(.vertical, emojiOnly ? 0 : 6)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(emojiOnly ? Color.clear : (mine ? Color.accentGreen.opacity(0.14)
                        : (mentionsMe ? Color.yellow.opacity(0.22) : Color.primary.opacity(0.06))))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Color.accentGreen, lineWidth: editing ? 1.5 : 0)
            )
            #if os(iOS)
            // iOS: double-tap = ❤️ (as in the chat; text selection lives in the menu).
            .onTapGesture(count: 2) { if canReact && stored { onReact("❤️") } }
            #endif
            .messageActionBar(mine: mine, MessageActionBar(
                mine: mine, canReact: canReact, canEdit: canEdit, active: stored, hovering: hovering,
                authorName: authorName, onReact: onReact, onEdit: onEdit, onReply: onReply))
    }
}

/// 「編集済み」 and the time under a DM bubble (the chat's words and colour).
struct DMTimeLine: View {
    let createdAt: String
    let edited: Bool

    var body: some View {
        HStack(spacing: 6) {
            if edited { Text("編集済み").font(.app(.caption2)).foregroundStyle(Color.accentGreen) }
            Text(MessageRow.time(createdAt)).font(.app(.caption2)).foregroundStyle(.tertiary).monospacedDigit()
        }
    }
}

/// 「メッセージを編集中  キャンセル」 over the composer (the chat's).
struct DMEditingBar: View {
    let onCancel: () -> Void

    var body: some View {
        HStack {
            Text("メッセージを編集中").font(.app(.caption)).foregroundStyle(Color.accentGreen)
            Spacer()
            Button("キャンセル", action: onCancel).buttonStyle(.borderless).font(.app(.caption))
        }
    }
}
