import SwiftUI

/// Opens 「NG ワード」 (one at a time).
struct MutedWordsRequest: Identifiable, Equatable {
    let id = 0
}

/// GET /api/agent/muted-words.
struct MutedWordsInfo: Decodable, Sendable {
    /// 人のミュート（2026-11-25）: ミュートした人。無ければ古いサーバ。
    struct User: Decodable, Sendable, Identifiable, Equatable {
        var userId: String
        var name: String
        var avatar: String?
        var id: String { userId }
    }
    var words: [String]
    var max: Int?
    var maxLength: Int?
    var users: [User]?
}

/// NG ワード（Web と同じ設定。サーバに保存されて端末をまたぐ）。言葉を含むほかの人の投稿・返信は
/// タイムラインに出ず、知らせも来ない（自分の投稿は出る）。2026-10-29 ドリキン。
struct MutedWordsDialog: View {
    let path: String
    let timeline: TimelineStore
    @State private var words: [String] = []
    @State private var max = 50
    @State private var maxLength = 40
    @State private var draft = ""
    @State private var loaded = false
    @State private var failed = false
    @State private var busy = false
    @State private var error: String?
    @State private var changed = false
    @State private var users: [MutedWordsInfo.User]?
    @FocusState private var fieldFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label("NG ワード・ミュート", systemImage: "nosign").font(.app(.headline))
                Spacer()
                Button { timeline.actions.mutedWords = nil } label: { Image(systemName: "xmark").font(.app(.callout)) }
                    .buttonStyle(.borderless)
                    .keyboardShortcut(.cancelAction)
                    .accessibilityLabel("閉じる")
            }
            .padding(14)
            Divider()
            // The field and 「追加」 stay out of the ScrollView: inside it, with the keyboard up, a tap
            // on 「追加」 only ended the editing (iPhone, the UI test) and nothing was added.
            VStack(alignment: .leading, spacing: 0) {
                Text("ここに入れた言葉を含む投稿・返信はタイムラインに出ず、知らせも来ません（自分の投稿は出ます）。大文字小文字・全角半角は区別しません。Web と同じ設定です。")
                    .font(.app(.footnote)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                if loaded && !failed {
                    HStack(spacing: 8) {
                        TextField("言葉を入力", text: $draft)
                            .textFieldStyle(.roundedBorder)
                            .font(.app(.body))
                            .focused($fieldFocused)
                            .submitLabel(.done)
                            .onSubmit(add)
                            .onChange(of: draft) { _, v in if v.count > maxLength { draft = String(v.prefix(maxLength)) } }
                            .disabled(busy || words.count >= max)
                            .accessibilityIdentifier("muted-field")
                        Button("追加", action: add)
                            .buttonStyle(.borderless)
                            .disabled(busy || draft.trimmingCharacters(in: .whitespaces).isEmpty || words.count >= max)
                            .accessibilityIdentifier("muted-add")
                    }
                    .padding(.horizontal, 16).padding(.bottom, 8)
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let error {
                        Text(error).font(.app(.footnote)).foregroundStyle(.red)
                            .padding(.horizontal, 16).padding(.bottom, 8)
                    }
                    if !loaded || failed {
                        Text(failed ? "読み込めませんでした" : "読み込み中…")
                            .font(.app(.callout)).foregroundStyle(.secondary)
                            .padding(24).frame(maxWidth: .infinity)
                    } else if words.isEmpty {
                        Text("まだありません")
                            .font(.app(.callout)).foregroundStyle(.secondary)
                            .padding(24).frame(maxWidth: .infinity)
                    } else {
                        ForEach(words, id: \.self) { w in
                            HStack {
                                Text(w).font(.app(.body))
                                Spacer()
                                Button { remove(w) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                                    .buttonStyle(.borderless)
                                    .disabled(busy)
                                    .accessibilityLabel("「\(w)」を消す")
                            }
                            .padding(.horizontal, 16).padding(.vertical, 10)
                            .accessibilityIdentifier("muted-\(w)")
                            Divider().padding(.leading, 16)
                        }
                        Text("\(words.count) / \(max) 個")
                            .font(.app(.caption)).foregroundStyle(.secondary)
                            .padding(16)
                    }
                    if loaded && !failed, let users { mutedUsers(users) }
                }
            }
        }
        .task { await load() }
        .onDisappear {
            if changed { Task { await timeline.refresh(full: true) } }
        }
    }

    /// 人のミュート（2026-11-25）: ミュートした人と「外す」。ミュートはプロフィールから。
    @ViewBuilder private func mutedUsers(_ users: [MutedWordsInfo.User]) -> some View {
        Divider()
        VStack(alignment: .leading, spacing: 4) {
            Text("ミュートした人").font(.app(.subheadline, weight: .semibold))
            Text("ミュートした人の投稿・返信はタイムラインに出ず、知らせも来ません（その人のプロフィールでは見られます。相手には伝わりません）。ミュートはプロフィールからできます。")
                .font(.app(.footnote)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 6)
        if users.isEmpty {
            Text("まだいません")
                .font(.app(.callout)).foregroundStyle(.secondary)
                .padding(.horizontal, 16).padding(.vertical, 10)
        }
        ForEach(users) { u in
            HStack(spacing: 10) {
                AvatarView(url: u.avatar, name: u.name, size: 28)
                Text(u.name).font(.app(.body)).lineLimit(1)
                Spacer()
                Button("外す") { unmute(u) }
                    .buttonStyle(.borderless)
                    .disabled(busy)
                    .accessibilityLabel("\(u.name)さんのミュートを外す")
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
            Divider().padding(.leading, 16)
        }
    }

    private func unmute(_ u: MutedWordsInfo.User) {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await timeline.api.setUserMuted(userId: u.userId, muted: false)
                users?.removeAll { $0.userId == u.userId }
                changed = true
            } catch {
                self.error = PostActionsModel.message(error, fallback: "保存できませんでした")
            }
        }
    }

    private func load() async {
        do {
            let info = try await timeline.api.mutedWords(path: path)
            words = info.words
            users = info.users
            if let m = info.max { max = m }
            if let m = info.maxLength { maxLength = m }
            loaded = true
        } catch {
            failed = true
        }
    }

    private func add() {
        let w = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !w.isEmpty, !busy else { return }
        save(words + [w]) { draft = "" }
    }

    private func remove(_ w: String) {
        save(words.filter { $0 != w })
    }

    private func save(_ next: [String], then done: @escaping () -> Void = {}) {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                words = try await timeline.api.setMutedWords(path: path, words: next)
                changed = true
                done()
            } catch {
                self.error = PostActionsModel.message(error, fallback: "保存できませんでした")
            }
        }
    }
}
