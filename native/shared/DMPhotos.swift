import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

// 📷 DM の写真（docs/dm-photos-spec.md）— the composer's buttons and the Mac's paste / drop, shared by the
// 1:1 conversation (DMView.swift) and the group's (GroupDMView.swift). The tray is the chat's DraftImages,
// the bubbles' photos the chat's ChatPhotos, the full-screen view the chat's imageViewer.

extension Notification.Name {
    /// Mac: ⌘V with an image on the pasteboard while a DM / group conversation is open (object: image Data).
    /// Sent by the panel (ChatPanel.sendEvent) instead of the chat's chatPasteImage.
    static let dmPasteImage = Notification.Name("fm.backspace.bguru.dmPasteImage")
}

/// [写真] (and [カメラ] on iPhone / iPad) next to the DM's text box.
struct DMAttachButtons: View {
    let draft: PostDraft
    #if os(macOS)
    @State private var importing = false
    #endif

    private var full: Bool { draft.images.count >= draft.maxImages }

    var body: some View {
        #if os(iOS)
        PhotosPicker(selection: Bindable(draft).picks, maxSelectionCount: max(1, draft.maxImages - draft.images.count), matching: .images) {
            Image(systemName: "photo").font(.app(size: 20))
                .frame(width: 28, height: 34)
        }
        .disabled(full)
        .accessibilityLabel("写真を付ける")
        CameraButton(draft: draft) {
            Image(systemName: "camera").font(.app(size: 19))
                .frame(width: 28, height: 34)
        }
        #else
        Button { importing = true } label: {
            Image(systemName: "photo").font(.app(size: 15))
                .frame(width: 26, height: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .disabled(full)
        .help("写真を付ける（ドラッグ＆ドロップ・⌘V でも）")
        .accessibilityLabel("写真を付ける")
        .fileImporter(isPresented: $importing, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            if case let .success(urls) = result { draft.add(fileURLs: urls) }
        }
        #endif
    }
}

/// The tray of attached photos (with ✕) and what went wrong reading one.
struct DMDraftTray: View {
    let draft: PostDraft

    var body: some View {
        DraftImages(draft: draft)
        if let e = draft.error { Text(e).font(.app(.caption)).foregroundStyle(.red) }
    }
}

extension View {
    /// Mac: images dropped on the conversation, and ⌘V of an image (the panel sends it), go into `draft`.
    @ViewBuilder func dmPhotoInput(_ draft: PostDraft, enabled: Bool) -> some View {
        #if os(macOS)
        self
            .dropDestination(for: URL.self) { urls, _ in
                guard enabled else { return false }
                draft.add(fileURLs: urls)
                return true
            }
            .onReceive(NotificationCenter.default.publisher(for: .dmPasteImage)) { note in
                guard enabled, let data = note.object as? Data else { return }
                draft.add(imageData: data)
            }
        #else
        self
        #endif
    }
}

// 📷 タイムラインの新規投稿・スレッドの返信へのクリップボードの画像（2026-11-13 フィードバック「タイムラインでは
// 貼れない、チャットでは貼れる」）. iOS: PostTextInput's onPasteImage. Mac: the panel takes ⌘V first
// (ChatPanel.sendEvent) and sends it here while a timeline composer is the paste target.

extension Notification.Name {
    /// Mac: ⌘V with an image on the pasteboard while a timeline composer is the target (object: image Data).
    static let timelinePasteImage = Notification.Name("fm.backspace.bguru.timelinePasteImage")
}

/// Mac: the timeline composer that takes ⌘V of an image — the new post while it is open, the
/// thread's reply bar while its field has focus. The last one to become active wins, so one paste
/// attaches once. nil: the chat / DM take it as before.
@MainActor
enum TimelinePaste {
    static var owner: UUID?
}

extension View {
    /// Mac: while `active`, ⌘V of an image (the panel sends it) goes into `draft`. iOS: nothing
    /// (the text box's onPasteImage does it).
    @ViewBuilder func timelinePhotoPaste(_ draft: PostDraft, active: Bool) -> some View {
        #if os(macOS)
        modifier(TimelinePasteTarget(draft: draft, active: active))
        #else
        self
        #endif
    }
}

#if os(macOS)
private struct TimelinePasteTarget: ViewModifier {
    let draft: PostDraft
    let active: Bool
    @State private var id = UUID()

    func body(content: Content) -> some View {
        content
            .onChange(of: active, initial: true) { _, on in
                if on { TimelinePaste.owner = id } else if TimelinePaste.owner == id { TimelinePaste.owner = nil }
            }
            .onDisappear { if TimelinePaste.owner == id { TimelinePaste.owner = nil } }
            .onReceive(NotificationCenter.default.publisher(for: .timelinePasteImage)) { note in
                guard TimelinePaste.owner == id, let data = note.object as? Data else { return }
                draft.add(imageData: data)
            }
    }
}
#endif
