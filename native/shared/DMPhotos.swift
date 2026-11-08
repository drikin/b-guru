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
