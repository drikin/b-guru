import SwiftUI

/// The voice room strip above the chat messages (iPhone/iPad and Mac).
///
///   room empty, not in it     → 🎙 ボイスルームを開く
///   people talking, not in it → 🎙 3 人が話しています  (avatars)  [参加]
///   in the room               → avatars (ring = speaking, slash = muted) [🎤] [退出]
///
/// Hidden entirely unless the server says voice is on for this member.
struct VoiceBar: View {
    @Bindable var voice: VoiceStore
    @State private var reportReason = ""

    var body: some View {
        if voice.enabled {
            VStack(alignment: .leading, spacing: 6) {
                if voice.inRoom {
                    inRoom
                } else {
                    outside
                }
                if let notice = voice.notice {
                    Text(notice).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.accentGreen.opacity(voice.inRoom ? 0.12 : 0.05), ignoresSafeAreaEdges: [])
            .alert(
                "\(voice.reportTarget?.name ?? "") さんを管理者に通報",
                isPresented: Binding(get: { voice.reportTarget != nil }, set: { if !$0 { voice.reportTarget = nil } })
            ) {
                TextField("何があったか（任意）", text: $reportReason)
                Button("通報する", role: .destructive) {
                    if let t = voice.reportTarget {
                        let reason = reportReason
                        Task { await voice.report(t.userId, reason: reason) }
                    }
                    reportReason = ""
                    voice.reportTarget = nil
                }
                Button("やめる", role: .cancel) {
                    reportReason = ""
                    voice.reportTarget = nil
                }
            } message: {
                Text("管理者に通知が届きます。相手には知らされません。")
            }
        }
    }

    // MARK: Not in the room

    @ViewBuilder private var outside: some View {
        let people = voice.roomInfo?.active == true ? voice.roomInfo?.participants ?? [] : []
        HStack(spacing: 8) {
            Image(systemName: people.isEmpty ? "mic" : "waveform")
                .foregroundStyle(Color.accentGreen)
            if people.isEmpty {
                Text("ボイスルーム").font(.subheadline)
                Text("誰もいません").font(.caption).foregroundStyle(.secondary)
            } else {
                Text("\(people.count) 人が参加中").font(.subheadline).monospacedDigit()
                avatars(people.map { ($0.userId, $0.name ?? "?", $0.avatar, false, false) })
            }
            Spacer(minLength: 4)
            if voice.canJoin {
                Button {
                    Task { await voice.join() }
                } label: {
                    Text(people.isEmpty ? "開く" : "参加")
                        .font(.subheadline.bold())
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.accentGreen)
                .controlSize(.small)
                .accessibilityLabel(people.isEmpty ? "ボイスルームを開く" : "ボイスルームに参加")
            } else {
                Text("使うにはログインし直してください").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    // MARK: In the room

    @ViewBuilder private var inRoom: some View {
        HStack(spacing: 8) {
            if voice.phase == .connecting || voice.phase == .reconnecting {
                ProgressView().controlSize(.small)
                Text(voice.phase == .connecting ? "接続中…" : "再接続中…").font(.caption).foregroundStyle(.secondary)
            }
            faces
            Spacer(minLength: 4)
            MicButton(voice: voice)
            #if os(macOS)
            DeviceMenu(voice: voice)
            #endif
            Button(role: .destructive) {
                Task { await voice.leave() }
            } label: {
                Text("退出").font(.subheadline)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    // MARK: Faces in the room (up to 100 people)

    /// How many faces fit next to the buttons; the rest go behind "+N".
    private var faceSlots: Int {
        #if os(macOS)
        return 6
        #else
        return 4
        #endif
    }

    @State private var showAll = false

    private var faces: some View {
        let shown = Array(voice.members.prefix(faceSlots))
        let rest = voice.members.count - shown.count
        return HStack(spacing: 6) {
            avatars(shown.map { ($0.userId, $0.name, $0.avatar, $0.speaking, $0.muted) }, size: 30, menus: true)
            if rest > 0 || voice.members.count > 1 {
                Button {
                    showAll = true
                } label: {
                    Text(rest > 0 ? "+\(rest)" : "一覧")
                        .font(.caption.bold())
                        .monospacedDigit()
                        .frame(minWidth: 30, minHeight: 30)
                        .padding(.horizontal, rest > 99 ? 4 : 0)
                        .background(Capsule().fill(Color.primary.opacity(0.08)))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("参加者 \(voice.members.count) 人の一覧")
                .popover(isPresented: $showAll) {
                    VoiceMemberList(voice: voice)
                }
            }
        }
        .padding(3) // room for the speaking ring
    }

    // MARK: Avatars

    private func avatars(_ people: [(id: String, name: String, avatar: String?, speaking: Bool, muted: Bool)],
                         size: CGFloat = 22, menus: Bool = false) -> some View {
        HStack(spacing: menus ? 6 : -6) {
            ForEach(people.prefix(menus ? 20 : 6), id: \.id) { p in
                let face = AvatarView(url: p.avatar, name: p.name, size: size)
                    .overlay(Circle().stroke(Color.accentGreen, lineWidth: p.speaking ? 2.5 : 0))
                    .overlay(alignment: .bottomTrailing) {
                        if menus && p.muted {
                            Image(systemName: "mic.slash.fill")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(.white)
                                .padding(2)
                                .background(Circle().fill(Color.secondary))
                        }
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(p.name)\(p.speaking ? "、話しています" : "")\(menus && p.muted ? "、ミュート中" : "")")
                if menus && p.id != voice.myUserId {
                    face.contextMenu {
                        MemberActions(voice: voice, userId: p.id, muted: p.muted)
                    }
                } else {
                    face
                }
            }
        }
    }
}

/// Mute toggle that shows whether my voice is going out:
///   muted          → grey, slashed mic
///   on, quiet      → green outline, mic
///   on, talking    → solid green, bold mic, ring that swells with the level
private struct MicButton: View {
    @Bindable var voice: VoiceStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let active = voice.micActive
        Button {
            Task { await voice.setMic(!voice.micOn) }
        } label: {
            Image(systemName: voice.micOn ? "mic.fill" : "mic.slash.fill")
                .font(.system(size: 14, weight: active ? .heavy : .regular))
                .foregroundStyle(active ? Color.white : (voice.micOn ? Color.accentGreen : Color.secondary))
                .frame(width: 34, height: 28)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(active ? Color.accentGreen : Color.primary.opacity(voice.micOn ? 0.06 : 0.08))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(Color.accentGreen, lineWidth: voice.micOn ? 1.5 : 0)
                )
                .overlay(
                    // Level ring: grows with how loud I am while talking.
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(Color.accentGreen.opacity(0.45), lineWidth: 3)
                        .padding(-3)
                        .scaleEffect(active && !reduceMotion ? 1 + CGFloat(voice.micLevel) * 0.18 : 1)
                        .opacity(active ? 1 : 0)
                )
                .overlay(alignment: .bottomTrailing) {
                    if voice.micBusy {
                        ProgressView().controlSize(.mini).padding(1)
                    }
                }
                .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: voice.micLevel)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(voice.phase != .connected)
        .accessibilityLabel(voice.micOn ? "ミュートする" : "ミュートを解除して話す")
        .accessibilityValue(voice.micOn ? (active ? "話しています" : "マイク オン") : "ミュート中")
    }
}

#if os(macOS)
/// Which mic and speakers to use in the voice room (remembered per Mac).
private struct DeviceMenu: View {
    @Bindable var voice: VoiceStore

    var body: some View {
        Menu {
            Picker("マイク", selection: Binding(get: { voice.inputId }, set: { voice.selectInput($0) })) {
                ForEach(voice.inputs) { Text($0.name).tag($0.id) }
            }
            .pickerStyle(.inline)
            Picker("スピーカー", selection: Binding(get: { voice.outputId }, set: { voice.selectOutput($0) })) {
                ForEach(voice.outputs) { Text($0.name).tag($0.id) }
            }
            .pickerStyle(.inline)
        } label: {
            Image(systemName: "slider.horizontal.3")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("マイクとスピーカーを選ぶ")
        .accessibilityLabel("マイクとスピーカーを選ぶ")
    }
}
#endif

/// Everyone in the room (up to 100): talking first, then mics on, then listeners.
private struct VoiceMemberList: View {
    @Bindable var voice: VoiceStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let speakers = voice.members.filter { !$0.muted }.count
        VStack(spacing: 0) {
            HStack {
                Text("参加者 \(voice.members.count) 人").font(.headline).monospacedDigit()
                Text("話せる人 \(speakers)/\(voice.maxSpeakers)").font(.caption).foregroundStyle(.secondary).monospacedDigit()
                Spacer()
                Button("閉じる") { dismiss() }
            }
            .padding(12)
            Divider()
            List(voice.members) { m in
                HStack(spacing: 10) {
                    AvatarView(url: m.avatar, name: m.name, size: 28)
                        .overlay(Circle().stroke(Color.accentGreen, lineWidth: m.speaking ? 2.5 : 0))
                    Text(m.name + (m.isMe ? "（自分）" : "")).lineLimit(1)
                    Spacer()
                    if m.speaking {
                        Text("話しています").font(.caption).foregroundStyle(Color.accentGreen)
                    }
                    Image(systemName: m.muted ? "mic.slash" : "mic.fill")
                        .foregroundStyle(m.muted ? Color.secondary : Color.accentGreen)
                        .accessibilityLabel(m.muted ? "ミュート中" : "マイク オン")
                    if !m.isMe {
                        Menu {
                            MemberActions(voice: voice, userId: m.userId, muted: m.muted)
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                        .menuIndicator(.hidden)
                        .fixedSize()
                        .accessibilityLabel("\(m.name) の操作")
                    }
                }
                .accessibilityElement(children: .combine)
            }
            .listStyle(.plain)
        }
        #if os(macOS)
        .frame(width: 320, height: 420)
        #else
        .presentationDetents([.medium, .large])
        #endif
    }
}

/// Menu items for someone else in the room: report (anyone), and for admins
/// mute / remove / remove and ban.
private struct MemberActions: View {
    @Bindable var voice: VoiceStore
    let userId: String
    let muted: Bool

    var body: some View {
        if voice.canModerate {
            Button("ミュートさせる", systemImage: "mic.slash") {
                Task { await voice.forceMute(userId) }
            }
            .disabled(muted)
            Button("退出させる", systemImage: "person.fill.xmark") {
                Task { await voice.kick(userId) }
            }
            Button("退出させて入室禁止", systemImage: "nosign", role: .destructive) {
                Task { await voice.kick(userId, ban: true) }
            }
            Divider()
        }
        Button("管理者に通報…", systemImage: "flag") {
            voice.reportTarget = voice.members.first { $0.userId == userId }
        }
    }
}
