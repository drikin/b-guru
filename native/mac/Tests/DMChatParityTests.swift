import XCTest

/// ✉️👥 DM のチャットと同じ機能 (docs/dm-chat-parity-spec.md): decoding the new fields (and their absence on
/// older servers), the stream's edit / reaction, the optimistic reaction toggle, the edit rule and @ mentions.
///   cd native/mac && xcodegen generate && xcodebuild test -project BguruChat.xcodeproj -scheme BguruChatTests
final class DMChatParityTests: XCTestCase {
    private func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    private func dm(_ id: Int, body: String = "b", mine: Bool = false, reactions: [Reaction] = []) -> DMMessage {
        var m = DMMessage(id: id, fromId: mine ? "me" : "p", toId: mine ? "p" : "me", peerId: "p", body: body,
                          createdAt: "2026-11-08T01:00:00Z", isAuthor: mine, clientId: nil)
        m.reactions = reactions
        return m
    }

    private func gdm(_ id: Int, body: String = "b", mine: Bool = false, system: Bool = false, beagle: Bool? = nil) -> GDMMessage {
        GDMMessage(id: id, groupId: 1, kind: system ? "system" : "text", fromId: "a", fromName: "a", fromAvatar: nil,
                   body: body, createdAt: "2026-11-08T01:00:00Z", isAuthor: mine, isBeagle: beagle, clientId: nil)
    }

    // MARK: Decoding

    func testDMMessageDecodesNewFields() throws {
        let m = try decoder().decode(DMMessage.self, from: Data(#"""
        {"id":5,"from_id":"u1","to_id":"u2","peer_id":"u1","body":"直した","images":[],"created_at":"2026-11-08T01:00:00Z",
         "is_author":false,"edited":true,"edited_at":"2026-11-08T01:05:00.000Z",
         "reactions":[{"emoji":"❤️","count":2,"mine":true,"reactors":["a","b"]},{"emoji":":party:","count":1,"mine":false,"reactors":["c"]}]}
        """#.utf8))
        XCTAssertTrue(m.edited)
        XCTAssertEqual(m.editedAt, "2026-11-08T01:05:00.000Z")
        XCTAssertEqual(m.reactions.map(\.emoji), ["❤️", ":party:"])
        XCTAssertEqual(m.reactions.first?.reactors, ["a", "b"])
        XCTAssertTrue(m.isStored)
    }

    func testDMMessageFromOlderServerDefaults() throws {
        let m = try decoder().decode(DMMessage.self, from: Data(#"""
        {"id":5,"from_id":"u1","to_id":"u2","peer_id":"u1","body":"やあ","created_at":"2026-11-08T01:00:00Z","is_author":true}
        """#.utf8))
        XCTAssertFalse(m.edited)
        XCTAssertNil(m.editedAt)
        XCTAssertEqual(m.reactions, [])
    }

    func testGDMMessageDecodesNewFieldsAndDefaults() throws {
        let m = try decoder().decode(GDMMessage.self, from: Data(#"""
        {"id":9,"group_id":1,"kind":"text","from_id":"u1","from_name":"mazzo","body":"x","created_at":"2026-11-08T01:00:00Z",
         "is_author":false,"edited":true,"edited_at":null,"reactions":[{"emoji":"👍","count":1,"mine":false,"reactors":["mazzo"]}]}
        """#.utf8))
        XCTAssertTrue(m.edited)
        XCTAssertNil(m.editedAt)
        XCTAssertEqual(m.reactions.count, 1)
        let old = try decoder().decode(GDMMessage.self, from: Data(#"""
        {"id":9,"group_id":1,"kind":"system","body":"mazzo さんが参加しました","created_at":"2026-11-08T01:00:00Z"}
        """#.utf8))
        XCTAssertFalse(old.edited)
        XCTAssertEqual(old.reactions, [])
        XCTAssertFalse(old.canBeReacted) // system lines carry no chips
    }

    func testGDMEventDecodesEditAndReaction() throws {
        let edit = try XCTUnwrap(GDMEvent.decode(Data(#"""
        {"action":"edit","group_id":3,"message":{"id":10,"group_id":3,"kind":"text","from_id":"u1","body":"new",
         "created_at":"2026-11-08T01:00:00Z","is_author":false,"edited":true,"edited_at":"2026-11-08T01:01:00Z","reactions":[]}}
        """#.utf8)))
        XCTAssertEqual(edit.action, "edit")
        XCTAssertEqual(edit.message?.body, "new")
        XCTAssertEqual(edit.message?.edited, true)
        let r = try XCTUnwrap(GDMEvent.decode(Data(#"""
        {"action":"reaction","group_id":3,"message_id":10,"reactions":[{"emoji":"🎉","count":3,"mine":true,"reactors":["a","b","c"]}]}
        """#.utf8)))
        XCTAssertEqual(r.messageId, 10)
        XCTAssertEqual(r.reactions?.first?.count, 3)
    }

    func testReactionAnswerDecodes() throws {
        let r = try decoder().decode(DMReactionResponse.self, from: Data(#"""
        {"added":true,"reactions":[{"emoji":"❤️","count":1,"mine":true,"reactors":["me"]}]}
        """#.utf8))
        XCTAssertEqual(r.added, true)
        XCTAssertEqual(r.reactions.first?.mine, true)
    }

    // MARK: Stream events

    func testDMEditReplacesTextKeepsChipsAndFlags() {
        var pending = dm(-1, body: "送信中", mine: true)
        pending.pending = true
        let chips = [Reaction(emoji: "❤️", count: 1, mine: false, reactors: ["p"])]
        let list = [dm(1, body: "old", reactions: chips), dm(2), pending]
        var edited = dm(1, body: "new")
        edited.edited = true
        edited.editedAt = "2026-11-08T02:00:00Z"
        edited.images = ["/api/media/dm-x.jpg"]
        let next = DMLogic.applyingEdit(list, edited)
        XCTAssertEqual(next.map(\.body), ["new", "b", "送信中"])
        XCTAssertTrue(next[0].edited)
        XCTAssertEqual(next[0].editedAt, "2026-11-08T02:00:00Z")
        XCTAssertEqual(next[0].images, ["/api/media/dm-x.jpg"])
        XCTAssertEqual(next[0].reactions, chips)
        XCTAssertTrue(next[2].pending)
        XCTAssertEqual(DMLogic.applyingEdit(list, dm(99, body: "x")), list) // not on screen: nothing changes
    }

    func testDMReactionEventSetsThatMessagesChips() {
        let list = [dm(1), dm(2)]
        let chips = [Reaction(emoji: "👀", count: 2, mine: true, reactors: ["me", "p"])]
        let next = DMLogic.settingReactions(list, id: 2, chips)
        XCTAssertEqual(next[0].reactions, [])
        XCTAssertEqual(next[1].reactions, chips)
        XCTAssertEqual(DMLogic.settingReactions(next, id: 2, [])[1].reactions, [])
    }

    func testDMListFollowsAnEditOfItsLastMessage() {
        let peer = DMPeer(userId: "p", name: "p", avatar: nil)
        let list = [DMConversation(peer: peer, lastMessage: dm(3, body: "old"), unreadCount: 1)]
        var e = dm(3, body: "new")
        e.edited = true
        let next = DMLogic.conversations(list, edited: e)
        XCTAssertEqual(next[0].lastMessage.body, "new")
        XCTAssertEqual(next[0].unreadCount, 1) // edits never change unread
        XCTAssertEqual(DMLogic.conversations(list, edited: dm(2, body: "x"))[0].lastMessage.body, "old")
    }

    func testGDMEditAndReaction() {
        let list = [gdm(1, system: true), gdm(2, body: "old", mine: true), gdm(3)]
        var e = gdm(2, body: "new", mine: true)
        e.edited = true
        let edited = GDMLogic.applyingEdit(list, e)
        XCTAssertEqual(edited.map(\.body), ["b", "new", "b"])
        XCTAssertTrue(edited[1].edited)
        let chips = [Reaction(emoji: "😂", count: 1, mine: false, reactors: ["a"])]
        XCTAssertEqual(GDMLogic.settingReactions(edited, id: 3, chips)[2].reactions, chips)

        let g = GDMGroup(id: 1, name: nil, title: "g", members: [], memberCount: 2, isCreator: false, muted: false, createdAt: nil)
        let s = [GDMSummary(group: g, lastMessage: gdm(2, body: "old", mine: true), unreadCount: 0)]
        XCTAssertEqual(GDMLogic.summaries(s, edited: e)[0].lastMessage?.body, "new")
    }

    // MARK: Rules

    func testOptimisticToggle() {
        let start = [Reaction(emoji: "❤️", count: 1, mine: false, reactors: ["a"])]
        let on = ReactionLogic.toggled(start, emoji: "❤️")
        XCTAssertEqual(on, [Reaction(emoji: "❤️", count: 2, mine: true, reactors: ["a"])])
        XCTAssertEqual(ReactionLogic.toggled(on, emoji: "❤️"), [Reaction(emoji: "❤️", count: 1, mine: false, reactors: ["a"])])
        let added = ReactionLogic.toggled(start, emoji: ":party:")
        XCTAssertEqual(added.map(\.emoji), ["❤️", ":party:"])
        XCTAssertEqual(added.last?.mine, true)
        XCTAssertEqual(ReactionLogic.toggled(added, emoji: ":party:"), start) // my only one goes away
    }

    func testEditedBodyRule() {
        XCTAssertEqual(DMLogic.editedBody("  直した \n", hasPhotos: false, maxBody: 1000), "直した")
        XCTAssertNil(DMLogic.editedBody("   ", hasPhotos: false, maxBody: 1000))
        XCTAssertEqual(DMLogic.editedBody("  ", hasPhotos: true, maxBody: 1000), "") // photos: the text may go
        XCTAssertNil(DMLogic.editedBody(String(repeating: "あ", count: 11), hasPhotos: false, maxBody: 10))
    }

    func testWhoCanBeEditedAndReacted() {
        XCTAssertTrue(gdm(2, mine: true).canBeEdited)
        XCTAssertFalse(gdm(2).canBeEdited) // others'
        XCTAssertFalse(gdm(2, mine: true, beagle: true).canBeEdited)
        XCTAssertFalse(gdm(2, mine: true, system: true).canBeEdited)
        var pending = gdm(-1, mine: true)
        pending.pending = true
        XCTAssertFalse(pending.canBeEdited)
        XCTAssertFalse(pending.canBeReacted)
        XCTAssertTrue(gdm(2, beagle: true).canBeReacted) // ビーグル's answers may get chips
        var failed = dm(-2, mine: true)
        failed.failed = true
        XCTAssertFalse(failed.isStored)
    }

    func testMentionsMe() {
        XCTAssertTrue(GDMLogic.mentions("@ドリキン 35mm で", name: "ドリキン"))
        XCTAssertTrue(GDMLogic.mentions("それな @drikin", name: "Drikin"))
        XCTAssertTrue(GDMLogic.mentions("@[Taro Yamada] どう？", name: "Taro Yamada"))
        XCTAssertFalse(GDMLogic.mentions("@ドリキンさん", name: "ドリキン")) // the server's rule: up to a space
        XCTAssertFalse(GDMLogic.mentions("ドリキン こんにちは", name: "ドリキン"))
        XCTAssertFalse(GDMLogic.mentions("@ビーグル 要約して", name: "ドリキン"))
        XCTAssertFalse(GDMLogic.mentions("@ドリキン", name: nil))
    }
}
