import Foundation
import Observation
#if os(iOS)
import Photos
#else
import AppKit
#endif

/// 🍻 アルバムの「⬇ まとめて保存」（docs/offkai-spec.md「アルバムをまとめて保存」）。zip は使わず、アルバムの一覧の
/// 写真を 1 枚ずつ取って（同時に 3 枚まで）保存する。iPhone・iPad は写真アプリへ（追加だけの許可）、
/// Mac は選んだフォルダの中の「B-guru オフ会 日付 題」へ Web の zip と同じ名前で（上書きしない）。
/// 写真はアルバムと同じ取り方（自分のサーバにだけトークンを付ける）。何も外へ送らない。Main-actor only.
@MainActor
@Observable
final class OffkaiAlbumSaver {
    enum Phase: Equatable {
        case idle
        /// 権限やフォルダを聞いている。
        case preparing
        case running(done: Int, total: Int)
        /// 終わった（中止を含む）。Mac は保存したフォルダ（Finder で開く）。
        case finished(message: String, folder: URL?)
    }

    private(set) var phase: Phase = .idle
    /// どのオフ会を保存しているか（別のアルバムを開いたら出さない）。
    private(set) var eventId: Int?

    @ObservationIgnored private var task: Task<Void, Never>?
    private let token: String

    /// 同時に取る枚数（サーバと回線をふさがない）。
    private static let concurrency = 3

    init(token: String) {
        self.token = token
    }

    var isBusy: Bool {
        switch phase {
        case .preparing, .running: return true
        default: return false
        }
    }

    /// 保存を始める（すでに動いていれば何もしない）。photos は古い順。
    func start(event: OffkaiEvent, photos: [OffkaiPhoto]) {
        guard !isBusy, !photos.isEmpty else { return }
        eventId = event.id
        phase = .preparing
        task = Task { await run(event: event, photos: photos) }
    }

    func cancel() {
        task?.cancel()
    }

    /// 結果の一言を閉じる。
    func dismiss() {
        guard !isBusy else { return }
        phase = .idle
        eventId = nil
    }

    // MARK: 1 枚ずつ

    private struct Item: Sendable {
        let url: String
        let name: String
        let createdAt: Date?
    }

    private func run(event: OffkaiEvent, photos: [OffkaiPhoto]) async {
        let items = photos.enumerated().map { i, p in
            let created = OffkaiStore.date(p.createdAt)
            return Item(url: p.url,
                        name: OffkaiSaveNames.fileName(index: i, count: photos.count, uploader: p.uploader.name ?? "",
                                                       createdAt: created ?? Date(), url: p.url),
                        createdAt: created)
        }
        #if os(iOS)
        guard await Self.photosAllowed() else {
            phase = .finished(message: "写真アプリへの保存が許可されていません。設定 › B-guru Chat › 写真 で「写真を追加のみ」を選んでください", folder: nil)
            return
        }
        let target: Target = .photos
        #else
        guard let parent = await Self.pickFolder() else { phase = .idle; eventId = nil; return }
        let folderName = OffkaiSaveNames.folderName(title: event.title, startedAt: event.started ?? Date())
        let scoped = parent.startAccessingSecurityScopedResource()
        defer { if scoped { parent.stopAccessingSecurityScopedResource() } }
        if Task.isCancelled { phase = .idle; eventId = nil; return } // 選んでいる間に閉じた: 空のフォルダを作らない
        guard let folder = Self.makeFolder(in: parent, name: folderName) else {
            phase = .finished(message: "フォルダを作れませんでした（\(parent.lastPathComponent)）", folder: nil)
            return
        }
        let target: Target = .folder(folder)
        #endif
        if Task.isCancelled { phase = .idle; eventId = nil; return }

        phase = .running(done: 0, total: items.count)
        var saved = 0, failed = 0
        let token = self.token
        await withTaskGroup(of: Bool.self) { group in
            var next = 0
            func add() {
                guard next < items.count else { return }
                let item = items[next]
                next += 1
                group.addTask { await Self.saveOne(item, token: token, to: target) }
            }
            for _ in 0..<Self.concurrency { add() }
            while let ok = await group.next() {
                if ok { saved += 1 } else { failed += 1 }
                phase = .running(done: saved + failed, total: items.count)
                if !Task.isCancelled { add() }
            }
        }
        #if os(iOS)
        let folder: URL? = nil
        #endif
        if Task.isCancelled {
            phase = .finished(message: saved > 0 ? "中止しました（\(saved) 枚は保存済み）" : "中止しました", folder: saved > 0 ? folder : nil)
        } else {
            phase = .finished(message: OffkaiSaveNames.resultMessage(saved: saved, failed: failed), folder: saved > 0 ? folder : nil)
        }
        task = nil
    }

    private enum Target: Sendable {
        case photos
        case folder(URL)
    }

    /// 1 枚: 取って保存する（途中で中止されたら失敗に数える）。
    private nonisolated static func saveOne(_ item: Item, token: String, to target: Target) async -> Bool {
        guard !Task.isCancelled, let req = MediaCache.request(item.url, token: token),
              let (data, resp) = try? await MediaCache.session.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty, !Task.isCancelled else { return false }
        switch target {
        case .photos:
            #if os(iOS)
            return await addToPhotos(data, name: item.name, createdAt: item.createdAt)
            #else
            return false
            #endif
        case .folder(let dir):
            return write(data, name: item.name, in: dir)
        }
    }

    /// 同じ名前があれば「 (2)」を付けて書く（`withoutOverwriting` で、間に合わなかったときも上書きはしない）。
    private nonisolated static func write(_ data: Data, name: String, in dir: URL) -> Bool {
        let fm = FileManager.default
        for _ in 0..<3 {
            let unique = OffkaiSaveNames.uniqueName(name) { fm.fileExists(atPath: dir.appendingPathComponent($0).path) }
            do {
                try data.write(to: dir.appendingPathComponent(unique), options: [.withoutOverwriting])
                return true
            } catch CocoaError.fileWriteFileExists {
                continue // 同時に書いたほうと名前がぶつかった: 次の名前で
            } catch {
                return false
            }
        }
        return false
    }

    #if os(iOS)
    /// 追加だけの許可（写真を読むことはしない）。初めてなら聞く。
    private static func photosAllowed() async -> Bool {
        var status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        if status == .notDetermined { status = await PHPhotoLibrary.requestAuthorization(for: .addOnly) }
        return status == .authorized || status == .limited
    }

    /// 写真アプリへ 1 枚（撮った時刻はアルバムに上げた時刻、元の名前は zip と同じ）。
    private nonisolated static func addToPhotos(_ data: Data, name: String, createdAt: Date?) async -> Bool {
        do {
            try await PHPhotoLibrary.shared().performChanges {
                let req = PHAssetCreationRequest.forAsset()
                let opts = PHAssetResourceCreationOptions()
                opts.originalFilename = name
                req.addResource(with: .photo, data: data, options: opts)
                if let createdAt { req.creationDate = createdAt }
            }
            return true
        } catch {
            return false
        }
    }
    #else
    /// 保存先を選ぶ（最初は「ダウンロード」）。やめたら nil。
    private static func pickFolder() async -> URL? {
        let panel = NSOpenPanel()
        panel.title = "アルバムの保存先"
        panel.message = "選んだ場所に「B-guru オフ会 …」のフォルダを作って、写真を保存します"
        panel.prompt = "ここに保存"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = realDownloads
        NSApp.activate()
        return await withCheckedContinuation { (c: CheckedContinuation<URL?, Never>) in
            panel.begin { r in c.resume(returning: r == .OK ? panel.url : nil) }
        }
    }

    /// 本当の ~/Downloads（サンドボックスの中の NSHomeDirectory はアプリのコンテナを指す）。
    private static var realDownloads: URL? {
        guard let pw = getpwuid(getuid()), let home = pw.pointee.pw_dir else { return nil }
        return URL(fileURLWithPath: String(cString: home)).appendingPathComponent("Downloads", isDirectory: true)
    }

    /// 選んだ場所に「B-guru オフ会 日付 題」を作る（同じ名前があれば「 (2)」を付けた新しいフォルダ）。
    private static func makeFolder(in parent: URL, name: String) -> URL? {
        let fm = FileManager.default
        for _ in 0..<3 {
            let unique = OffkaiSaveNames.uniqueName(name, folder: true) { fm.fileExists(atPath: parent.appendingPathComponent($0).path) }
            let url = parent.appendingPathComponent(unique, isDirectory: true)
            do {
                try fm.createDirectory(at: url, withIntermediateDirectories: false)
                return url
            } catch CocoaError.fileWriteFileExists {
                continue
            } catch {
                return nil
            }
        }
        return nil
    }

    /// 保存したフォルダを Finder で見せる。
    static func reveal(_ folder: URL) {
        NSWorkspace.shared.activateFileViewerSelecting([folder])
    }
    #endif
}
