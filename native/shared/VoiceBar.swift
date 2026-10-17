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
                Text("\(people.count) 人が話しています").font(.subheadline).monospacedDigit()
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
            ScrollView(.horizontal, showsIndicators: false) {
                avatars(voice.members.map { ($0.userId, $0.name, $0.avatar, $0.speaking, $0.muted) }, size: 30, menus: true)
            }
            Spacer(minLength: 4)
            Button {
                Task { await voice.setMic(!voice.micOn) }
            } label: {
                Image(systemName: voice.micOn ? "mic.fill" : "mic.slash.fill")
                    .frame(width: 22, height: 22)
            }
            .buttonStyle(.bordered)
            .tint(voice.micOn ? Color.accentGreen : .secondary)
            .controlSize(.small)
            .disabled(voice.phase != .connected)
            .accessibilityLabel(voice.micOn ? "ミュートする" : "ミュートを解除して話す")
            Button(role: .destructive) {
                Task { await voice.leave() }
            } label: {
                Text("退出").font(.subheadline)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
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
                if menus && voice.canModerate && p.id != voice.myUserId {
                    face.contextMenu {
                        Button("退出させる", systemImage: "person.fill.xmark") {
                            Task { await voice.kick(p.id) }
                        }
                        if voice.isAdmin {
                            Button("退出させて入室禁止", systemImage: "nosign", role: .destructive) {
                                Task { await voice.kick(p.id, ban: true) }
                            }
                        }
                    }
                } else {
                    face
                }
            }
        }
    }
}
