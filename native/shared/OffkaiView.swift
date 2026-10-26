import SwiftUI
import PhotosUI

// 🍻 オフ会の面 (above the chat, like ☗ / 🎮): not going on → 「🍻 オフ会を始める」 and the archive;
// going on → who is speaking, 🔊 聞く / 🎙 現地から話す / 終了, the album (oldest first) and 📷.
// Tapping a photo opens it large (左右で前後); my own photo can be deleted (long press / the viewer's 🗑).

struct OffkaiScreen: View {
    let offkai: OffkaiStore
    @State private var viewing: OffkaiViewerItem?

    var body: some View {
        Group {
            if let album = offkai.album {
                OffkaiAlbumView(offkai: offkai, event: album) { viewing = OffkaiViewerItem(index: $0, album: true) }
            } else if let e = offkai.running {
                OffkaiRunningView(offkai: offkai, event: e) { viewing = OffkaiViewerItem(index: $0, album: false) }
            } else {
                OffkaiIdleView(offkai: offkai)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .offkaiViewer($viewing, offkai: offkai)
    }

    /// About half the chat column (the chat keeps the rest), at least enough for the buttons and a row of photos.
    private var height: CGFloat {
        let area = offkai.areaHeight > 0 ? offkai.areaHeight : 700
        return max(240, min(area * 0.5, 480))
    }
}

/// iPhone: while typing in the chat, the panel folds into one line (like ☗).
struct OffkaiFoldedBar: View {
    let offkai: OffkaiStore
    let onUnfold: () -> Void

    var body: some View {
        Button(action: onUnfold) {
            HStack(spacing: 6) {
                Text(summary).font(.app(.caption)).lineLimit(1)
                Spacer(minLength: 0)
                Text("🍻 を表示").font(.app(.caption, weight: .semibold)).foregroundStyle(Color.accentGreen)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var summary: String {
        guard let e = offkai.running else { return "🍻 オフ会" }
        var s = "🍻 \(e.displayTitle)・🎧\(offkai.listeners)"
        if offkai.speaking { s += "・🎙 話しています" } else if offkai.audio == .listening { s += "・🔊 聞いています" }
        return s
    }
}

// MARK: - Going on

private struct OffkaiRunningView: View {
    let offkai: OffkaiStore
    let event: OffkaiEvent
    let onOpen: (Int) -> Void
    @State private var confirmEnd = false

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 12)
                .padding(.top, 8)
                .padding(.bottom, 6)
            Divider()
            OffkaiPhotoGrid(photos: offkai.photos, offkai: offkai, empty: "まだ写真はありません。📷 から上げられます", newestAtBottom: true, onOpen: onOpen)
            if offkai.canControl {
                Divider()
                OffkaiPhotoBar(offkai: offkai)
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("🍻 \(event.displayTitle)").font(.app(.subheadline, weight: .bold)).lineLimit(1)
                TimelineView(.periodic(from: .now, by: 30)) { ctx in
                    Text(OffkaiStore.elapsed(since: event.started, now: ctx.date))
                        .font(.app(.caption)).foregroundStyle(.secondary).monospacedDigit()
                        .accessibilityLabel("開始から \(OffkaiStore.elapsed(since: event.started, now: ctx.date))")
                }
                Spacer(minLength: 4)
                Text("🎧 \(offkai.listeners)")
                    .font(.app(.caption)).foregroundStyle(.secondary).monospacedDigit()
                    .help("聞いている人")
                    .accessibilityLabel("聞いている人 \(offkai.listeners) 人")
            }
            speakerLine
            HStack(spacing: 8) {
                Button { Task { await offkai.toggleListen() } } label: {
                    pill(listenLabel, filled: offkai.audio != .off)
                }
                .buttonStyle(.plain)
                .disabled(offkai.audio == .connecting)
                if offkai.canControl {
                    Button { Task { offkai.speaking || offkai.iAmSpeaker ? await offkai.stopSpeaking() : await offkai.startSpeaking() } } label: {
                        pill(offkai.speaking || offkai.iAmSpeaker ? "話すのをやめる" : "🎙 現地から話す", filled: offkai.speaking, tint: .red)
                    }
                    .buttonStyle(.plain)
                    .disabled(offkai.busy)
                    .help("現地の 1 台だけが話します（後から押した人に切り替わります）")
                }
                #if os(macOS)
                if offkai.audio == .listening {
                    VoiceHandoffButton(handoff: offkai.handoff, target: .offkai, mic: offkai.speaking || offkai.iAmSpeaker) {
                        pill("📱 スマホで続ける", filled: false)
                    }
                    .buttonStyle(.plain)
                }
                #endif
                Spacer(minLength: 0)
                if offkai.canEnd {
                    Button("終了") { confirmEnd = true }
                        .font(.app(.caption, weight: .semibold))
                        .buttonStyle(.borderless)
                        .foregroundStyle(.red)
                        .disabled(offkai.busy)
                        .confirmationDialog("オフ会を終了しますか？", isPresented: $confirmEnd, titleVisibility: .visible) {
                            Button("終了する", role: .destructive) { Task { await offkai.end() } }
                            Button("やめておく", role: .cancel) {}
                        } message: {
                            Text("声は止まり、写真はアーカイブに残ります。")
                        }
                }
            }
            OffkaiReadAloudToggle(offkai: offkai, font: .app(.caption))
            if let n = offkai.notice {
                Text(n).font(.app(.caption2)).foregroundStyle(.secondary).lineLimit(2)
            }
            #if os(macOS)
            if offkai.audio != .off { VoiceHandoffNotice(handoff: offkai.handoff, target: .offkai, font: .app(.caption2)) }
            #endif
        }
    }

    @ViewBuilder private var speakerLine: some View {
        if let s = event.speaker, s.connected == true {
            HStack(spacing: 4) {
                Image(systemName: "waveform").foregroundStyle(Color.accentGreen)
                Text(offkai.iAmSpeaker ? "あなたが現地から話しています" : "\(s.displayName)が話しています")
            }
            .font(.app(.caption))
            .lineLimit(1)
        } else {
            Text(offkai.iAmSpeaker ? "マイクの準備中…" : "いまは誰も話していません")
                .font(.app(.caption)).foregroundStyle(.secondary)
        }
    }

    private var listenLabel: String {
        switch offkai.audio {
        case .off: return "🔊 聞く"
        case .connecting: return "つないでいます…"
        case .listening: return "止める"
        }
    }

    private func pill(_ text: String, filled: Bool, tint: Color = .accentColor) -> some View {
        Text(text)
            .font(.app(.caption, weight: .semibold))
            .foregroundStyle(filled ? Color.white : Color.primary)
            .padding(.horizontal, 12)
            .frame(height: 28)
            .background(Capsule().fill(filled ? tint : Color.primary.opacity(0.08)))
            .contentShape(Capsule())
    }
}

/// 「🔈 チャットを読み上げる」: this device's switch (default on). It only sounds while this device is in the
/// event's sound, so the hint says so while it is not.
struct OffkaiReadAloudToggle: View {
    let offkai: OffkaiStore
    var font: Font
    /// The small window (188 pt wide): 「🔈 チャット読み上げ」 and no hint.
    var compact = false

    var body: some View {
        Button { offkai.readChatAloud.toggle() } label: {
            HStack(spacing: 5) {
                Image(systemName: offkai.readChatAloud ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(offkai.readChatAloud ? Color.accentColor : Color.secondary)
                Text(compact ? "🔈 チャット読み上げ" : "🔈 チャットを読み上げる")
                    .foregroundStyle(offkai.readChatAloud ? Color.primary : Color.secondary)
                if !compact, offkai.readChatAloud, offkai.audio == .off {
                    Text("（聞いている間）").foregroundStyle(.secondary)
                }
            }
            .font(font)
            .lineLimit(1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("この端末で 🍻 の音声に入っている間、届いたチャットを読み上げます（この端末だけの設定）")
        .accessibilityLabel("チャットを読み上げる")
        .accessibilityValue(offkai.readChatAloud ? "オン" : "オフ")
        .accessibilityAddTraits(.isToggle)
    }
}

/// 「🔈 読み上げ」 in the chat's header (docs/offkai-spec.md「チャット欄の読み上げ」): every new message read
/// aloud on this device, 🍻 or not. Off by default; the icon shows which (🔈 with waves = on).
struct ChatReadAloudButton: View {
    let store: ChatStore

    var body: some View {
        Button { store.readAloud.toggle() } label: {
            Image(systemName: store.readAloud ? "speaker.wave.2.fill" : "speaker.slash")
                .foregroundStyle(store.readAloud ? Color.accentColor : Color.secondary)
                .contentShape(Rectangle())
        }
        .help(store.readAloud ? "読み上げ：オン（届いた発言をこの端末で読み上げます。押すと止める）"
                              : "読み上げ：オフ（押すと、届いた発言をこの端末で読み上げます）")
        .accessibilityLabel("🔈 読み上げ")
        .accessibilityValue(store.readAloud ? "オン" : "オフ")
        .accessibilityAddTraits(.isToggle)
    }
}

/// 📷 (and the camera on iPhone): the picked photos with one caption, then 送る.
private struct OffkaiPhotoBar: View {
    @Bindable var offkai: OffkaiStore
    @Bindable var draft: PostDraft
    #if os(macOS)
    @State private var importing = false
    #endif

    init(offkai: OffkaiStore) {
        self.offkai = offkai
        self.draft = offkai.draft
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !draft.images.isEmpty {
                DraftImages(draft: draft)
                HStack(spacing: 8) {
                    TextField("ひとこと（任意）", text: $offkai.caption)
                        .textFieldStyle(.roundedBorder)
                        .font(.app(.caption))
                    Button {
                        Task { await offkai.sendPhotos() }
                    } label: {
                        if offkai.uploading { ProgressView().controlSize(.small) } else { Text("送る").font(.app(.caption, weight: .bold)) }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(offkai.uploading)
                }
            }
            if let e = draft.error { Text(e).font(.app(.caption2)).foregroundStyle(.red) }
            HStack(spacing: 14) {
                #if os(iOS)
                PhotosPicker(selection: $draft.picks, maxSelectionCount: max(1, draft.maxImages - draft.images.count), matching: .images) {
                    Label("写真を選ぶ", systemImage: "photo.on.rectangle").font(.app(.caption))
                }
                .disabled(draft.images.count >= draft.maxImages || offkai.uploading)
                CameraButton(draft: draft) { Label("撮る", systemImage: "camera") }
                    .font(.app(.caption))
                #else
                Button { importing = true } label: {
                    Label("写真を選ぶ", systemImage: "photo.on.rectangle").font(.app(.caption))
                }
                .buttonStyle(.borderless)
                .disabled(draft.images.count >= draft.maxImages || offkai.uploading)
                .fileImporter(isPresented: $importing, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
                    if case let .success(urls) = result { draft.add(fileURLs: urls) }
                }
                #endif
                Spacer(minLength: 0)
                Text("📷 4 枚まで・チャットにも流れます").font(.app(.caption2)).foregroundStyle(.tertiary).lineLimit(1)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }
}

// MARK: - Not going on

private struct OffkaiIdleView: View {
    let offkai: OffkaiStore
    @State private var title = ""

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if offkai.canControl {
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("場所・ひとこと（任意）", text: $title)
                            .textFieldStyle(.roundedBorder)
                            .font(.app(.subheadline))
                            .onChange(of: title) { _, t in if t.count > 40 { title = String(t.prefix(40)) } }
                            .onSubmit { begin() }
                        Button(action: begin) {
                            Text(offkai.busy ? "始めています…" : "🍻 オフ会を始める")
                                .font(.app(.subheadline, weight: .bold))
                                .frame(maxWidth: .infinity)
                                .frame(height: 34)
                                .foregroundStyle(.white)
                                .background(RoundedRectangle(cornerRadius: 9).fill(Color.accentGreen))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(offkai.busy)
                        Text("現地の 1 台が声を流し、みんなで写真を上げられます。始まると全員に 1 回だけ知らせます。")
                            .font(.app(.caption2)).foregroundStyle(.secondary)
                    }
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.05)))
                }
                if let n = offkai.notice {
                    Text(n).font(.app(.caption)).foregroundStyle(.secondary)
                }
                Text("これまでのオフ会").font(.app(.caption, weight: .semibold)).foregroundStyle(.secondary)
                if offkai.archive.isEmpty {
                    Text("まだありません").font(.app(.caption)).foregroundStyle(.tertiary)
                }
                ForEach(offkai.archive) { e in
                    Button { offkai.openAlbum(e) } label: { OffkaiArchiveRow(event: e) }
                        .buttonStyle(.plain)
                }
                if offkai.archiveHasMore {
                    Button {
                        Task { await offkai.loadMoreArchive() }
                    } label: {
                        Text(offkai.loadingArchive ? "読み込み中…" : "もっと見る")
                            .font(.app(.caption, weight: .semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderless)
                    .disabled(offkai.loadingArchive)
                }
            }
            .padding(12)
        }
    }

    private func begin() {
        guard !offkai.busy else { return }
        let t = title
        Task {
            await offkai.start(title: t)
            if offkai.running != nil { title = "" }
        }
    }
}

private struct OffkaiArchiveRow: View {
    let event: OffkaiEvent

    var body: some View {
        HStack(spacing: 10) {
            Group {
                if let c = event.cover {
                    MediaImage(path: c, maxPixel: 600)
                } else {
                    ZStack { Color.primary.opacity(0.06); Text("🍻") }
                }
            }
            .frame(width: 48, height: 48)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(event.displayTitle).font(.app(.subheadline, weight: .semibold)).lineLimit(1)
                Text("\(OffkaiStore.day(event.startedAt))・写真 \(event.photoCount) 枚・\(event.startedBy.displayName)")
                    .font(.app(.caption)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.app(.caption)).foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("アルバムを開く")
    }
}

// MARK: - An ended event's album

private struct OffkaiAlbumView: View {
    let offkai: OffkaiStore
    let event: OffkaiEvent
    let onOpen: (Int) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button { offkai.closeAlbum() } label: {
                    Label("戻る", systemImage: "chevron.left").font(.app(.caption, weight: .semibold))
                }
                .buttonStyle(.borderless)
                VStack(alignment: .leading, spacing: 1) {
                    Text("🍻 \(event.displayTitle)").font(.app(.subheadline, weight: .bold)).lineLimit(1)
                    Text("\(OffkaiStore.day(event.startedAt))・写真 \(offkai.albumLoading ? event.photoCount : offkai.albumPhotos.count) 枚")
                        .font(.app(.caption)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            Divider()
            if offkai.albumLoading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                OffkaiPhotoGrid(photos: offkai.albumPhotos, offkai: offkai, empty: "写真はありません", onOpen: onOpen)
            }
        }
    }
}

// MARK: - Photos

/// Squares, oldest first (the newest at the bottom, scrolled to it).
private struct OffkaiPhotoGrid: View {
    let photos: [OffkaiPhoto]
    let offkai: OffkaiStore
    let empty: String
    /// The event going on: opened at the newest (an archive's album opens at its first photo).
    var newestAtBottom = false
    let onOpen: (Int) -> Void

    var body: some View {
        if photos.isEmpty {
            Text(empty).font(.app(.caption)).foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding()
        } else {
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 88, maximum: 160), spacing: 3)], spacing: 3) {
                    ForEach(Array(photos.enumerated()), id: \.element.id) { i, p in
                        Color.clear
                            .aspectRatio(1, contentMode: .fit)
                            .overlay { MediaImage(path: p.url, maxPixel: 600) }
                            .clipped()
                            .contentShape(Rectangle())
                            .onTapGesture { onOpen(i) }
                            .contextMenu {
                                if offkai.isMine(p) {
                                    Button("この写真を消す", systemImage: "trash", role: .destructive) { Task { await offkai.deletePhoto(p) } }
                                }
                            }
                            .accessibilityLabel("写真 \(i + 1)（\(p.uploader.displayName)）")
                            .accessibilityAddTraits(.isButton)
                    }
                }
                .padding(3)
            }
            .modifier(StartAtBottom(on: newestAtBottom))
        }
    }
}

/// Opens scrolled to the newest photos; a short album stays at the top (no gap above it).
private struct StartAtBottom: ViewModifier {
    let on: Bool
    func body(content: Content) -> some View {
        if on, #available(iOS 18.0, macOS 15.0, *) {
            content.defaultScrollAnchor(.bottom, for: .initialOffset)
        } else {
            content
        }
    }
}

struct OffkaiViewerItem: Identifiable {
    let id = UUID()
    let index: Int
    /// The archive's album (otherwise the event going on).
    let album: Bool
}

extension View {
    /// Full screen on iPhone / iPad; laid over the panel on the Mac (the same as the chat's photos).
    @ViewBuilder func offkaiViewer(_ item: Binding<OffkaiViewerItem?>, offkai: OffkaiStore) -> some View {
        #if os(iOS)
        fullScreenCover(item: item) { it in OffkaiPhotoViewer(offkai: offkai, item: it) { item.wrappedValue = nil } }
        #else
        overlay {
            if let it = item.wrappedValue {
                OffkaiPhotoViewer(offkai: offkai, item: it) { item.wrappedValue = nil }
                    .transition(.opacity)
            }
        }
        #endif
    }
}

/// One photo large: swipe (or ← →) for the others, who took it and its caption; 🗑 for my own.
private struct OffkaiPhotoViewer: View {
    let offkai: OffkaiStore
    let item: OffkaiViewerItem
    let onClose: () -> Void
    @State private var index = 0
    @State private var drag: CGFloat = 0
    @State private var confirmDelete = false

    private var photos: [OffkaiPhoto] { item.album ? offkai.albumPhotos : offkai.photos }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if photos.isEmpty {
                Text("写真はありません").foregroundStyle(.white.opacity(0.7))
            } else {
                let i = min(index, photos.count - 1)
                let p = photos[i]
                MediaImage(path: p.url, contentMode: .fit, maxPixel: 2560)
                    .id(p.id)
                    .offset(x: drag)
                    .gesture(
                        DragGesture(minimumDistance: 20)
                            .onChanged { drag = $0.translation.width }
                            .onEnded { v in
                                withAnimation(.easeOut(duration: 0.18)) {
                                    if v.translation.width < -60 { step(1) } else if v.translation.width > 60 { step(-1) }
                                    drag = 0
                                }
                            }
                    )
                VStack(spacing: 0) {
                    HStack(spacing: 14) {
                        Button(action: onClose) { Image(systemName: "xmark").font(.system(size: 17, weight: .semibold)) }
                            .accessibilityLabel("閉じる")
                        Spacer()
                        Text("\(i + 1) / \(photos.count)").font(.app(.caption)).monospacedDigit()
                        Spacer()
                        if offkai.isMine(p) {
                            Button { confirmDelete = true } label: { Image(systemName: "trash").font(.system(size: 16, weight: .semibold)) }
                                .accessibilityLabel("この写真を消す")
                                .confirmationDialog("この写真を消しますか？", isPresented: $confirmDelete, titleVisibility: .visible) {
                                    Button("消す", role: .destructive) { Task { await offkai.deletePhoto(p) } }
                                    Button("やめておく", role: .cancel) {}
                                } message: {
                                    Text("アルバムから消えます（チャットに流れた分は 24 時間で消えます）。")
                                }
                        } else {
                            Color.clear.frame(width: 20, height: 20)
                        }
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.black.opacity(0.35))
                    Spacer()
                    HStack(alignment: .bottom) {
                        VStack(alignment: .leading, spacing: 2) {
                            if let c = p.caption, !c.isEmpty { Text(c).font(.app(.subheadline)) }
                            Text("\(p.uploader.displayName)・\(OffkaiStore.time(p.createdAt))").font(.app(.caption)).opacity(0.75)
                        }
                        Spacer()
                        #if os(macOS)
                        HStack(spacing: 18) {
                            Button { step(-1) } label: { Image(systemName: "chevron.left") }.disabled(i == 0)
                            Button { step(1) } label: { Image(systemName: "chevron.right") }.disabled(i >= photos.count - 1)
                        }
                        .buttonStyle(.plain)
                        .font(.system(size: 18, weight: .semibold))
                        #endif
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(.black.opacity(0.35))
                }
            }
        }
        .onAppear { index = item.index }
        .onChange(of: photos.count) { _, n in
            if n == 0 { onClose() } else if index >= n { index = n - 1 }
        }
        #if os(macOS)
        .focusable()
        .onKeyPress(.leftArrow) { step(-1); return .handled }
        .onKeyPress(.rightArrow) { step(1); return .handled }
        .onKeyPress(.escape) { onClose(); return .handled }
        #endif
    }

    private func step(_ d: Int) {
        let n = index + d
        if photos.indices.contains(n) { index = n }
    }
}
