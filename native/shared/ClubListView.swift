import SwiftUI

/// 部活一覧: pick a club and the timeline shows only its posts (「すべて」 = all).
/// リュー 2026-11-09「タイムラインからさらに左側にスワイプすると部活一覧が出るようにしても良いかも」
/// → オーナー「全アプリに作る」. iPhone: a page left of the timeline. iPad / Mac: the timeline's
/// list menu (「部活で絞り込む」). The clubs this member hides (部活の表示) are left out.
struct ClubListView: View {
    let timeline: TimelineStore
    /// After a pick (iPhone: back to the timeline page).
    var onPicked: () -> Void = {}
    /// 「並べ替え」 (自分の順番 only): rows move by dragging; a tap does not pick then.
    @State private var reordering = false

    var body: some View {
        List {
            Section {
                row(key: nil, name: "すべての部活", systemImage: "square.stack", unread: timeline.clubUnreadTotal)
            } footer: {
                Text("選んだ部活の投稿だけをタイムラインに出します。")
            }
            if showsControls {
                // The sort and 「並べ替え」 in a row of their own (in the section header a tap reached
                // them twice: the switch went back at once).
                Section { controls }
            }
            Section {
                if timeline.visibleClubs.isEmpty {
                    Text("読み込み中…").foregroundStyle(.secondary)
                }
                if reordering {
                    ForEach(timeline.customOrderedClubs, id: \.key) { c in
                        Label(c.name, systemImage: "tag")
                            .accessibilityIdentifier("club-move-\(c.key)")
                    }
                    .onMove { from, to in timeline.moveClubs(from: from, to: to) }
                } else {
                    ForEach(timeline.visibleClubs, id: \.key) { c in
                        row(key: c.key, name: c.name, systemImage: "tag", unread: timeline.clubUnread[c.key] ?? 0)
                    }
                }
            } header: {
                Text("部活")
            } footer: {
                if reordering {
                    Text("ドラッグで並べ替えます。並べた順番はほかの端末でも同じです。")
                } else if timeline.showsClubUnread {
                    Text("数字は直近 30 日のまだ読んでいない投稿です。")
                }
            }
        }
        .font(.app(.body))
        #if os(iOS)
        .environment(\.editMode, .constant(reordering ? .active : .inactive))
        #endif
        .task {
            await timeline.loadHiddenClubs()
            await timeline.loadClubOrder()
            await timeline.loadClubUnread(force: true)
        }
        .refreshable {
            await timeline.loadClubs()
            await timeline.loadHiddenClubs()
            await timeline.loadClubOrder()
            await timeline.loadClubUnread(force: true)
        }
    }

    private var showsControls: Bool { timeline.showsClubUnread || timeline.canReorderClubs }

    /// The sort (「自分の順番」 / 「未読順」) and 「並べ替え」 / 「完了」.
    private var controls: some View {
        HStack(spacing: 8) {
            if !reordering, timeline.showsClubUnread {
                Picker("並び順", selection: Binding(get: { timeline.clubSort }, set: { timeline.setClubSort($0) })) {
                    ForEach(ClubSort.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .fixedSize()
                .accessibilityIdentifier("club-sort")
            }
            Spacer(minLength: 0)
            if timeline.canReorderClubs, reordering || timeline.clubSort == .custom || !timeline.showsClubUnread {
                Button(reordering ? "完了" : "並べ替え") {
                    withAnimation { reordering.toggle() }
                }
                .buttonStyle(.borderless)
                .font(.app(.footnote, weight: reordering ? .semibold : .regular))
                .accessibilityIdentifier("club-reorder")
            }
        }
    }

    private func row(key: String?, name: String, systemImage: String, unread: Int) -> some View {
        let on = timeline.clubFilter == key
        return Button {
            onPicked()
            Task { await timeline.setClubFilter(key) }
        } label: {
            HStack {
                Label(name, systemImage: systemImage)
                    .foregroundStyle(.primary)
                Spacer()
                if let b = ClubOrdering.badge(unread) {
                    Text(b)
                        .font(.app(.caption, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Color.accentGreen, in: Capsule())
                        .accessibilityLabel("未読 \(unread) 件")
                }
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
            if timeline.showsClubUnread {
                Picker("並び順", selection: Binding(get: { timeline.clubSort }, set: { timeline.setClubSort($0) })) {
                    ForEach(ClubSort.allCases, id: \.self) { Text($0.label).tag($0) }
                }
            }
            Picker("部活で絞り込む", selection: Binding(
                get: { timeline.clubFilter ?? "" },
                set: { v in Task { await timeline.setClubFilter(v.isEmpty ? nil : v) } }
            )) {
                Text("すべての部活").tag("")
                ForEach(timeline.visibleClubs, id: \.key) { c in
                    Text(ClubOrdering.badge(timeline.clubUnread[c.key] ?? 0).map { "\(c.name)  \($0)" } ?? c.name).tag(c.key)
                }
            }
            .pickerStyle(.inline)
        } label: {
            Label("部活で絞り込む", systemImage: "tag")
        }
    }
}
