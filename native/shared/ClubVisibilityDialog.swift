import SwiftUI

/// Opens 「部活の表示」 (one at a time).
struct ClubVisibilityRequest: Identifiable, Equatable {
    let id = 0
}

/// 部活ごとの表示・非表示（Web の「部活の表示」と同じ設定。サーバに保存されて端末をまたぐ）。
/// 2026-10-28 ドリキン「ネイティブアプリで部活ごとの表示非表示がコントロールできない」: the web's
/// setting applied to the apps' timeline too, but the apps had no way to change it back.
struct ClubVisibilityDialog: View {
    let path: String
    let timeline: TimelineStore
    @State private var hidden: Set<String> = []
    @State private var loaded = false
    @State private var failed = false
    @State private var error: String?
    @State private var changed = false

    static let unsetKey = "__unset__"

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label("部活の表示", systemImage: "eye").font(.app(.headline))
                Spacer()
                Button { timeline.actions.clubVisibility = nil } label: { Image(systemName: "xmark").font(.app(.callout)) }
                    .buttonStyle(.borderless)
                    .keyboardShortcut(.cancelAction)
                    .accessibilityLabel("閉じる")
            }
            .padding(14)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text("オフにした部活の投稿はタイムラインに出ません（自分の投稿は出ます）。Web と同じ設定です。")
                        .font(.app(.footnote)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 16).padding(.vertical, 10)
                    if let error {
                        Text(error).font(.app(.footnote)).foregroundStyle(.red)
                            .padding(.horizontal, 16).padding(.bottom, 8)
                    }
                    if !loaded || failed {
                        Text(failed ? "読み込めませんでした" : "読み込み中…")
                            .font(.app(.callout)).foregroundStyle(.secondary)
                            .padding(24).frame(maxWidth: .infinity)
                    } else {
                        ForEach(rows, id: \.key) { r in
                            Toggle(isOn: binding(r.key)) { Text(r.name).font(.app(.body)) }
                                .padding(.horizontal, 16).padding(.vertical, 8)
                                .accessibilityIdentifier("club-\(r.key)")
                            Divider().padding(.leading, 16)
                        }
                    }
                }
            }
        }
        .task { await load() }
        .onDisappear {
            if changed { Task { await timeline.refresh(full: true) } }
        }
    }

    private var rows: [(key: String, name: String)] {
        timeline.clubList.map { ($0.key, $0.name) } + [(Self.unsetKey, "未設定")]
    }

    private func binding(_ key: String) -> Binding<Bool> {
        Binding(get: { !hidden.contains(key) }, set: { on in set(key, hidden: !on) })
    }

    private func load() async {
        if timeline.clubList.isEmpty { await timeline.loadClubs() }
        do {
            hidden = try await timeline.api.hiddenClubs(path: path)
            loaded = true
        } catch {
            failed = true
        }
    }

    private func set(_ key: String, hidden h: Bool) {
        let before = hidden
        if h { hidden.insert(key) } else { hidden.remove(key) }
        error = nil
        Task {
            do {
                try await timeline.api.setClubHidden(path: path, club: key, hidden: h)
                changed = true
            } catch {
                hidden = before
                self.error = PostActionsModel.message(error, fallback: "保存できませんでした")
            }
        }
    }
}
