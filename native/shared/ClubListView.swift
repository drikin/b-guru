import SwiftUI

/// 部活一覧: pick a club and the timeline shows only its posts (「すべて」 = all).
/// リュー 2026-11-09「タイムラインからさらに左側にスワイプすると部活一覧が出るようにしても良いかも」
/// → オーナー「全アプリに作る」. iPhone: a page left of the timeline. iPad / Mac: the timeline's
/// list menu (「部活で絞り込む」). The clubs this member hides (部活の表示) are left out.
struct ClubListView: View {
    let timeline: TimelineStore
    /// After a pick (iPhone: back to the timeline page).
    var onPicked: () -> Void = {}

    var body: some View {
        List {
            Section {
                row(key: nil, name: "すべての部活", systemImage: "square.stack")
            } footer: {
                Text("選んだ部活の投稿だけをタイムラインに出します。")
            }
            Section("部活") {
                if timeline.visibleClubs.isEmpty {
                    Text("読み込み中…").foregroundStyle(.secondary)
                }
                ForEach(timeline.visibleClubs, id: \.key) { c in
                    row(key: c.key, name: c.name, systemImage: "tag")
                }
            }
        }
        .font(.app(.body))
        .task { await timeline.loadHiddenClubs() }
        .refreshable { await timeline.loadClubs(); await timeline.loadHiddenClubs() }
    }

    private func row(key: String?, name: String, systemImage: String) -> some View {
        let on = timeline.clubFilter == key
        return Button {
            onPicked()
            Task { await timeline.setClubFilter(key) }
        } label: {
            HStack {
                Label(name, systemImage: systemImage)
                    .foregroundStyle(.primary)
                Spacer()
                if on { Image(systemName: "checkmark").foregroundStyle(.tint) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("club-row-\(key ?? "all")")
    }
}

/// Above the timeline while a club is picked: which club, and the way back to all.
struct ClubFilterBanner: View {
    let timeline: TimelineStore

    var body: some View {
        if let name = timeline.clubFilterName {
            HStack(spacing: 8) {
                Label(name, systemImage: "tag.fill")
                    .font(.app(.callout).weight(.semibold))
                    .foregroundStyle(.tint)
                    .lineLimit(1)
                Text("の投稿だけ").font(.app(.footnote)).foregroundStyle(.secondary)
                Spacer()
                Button {
                    Task { await timeline.setClubFilter(nil) }
                } label: {
                    Label("すべてに戻す", systemImage: "xmark.circle.fill").font(.app(.footnote))
                }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("club-filter-clear")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(.tint.opacity(0.08))
        }
    }
}

/// The list menu's 「部活で絞り込む」 (iPad, Mac; the iPhone too, besides its page).
struct ClubFilterMenu: View {
    let timeline: TimelineStore

    var body: some View {
        Menu {
            Picker("部活で絞り込む", selection: Binding(
                get: { timeline.clubFilter ?? "" },
                set: { v in Task { await timeline.setClubFilter(v.isEmpty ? nil : v) } }
            )) {
                Text("すべての部活").tag("")
                ForEach(timeline.visibleClubs, id: \.key) { c in Text(c.name).tag(c.key) }
            }
            .pickerStyle(.inline)
        } label: {
            Label("部活で絞り込む", systemImage: "tag")
        }
    }
}
