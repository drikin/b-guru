import XCTest

/// 👥 グループ DM (shared/GroupDMLogic.swift): decoding the server's DTOs and the list / thread rules.
///   cd native/mac && xcodegen generate && xcodebuild test -project BguruChat.xcodeproj -scheme BguruChatTests
final class GroupDMLogicTests: XCTestCase {
    private func iso(_ minutesAgo: Double, from now: Date = Date()) -> String {
        ISO8601DateFormatter().string(from: now.addingTimeInterval(-minutesAgo * 60))
    }

    private func group(_ id: Int, title: String = "g", muted: Bool = false) -> GDMGroup {
        GDMGroup(id: id, name: nil, title: title, members: [], memberCount: 3, isCreator: false, muted: muted, createdAt: iso(600))
    }

    private func msg(_ id: Int, group: Int = 1, from: String? = "a", mine: Bool = false, system: Bool = false,
                     ago: Double = 1, clientId: String? = nil) -> GDMMessage {
        GDMMessage(id: id, groupId: group, kind: system ? "system" : "text", fromId: system ? nil : from,
                   fromName: system ? nil : from, fromAvatar: nil, body: "b\(id)", createdAt: iso(ago), isAuthor: mine, clientId: clientId)
    }

    // MARK: Decoding

    func testDecodesEventsAndDTOs() throws {
        let create = try XCTUnwrap(GDMEvent.decode(Data(#"""
        {"action":"create","group_id":3,"group_unread_count":5,
         "message":{"id":10,"group_id":3,"kind":"text","from_id":"u_1","from_name":"mazzo","from_avatar":null,
                    "body":"やあ","created_at":"2026-11-06T01:02:03.000Z","is_author":false}}
        """#.utf8)))
        XCTAssertEqual(create.action, "create")
        XCTAssertEqual(create.groupUnreadCount, 5)
        XCTAssertEqual(create.message?.fromName, "mazzo")
        XCTAssertEqual(create.message?.isSystem, false)
        XCTAssertNotNil(GDMLogic.date(create.message?.createdAt))

        let g = try XCTUnwrap(GDMEvent.decode(Data(#"""
        {"action":"group","group":{"id":3,"name":null,"title":"mazzo、takuto","member_count":3,"is_creator":true,"muted":false,
          "created_at":"2026-11-06T01:00:00Z","members":[{"user_id":"u_0","name":"me","avatar":null,"is_creator":true,"is_me":true},
          {"user_id":"u_1","name":"mazzo","avatar":"/a.png","is_creator":false,"is_me":false}]}}
        """#.utf8)))?.group
        XCTAssertEqual(g?.title, "mazzo、takuto")
        XCTAssertNil(g?.name)
        XCTAssertEqual(g?.me?.userId, "u_0")
        XCTAssertEqual(g?.members.last?.avatar, "/a.png")

        let read = try XCTUnwrap(GDMEvent.decode(Data(#"{"action":"read","group_id":3,"last_read_id":10,"unread_count":0,"group_unread_count":2}"#.utf8)))
        XCTAssertEqual(read.groupId, 3)
        XCTAssertEqual(read.groupUnreadCount, 2)
        XCTAssertEqual(GDMEvent.decode(Data(#"{"action":"removed","group_id":4}"#.utf8))?.groupId, 4)
        XCTAssertNil(GDMEvent.decode(Data("nope".utf8)))
    }

    func testDecodesBeagleAnswerAndSwitch() throws {
        let ev = try XCTUnwrap(GDMEvent.decode(Data(#"""
        {"action":"create","group_id":3,
         "message":{"id":11,"group_id":3,"kind":"text","from_id":"u_sys","from_name":"ビーグル","from_avatar":null,
                    "body":"まとめだわん","created_at":"2026-11-06T01:02:03.000Z","is_author":false,"is_beagle":true}}
        """#.utf8)))
        XCTAssertEqual(ev.message?.isBeagle, true)
        XCTAssertEqual(ev.message?.senderName, "ビーグル")
        XCTAssertEqual(ev.message?.isSystem, false)
        let g = try XCTUnwrap(GDMEvent.decode(Data(#"{"action":"group","group":{"id":3,"name":null,"title":"t","members":[],"beagle":true}}"#.utf8))?.group)
        XCTAssertEqual(g.beagle, true)
        // older server: no field
        let old = try XCTUnwrap(GDMEvent.decode(Data(#"{"action":"group","group":{"id":3,"name":null,"title":"t","members":[]}}"#.utf8))?.group)
        XCTAssertNil(old.beagle)
    }

    // MARK: Thread

    func testReconcileReplacesPendingByClientId() {
        var pending = msg(-1, mine: true, clientId: "c1")
        pending.pending = true
        let list = [msg(5), pending]
        let stored = msg(9, mine: true, clientId: "c1")
        let next = GDMLogic.reconcile(list, with: stored)
        XCTAssertEqual(next.map(\.id), [5, 9])
        XCTAssertEqual(GDMLogic.reconcile(next, with: stored).map(\.id), [5, 9], "the echo of the same id is not added twice")
        XCTAssertEqual(GDMLogic.reconcile([msg(5), pending], with: msg(7)).map(\.id), [5, 7, -1], "pending stays last")
    }

    func testTtl() {
        let now = Date()
        var pending = msg(-1, mine: true, ago: 40 * 24 * 60)
        pending.pending = true
        let list = [msg(1, ago: 31 * 24 * 60), msg(2, ago: 29 * 24 * 60), pending]
        XCTAssertEqual(GDMLogic.pruned(list, now: now).map(\.id), [2, -1])
        // A group stays without (visible) messages: only its last message goes.
        let s = [GDMSummary(group: group(1), lastMessage: msg(1, ago: 31 * 24 * 60), unreadCount: 0)]
        let pruned = GDMLogic.prunedSummaries(s, now: now)
        XCTAssertEqual(pruned.count, 1)
        XCTAssertNil(pruned[0].lastMessage)
    }

    // MARK: List

    func testSummariesAfterAMessage() throws {
        let list = [GDMSummary(group: group(1), lastMessage: msg(1, group: 1), unreadCount: 0),
                    GDMSummary(group: group(2), lastMessage: msg(2, group: 2), unreadCount: 1)]
        let theirs = try XCTUnwrap(GDMLogic.summaries(list, after: msg(3, group: 2), viewing: false))
        XCTAssertEqual(theirs.map(\.id), [2, 1])
        XCTAssertEqual(theirs[0].unreadCount, 2)
        XCTAssertEqual(try XCTUnwrap(GDMLogic.summaries(list, after: msg(3, group: 1), viewing: true))[0].unreadCount, 0)
        XCTAssertEqual(try XCTUnwrap(GDMLogic.summaries(list, after: msg(3, group: 2, mine: true), viewing: false))[0].unreadCount, 1)
        XCTAssertEqual(try XCTUnwrap(GDMLogic.summaries(list, after: msg(3, group: 2, system: true), viewing: false))[0].unreadCount, 1,
                       "a system line does not count")
        XCTAssertEqual(GDMLogic.summaries(list, after: msg(2, group: 2), viewing: false), list, "the same message twice")
        XCTAssertNil(GDMLogic.summaries(list, after: msg(4, group: 9), viewing: false), "unknown group → read the list again")
    }

    func testSummariesUpdatingAGroup() {
        let list = [GDMSummary(group: group(1), lastMessage: nil, unreadCount: 2), GDMSummary(group: group(2), lastMessage: nil, unreadCount: 0)]
        let renamed = GDMLogic.summaries(list, updating: group(2, title: "新しい名前", muted: true))
        XCTAssertEqual(renamed.map(\.id), [1, 2], "in place")
        XCTAssertEqual(renamed[1].group.title, "新しい名前")
        XCTAssertEqual(renamed[1].group.muted, true)
        let added = GDMLogic.summaries(list, updating: group(5))
        XCTAssertEqual(added.map(\.id), [5, 1, 2], "a group I was just added to comes first")
    }

    func testNewestFirstMixesKinds() {
        let now = Date()
        let items: [(String, String?)] = [("old", iso(60, from: now)), ("none", nil), ("new", iso(1, from: now)), ("mid", iso(10, from: now))]
        XCTAssertEqual(GDMLogic.newestFirst(items, at: { $0.1 }).map(\.0), ["new", "mid", "old", "none"])
    }

    // MARK: Words

    func testWords() {
        XCTAssertEqual(GDMLogic.preview(nil), "まだ発言はありません")
        XCTAssertEqual(GDMLogic.preview(msg(1, mine: true)), "あなた: b1")
        XCTAssertEqual(GDMLogic.preview(msg(1, from: "mazzo")), "mazzo: b1")
        XCTAssertEqual(GDMLogic.preview(msg(1, system: true)), "b1")

        let t = GDMLogic.notificationText(title: "週末の撮影", fromName: "mazzo", body: "晴れたら")
        XCTAssertEqual(t.title, "週末の撮影")
        XCTAssertEqual(t.body, "mazzo: 晴れたら")
        XCTAssertEqual(GDMLogic.notificationText(title: " ", fromName: nil, body: "x").title, "B-guru グループ DM")
        XCTAssertEqual(GDMLogic.notificationText(title: "g", fromName: "", body: "x").body, "会員: x")
        XCTAssertEqual(GDMLogic.notificationText(title: "g", fromName: "a", body: String(repeating: "あ", count: 300)).body.count, 241)

        XCTAssertNil(GDMLogic.cleanName("  \n", max: 40))
        XCTAssertEqual(GDMLogic.cleanName(" 撮影部 ", max: 40), "撮影部")
        XCTAssertEqual(GDMLogic.cleanName(String(repeating: "a", count: 50), max: 40)?.count, 40)
    }

    func testCandidates() {
        let people = [("u_b", "ビーグル"), ("u_me", "ドリキン"), ("u_1", "mazzo"), ("u_2", "NORIO TAKAHASHI"), ("u_3", "takuto")]
        let all = GDMLogic.candidates(people, id: { $0.0 }, name: { $0.1 }, excluding: ["u_me", "u_3"], query: "")
        XCTAssertEqual(all.map(\.0), ["u_1", "u_2"], "not me, not those already in, not ビーグル")
        XCTAssertEqual(GDMLogic.candidates(people, id: { $0.0 }, name: { $0.1 }, excluding: [], query: "norio taka").map(\.0), ["u_2"])
    }

    /// The member total is private: nothing typed shows only my 1:1 partners; typed shows ≤ 10 matches.
    func testPickerNeverShowsTheWholeList() {
        struct M { let id: String; let name: String }
        let all = (0..<50).map { M(id: "u\($0)", name: $0 == 0 ? "ビーグル" : "会員\($0)") }
        let empty = GDMLogic.pickerList(all, id: \.id, name: \.name, excluding: [], peerIds: ["u3", "u7"], selected: [], query: "")
        XCTAssertEqual(empty.map(\.id), ["u3", "u7"])
        XCTAssertTrue(GDMLogic.pickerList(all, id: \.id, name: \.name, excluding: [], peerIds: [], selected: [], query: " ").isEmpty)
        let typed = GDMLogic.pickerList(all, id: \.id, name: \.name, excluding: ["u1"], peerIds: [], selected: ["u2"], query: "会員")
        XCTAssertEqual(typed.first?.id, "u2")
        XCTAssertEqual(typed.count, 1 + GDMLogic.pickerLimit)
        XCTAssertFalse(typed.contains { $0.id == "u1" })
        XCTAssertTrue(GDMLogic.pickerList(all, id: \.id, name: \.name, excluding: [], peerIds: [], selected: [], query: "ビーグル").isEmpty)
    }

    /// 🖼 The group's photo: the stream's `group` brings it in (and takes it out), the multipart has one `photo` field.
    func testPhoto() throws {
        let set = try XCTUnwrap(GDMEvent.decode(Data(#"""
        {"action":"group","group":{"id":5,"name":"撮影部","photo":"/api/gdm/5/photo?v=ab12","title":"撮影部","members":[],"member_count":3,"is_creator":false,"muted":false,"created_at":"2026-11-06T00:00:00.000Z"}}
        """#.utf8)))
        XCTAssertEqual(set.group?.photo, "/api/gdm/5/photo?v=ab12")
        XCTAssertEqual(set.group?.photoPath, "/api/gdm/5/photo?v=ab12")
        let cleared = try XCTUnwrap(GDMEvent.decode(Data(#"""
        {"action":"group","group":{"id":5,"name":null,"photo":null,"title":"a、b","members":[]}}
        """#.utf8)))
        XCTAssertNil(cleared.group?.photoPath)
        let old = try XCTUnwrap(GDMEvent.decode(Data(#"{"action":"group","group":{"id":5,"title":"a","members":[]}}"#.utf8)))
        XCTAssertNil(old.group?.photo, "an older server says nothing: 👥")

        var list = [GDMSummary(group: GDMGroup(id: 5, name: nil, title: "a", members: []), lastMessage: nil, unreadCount: 2)]
        list = GDMLogic.summaries(list, updating: try XCTUnwrap(set.group))
        XCTAssertEqual(list.first?.group.photoPath, "/api/gdm/5/photo?v=ab12")
        XCTAssertEqual(list.first?.unreadCount, 2, "a new photo keeps the unread count")

        XCTAssertNil(GDMLogic.photoPath("  "))
        XCTAssertNil(GDMLogic.photoPath(nil))
        XCTAssertEqual(GDMLogic.photoButtonTitle(hasPhoto: false), "写真を設定")
        XCTAssertEqual(GDMLogic.photoButtonTitle(hasPhoto: true), "写真を変える")
        XCTAssertNil(GDMLogic.photoTooBig(100, max: 15 * 1024 * 1024))
        XCTAssertEqual(GDMLogic.photoTooBig(16 * 1024 * 1024, max: 15 * 1024 * 1024), "写真が大きすぎます（15MB まで）")

        let jpeg = Data([0xFF, 0xD8, 0x00, 0xFF, 0xD9])
        let body = GDMLogic.photoMultipart(jpeg, boundary: "XYZ")
        let head = Data("--XYZ\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"photo.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".utf8)
        XCTAssertEqual(body.prefix(head.count), head)
        XCTAssertEqual(body.dropFirst(head.count).prefix(jpeg.count), jpeg)
        XCTAssertTrue(body.suffix(10) == Data("\r\n--XYZ--\r\n".utf8).suffix(10))
    }
}
