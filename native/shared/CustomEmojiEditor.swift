import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// カスタム絵文字の登録（リアクションのピッカーの「＋ 登録」から）。誰でも（オーナー 2026-10-27）。
/// 画像を選ぶ（iPhone / iPad: 写真、Mac: ファイル）→ 名前 → 端末で 128px 以下の PNG に縮めて送る（256KB 以内の GIF はそのまま）。
/// 名前は入力中にサーバと同じ決まりで確かめ、送ったあとの失敗はサーバの言葉をそのまま出す。
struct EmojiRegisterView: View {
    let onDone: () -> Void
    @State private var name = ""
    @State private var prepared: CustomEmojiRules.Prepared?
    @State private var preview: PlatformImage?
    @State private var loading = false
    @State private var busy = false
    @State private var error: String?
    #if os(iOS)
    @State private var pick: PhotosPickerItem?
    #else
    @State private var importing = false
    #endif
    @FocusState private var nameFocused: Bool

    private var catalog: EmojiCatalog { EmojiCatalog.shared }
    private var normalized: String { CustomEmojiRules.normalized(name) }
    private var nameProblem: String? { CustomEmojiRules.nameProblem(name, taken: Set(catalog.names)) }
    private var canSend: Bool { prepared != nil && nameProblem == nil && !busy && !loading }

    var body: some View {
        DialogFrame(title: "カスタム絵文字を登録", confirm: "登録", busy: busy, canConfirm: canSend, error: error,
                    onCancel: onDone, onConfirm: send) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .center, spacing: 12) {
                    previewBox
                    VStack(alignment: .leading, spacing: 6) {
                        imageButton
                        Text("PNG・GIF・JPEG など。端末で小さくしてから送ります（256KB までの GIF は動くまま）。")
                            .font(.app(.caption)).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 2) {
                        Text(":").foregroundStyle(.secondary)
                        nameField
                        Text(":").foregroundStyle(.secondary)
                    }
                    .font(.app(.body).monospaced())
                    if !name.isEmpty, let p = nameProblem {
                        Text(p).font(.app(.caption)).foregroundStyle(.red)
                    } else {
                        Text("英小文字・数字・_ で 32 文字まで。リアクションでは :\(normalized.isEmpty ? "name" : normalized): になります。")
                            .font(.app(.caption)).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        #if os(macOS)
        .frame(width: 340)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.image], allowsMultipleSelection: false) { result in
            guard case let .success(urls) = result, let url = urls.first else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { error = "画像を読み込めませんでした"; return }
            Task { await use(data, filename: url.lastPathComponent) }
        }
        #else
        .onChange(of: pick) { _, item in
            guard let item else { return }
            pick = nil
            Task { await load(item) }
        }
        #endif
    }

    private var previewBox: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.06))
            if loading {
                ProgressView().controlSize(.small)
            } else if let preview {
                Image(platformImage: preview).resizable().interpolation(.high).scaledToFit().padding(6)
            } else {
                Image(systemName: "photo").font(.app(size: 22)).foregroundStyle(.secondary)
            }
        }
        .frame(width: 64, height: 64)
        .accessibilityLabel(preview == nil ? "画像なし" : "選んだ画像")
    }

    @ViewBuilder private var imageButton: some View {
        #if os(iOS)
        PhotosPicker(selection: $pick, matching: .images) {
            Label(prepared == nil ? "画像を選ぶ" : "画像を変える", systemImage: "photo.on.rectangle")
        }
        .disabled(busy)
        #else
        Button {
            importing = true
        } label: {
            Label(prepared == nil ? "画像を選ぶ…" : "画像を変える…", systemImage: "photo.on.rectangle")
        }
        .disabled(busy)
        #endif
    }

    private var nameField: some View {
        TextField("name", text: $name)
            .textFieldStyle(.roundedBorder)
            .focused($nameFocused)
            .autocorrectionDisabled()
            #if os(iOS)
            .textInputAutocapitalization(.never)
            .keyboardType(.asciiCapable)
            #endif
            .onSubmit { if canSend { send() } }
            .accessibilityLabel("絵文字の名前")
    }

    #if os(iOS)
    /// 写真のバイト列（iCloud にしか無い元画像はファイルとして受け取る）。
    private func load(_ item: PhotosPickerItem) async {
        loading = true
        defer { loading = false }
        var data: Data?
        if let d = try? await item.loadTransferable(type: Data.self), !d.isEmpty { data = d }
        if data == nil, let file = try? await item.loadTransferable(type: PickedImageFile.self) {
            data = try? Data(contentsOf: file.url)
            try? FileManager.default.removeItem(at: file.url)
        }
        guard let data else { error = "画像を読み込めませんでした（別の写真で試してください）"; return }
        await use(data, filename: nil)
    }
    #endif

    /// 縮めて（重いので裏で）、見本を出す。名前が空ならファイル名から候補を入れる。
    private func use(_ data: Data, filename: String?) async {
        loading = true
        defer { loading = false }
        let out = await Task.detached(priority: .userInitiated) { CustomEmojiRules.prepare(data) }.value
        guard let out, let cg = MediaCache.decode(out.data, maxPixel: CustomEmojiRules.maxPixel) else {
            error = "この画像は使えません（画像として読めないか、小さくしても 256KB を超えます）"
            return
        }
        error = nil
        prepared = out
        preview = PlatformImage.decoded(cg)
        if name.isEmpty, let filename {
            name = CustomEmojiRules.suggestedName(fromFilename: filename)
        }
        nameFocused = true
    }

    private func send() {
        guard let prepared, nameProblem == nil, !busy else { return }
        let n = normalized
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await catalog.register(name: n, image: prepared)
                onDone()
            } catch {
                self.error = PostActionsModel.message(error, fallback: "登録できませんでした")
            }
        }
    }
}

/// ピッカーの上に重ねる削除の確認（Mac のアラートはパネルのフォーカスを奪って閉じてしまうので、どちらも重ねる形）。
struct EmojiDeleteConfirm: View {
    let name: String
    let onDone: () -> Void
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 10) {
            ReactionGlyph(emoji: ":\(name):", size: 36).frame(width: 40, height: 40)
            Text(CustomEmojiRules.deleteWarning(name))
                .font(.app(.callout))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if let error {
                Text(error).font(.app(.caption)).foregroundStyle(.red).multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button("キャンセル", action: onDone)
                    .buttonStyle(FilledButtonStyle(fill: nil))
                    .keyboardShortcut(.cancelAction)
                Button(role: .destructive, action: delete) {
                    HStack(spacing: 6) {
                        if busy { ProgressView().controlSize(.small).tint(.white) }
                        Text("削除")
                    }
                }
                .buttonStyle(FilledButtonStyle(fill: .red))
                .disabled(busy)
            }
        }
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .shadow(radius: 8)
        .padding(12)
    }

    private func delete() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await EmojiCatalog.shared.delete(name: name)
                onDone()
            } catch {
                self.error = PostActionsModel.message(error, fallback: "削除できませんでした")
            }
        }
    }
}

#if os(macOS)
/// Mac のパネルの上に出す登録のダイアログ（ピッカーの「＋ 登録」が EmojiCatalog.registering を立てる）。
/// MainPanelView の ZStack に置く。この view だけが registering を読むので、パネル全体は描き直さない。
struct EmojiRegisterOverlay: View {
    var body: some View {
        if EmojiCatalog.shared.registering {
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea()
                    .onTapGesture { EmojiCatalog.shared.registering = false }
                EmojiRegisterView { EmojiCatalog.shared.registering = false }
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .shadow(radius: 12)
                    .padding(14)
            }
            .transition(.opacity)
        }
    }
}
#endif
