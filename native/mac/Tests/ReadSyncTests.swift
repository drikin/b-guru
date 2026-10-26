import XCTest

/// 既読で知らせを消す (shared/ReadSync.swift): which delivered notifications one read_sync word covers.
///   cd native/mac && xcodegen generate && xcodebuild test -project BguruChat.xcodeproj -scheme BguruChatTests
final class ReadSyncTests: XCTestCase {
    private func sync(_ p: [AnyHashable: Any]) -> ReadSync? { ReadSync(payload: p) }

    // MARK: Parsing

    func testParsesPushAndStream() throws {
        let push = try XCTUnwrap(sync(["kind": "read_sync", "scope": "chat", "up_to": NSNumber(value: 120), "aps": ["content-available": 1]]))
        XCTAssertEqual(push, ReadSync(scope: .chat, upTo: 120))
        let stream = try XCTUnwrap(ReadSync(json: Data(#"{"scope":"dm","peer_id":"u_2","up_to":55}"#.utf8)))
        XCTAssertEqual(stream, ReadSync(scope: .dm, upTo: 55, peerId: "u_2"))
        // FCM data: every value a string.
        XCTAssertEqual(sync(["kind": "read_sync", "scope": "shogi", "game_id": "7"]), ReadSync(scope: .shogi, gameId: 7))
        XCTAssertEqual(sync(["scope": "reply_all"]), ReadSync(scope: .replyAll))
    }

    func testRejectsOtherKindsAndIncompleteWords() {
        XCTAssertNil(sync(["kind": "chat_mention", "scope": "chat", "message_id": 3]))
        XCTAssertNil(sync(["kind": "read_sync", "scope": "something_new"]))
        XCTAssertNil(sync(["kind": "read_sync"]))
        XCTAssertNil(sync(["kind": "read_sync", "scope": "dm"]), "a dm word without peer_id would clear every DM")
        XCTAssertNil(sync(["kind": "read_sync", "scope": "reply"]))
        XCTAssertNil(sync(["kind": "read_sync", "scope": "shogi"]))
        XCTAssertNil(ReadSync(json: Data("not json".utf8)))
    }

    // MARK: iPhone: delivered pushes

    func testChatCoversMentionsUpToTheCursorAndTheRollingNew() {
        let s = ReadSync(scope: .chat, upTo: 100)
        XCTAssertTrue(s.matchesPush(identifier: "chat-90", userInfo: ["kind": "chat_mention", "message_id": 90]))
        XCTAssertTrue(s.matchesPush(identifier: "chat-100", userInfo: ["kind": "chat_mention", "message_id": 100]))
        XCTAssertFalse(s.matchesPush(identifier: "chat-101", userInfo: ["kind": "chat_mention", "message_id": 101]))
        XCTAssertTrue(s.matchesPush(identifier: "chat-new", userInfo: ["kind": "chat_new", "message_id": 99]))
        XCTAssertFalse(s.matchesPush(identifier: "chat-new", userInfo: ["kind": "chat_new", "message_id": 140]),
                       "a newer message arrived after the read: the rolling notification stays")
        XCTAssertTrue(s.matchesPush(identifier: "chat-new", userInfo: ["kind": "chat_new"]))
        XCTAssertFalse(s.matchesPush(identifier: "dm-u_1", userInfo: ["kind": "dm", "peer_id": "u_1"]))
        XCTAssertFalse(s.matchesPush(identifier: "x", userInfo: ["kind": "timeline_new", "post_id": 5]))
        // No up_to: everything in the chat.
        XCTAssertTrue(ReadSync(scope: .chat).matchesPush(identifier: "chat-999", userInfo: ["kind": "chat_mention", "message_id": 999]))
    }

    func testDecidesOnUserInfoNotOnTheIdentifier() {
        // The request identifier is whatever iOS made of it; what the push says wins.
        let s = ReadSync(scope: .chat, upTo: 10)
        XCTAssertFalse(s.matchesPush(identifier: "chat-5", userInfo: ["kind": "chat_mention", "message_id": 50]))
        XCTAssertTrue(s.matchesPush(identifier: "8F2C-UUID", userInfo: ["kind": "chat_mention", "message_id": 5]))
    }

    func testFallsBackToTheCollapseIdWithoutKind() {
        XCTAssertTrue(ReadSync(scope: .chat, upTo: 10).matchesPush(identifier: "chat-10", userInfo: [:]))
        XCTAssertFalse(ReadSync(scope: .chat, upTo: 10).matchesPush(identifier: "chat-11", userInfo: [:]))
        XCTAssertTrue(ReadSync(scope: .chat, upTo: 10).matchesPush(identifier: "chat-new", userInfo: [:]))
        XCTAssertTrue(ReadSync(scope: .dm, peerId: "u_1").matchesPush(identifier: "dm-u_1", userInfo: [:]))
        XCTAssertTrue(ReadSync(scope: .shogi, gameId: 3).matchesPush(identifier: "shogi-3", userInfo: [:]))
        XCTAssertTrue(ReadSync(scope: .replyAll).matchesPush(identifier: "reply-77", userInfo: [:]))
        XCTAssertTrue(ReadSync(scope: .offkai, eventId: 8).matchesPush(identifier: "offkai-8", userInfo: [:]))
        XCTAssertFalse(ReadSync(scope: .offkai, eventId: 8).matchesPush(identifier: "offkai-9", userInfo: [:]))
    }

    func testDMReplyShogiOffkai() {
        let dm = ReadSync(scope: .dm, upTo: 4, peerId: "u_1")
        XCTAssertTrue(dm.matchesPush(identifier: "dm-u_1", userInfo: ["kind": "dm", "peer_id": "u_1", "dm_id": 4]))
        XCTAssertFalse(dm.matchesPush(identifier: "dm-u_2", userInfo: ["kind": "dm", "peer_id": "u_2"]))

        let reply = ReadSync(scope: .reply, postId: 42)
        XCTAssertTrue(reply.matchesPush(identifier: "reply-901", userInfo: ["kind": "reply", "post_id": 42, "reply_id": 901]))
        XCTAssertFalse(reply.matchesPush(identifier: "reply-902", userInfo: ["kind": "reply", "post_id": 43, "reply_id": 902]))
        XCTAssertFalse(reply.matchesPush(identifier: "x", userInfo: ["kind": "timeline_new", "post_id": 42]))

        let all = ReadSync(scope: .replyAll)
        XCTAssertTrue(all.matchesPush(identifier: "reply-1", userInfo: ["kind": "reply", "post_id": 1]))
        XCTAssertFalse(all.matchesPush(identifier: "chat-1", userInfo: ["kind": "chat_mention", "message_id": 1]))

        let shogi = ReadSync(scope: .shogi, gameId: 12)
        XCTAssertTrue(shogi.matchesPush(identifier: "shogi-12", userInfo: ["kind": "shogi_turn", "game_id": 12]))
        XCTAssertTrue(shogi.matchesPush(identifier: "shogi-12", userInfo: ["kind": "shogi_offer", "game_id": "12"]))
        XCTAssertFalse(shogi.matchesPush(identifier: "shogi-13", userInfo: ["kind": "shogi_turn", "game_id": 13]))

        let offkai = ReadSync(scope: .offkai, eventId: 8)
        XCTAssertTrue(offkai.matchesPush(identifier: "offkai-8", userInfo: ["kind": "offkai_start", "event_id": 8]))
        XCTAssertFalse(offkai.matchesPush(identifier: "offkai-9", userInfo: ["kind": "offkai_start", "event_id": 9]))
        XCTAssertFalse(offkai.matchesPush(identifier: "voice-handoff", userInfo: ["kind": "voice_handoff", "target": "offkai", "event_id": 8]))
    }

    // MARK: Mac: its own notifications

    func testMacLocalIdentifiers() {
        let chat = ReadSync(scope: .chat, upTo: 50)
        XCTAssertTrue(chat.matchesLocal(identifier: "chat-50"))
        XCTAssertFalse(chat.matchesLocal(identifier: "chat-51"))
        XCTAssertFalse(chat.matchesLocal(identifier: "chat-new"), "the bundle goes through clearsChatBundle")
        XCTAssertTrue(chat.clearsChatBundle(newestId: 50))
        XCTAssertTrue(chat.clearsChatBundle(newestId: nil))
        XCTAssertFalse(chat.clearsChatBundle(newestId: 51))
        XCTAssertFalse(ReadSync(scope: .dm, peerId: "u").clearsChatBundle(newestId: nil))

        XCTAssertTrue(ReadSync(scope: .dm, peerId: "u_1").matchesLocal(identifier: "dm-u_1"))
        XCTAssertFalse(ReadSync(scope: .dm, peerId: "u_1").matchesLocal(identifier: "dm-u_10"))
        XCTAssertTrue(ReadSync(scope: .reply, postId: 9).matchesLocal(identifier: "post-9"))
        XCTAssertTrue(ReadSync(scope: .shogi, gameId: 3).matchesLocal(identifier: "shogi-3"))
        XCTAssertFalse(ReadSync(scope: .shogi, gameId: 3).matchesLocal(identifier: "shogi-30"))
        XCTAssertFalse(ReadSync(scope: .replyAll).matchesLocal(identifier: "post-9"))
        XCTAssertFalse(ReadSync(scope: .offkai).matchesLocal(identifier: "chat-1"))
    }
}
