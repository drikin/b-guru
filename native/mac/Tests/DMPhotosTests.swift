import XCTest

/// 📷 DM の写真 (docs/dm-photos-spec.md; shared/DMLogic.swift, shared/GroupDMLogic.swift, shared/DMPhotoText.swift):
/// `images` decodes with a default of [], and photos alone read 「📷 写真」 in the list and notifications.
///   cd native/mac && xcodegen generate && xcodebuild test -project BguruChat.xcodeproj -scheme BguruChatTests
final class DMPhotosTests: XCTestCase {
    private func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }

    // MARK: 1:1 DM

    func testDMMessageDecodesImages() throws {
        let m = try decoder().decode(DMMessage.self, from: Data(#"""
        {"id":5,"from_id":"u_1","to_id":"u_2","peer_id":"u_1","body":"","images":["/api/media/dm-1-a.jpg","/api/media/dm-1-b.jpg"],
         "created_at":"2026-11-08T01:02:03.000Z","is_author":false,"client_id":null}
        """#.utf8))
        XCTAssertEqual(m.images, ["/api/media/dm-1-a.jpg", "/api/media/dm-1-b.jpg"])
        XCTAssertEqual(m.body, "")
        XCTAssertEqual(m.shownBody, "📷 写真")
        XCTAssertFalse(m.pending)
        XCTAssertFalse(m.failed)
    }

    func testDMMessageWithoutImagesDefaultsToEmpty() throws {
        // Older servers (and stream events) say nothing about photos.
        let m = try decoder().decode(DMMessage.self, from: Data(#"""
        {"id":6,"from_id":"u_1","to_id":"u_2","peer_id":"u_1","body":"やあ","created_at":"2026-11-08T01:02:03Z","is_author":true}
        """#.utf8))
        XCTAssertEqual(m.images, [])
        XCTAssertNil(m.clientId)
        XCTAssertEqual(m.shownBody, "やあ")
        // null is read as none, too
        let n = try decoder().decode(DMMessage.self, from: Data(#"""
        {"id":7,"from_id":"u_1","to_id":"u_2","peer_id":"u_1","body":"x","images":null,"created_at":"2026-11-08T01:02:03Z","is_author":true}
        """#.utf8))
        XCTAssertEqual(n.images, [])
    }

    func testDMListAndThreadDecode() throws {
        let list = try decoder().decode(DMListResponse.self, from: Data(#"""
        {"conversations":[{"peer":{"user_id":"u_1","name":"takuto","avatar":null},
          "last_message":{"id":9,"from_id":"u_1","to_id":"u_2","peer_id":"u_1","body":"","images":["/api/media/dm-x.jpg"],
                          "created_at":"2026-11-08T01:02:03Z","is_author":false},"unread_count":1}],"unread_count":1}
        """#.utf8))
        XCTAssertEqual(list.conversations.first?.lastMessage.shownBody, "📷 写真")
    }

    func testDMMessageRoundTripsImages() throws {
        // The store keeps DMConversation (Codable): images survive encoding.
        let m = DMMessage(id: 1, fromId: "a", toId: "b", peerId: "b", body: "", images: ["/api/media/dm-1.jpg"],
                          createdAt: "2026-11-08T01:02:03Z", isAuthor: true, clientId: "c")
        let enc = JSONEncoder()
        enc.keyEncodingStrategy = .convertToSnakeCase
        let back = try decoder().decode(DMMessage.self, from: enc.encode(m))
        XCTAssertEqual(back, m)
    }

    // MARK: Group DM

    func testGDMMessageDecodesImagesAndPreview() throws {
        let m = try decoder().decode(GDMMessage.self, from: Data(#"""
        {"id":10,"group_id":3,"kind":"text","from_id":"u_1","from_name":"mazzo","from_avatar":null,"body":"",
         "images":["/api/media/dm-2.jpg"],"created_at":"2026-11-08T01:02:03Z","is_author":false}
        """#.utf8))
        XCTAssertEqual(m.images, ["/api/media/dm-2.jpg"])
        XCTAssertEqual(GDMLogic.preview(m), "mazzo: 📷 写真")
        var mine = m
        mine.isAuthor = true
        XCTAssertEqual(GDMLogic.preview(mine), "あなた: 📷 写真")
        XCTAssertEqual(GDMLogic.notificationText(title: "週末", fromName: m.fromName, body: m.shownBody).body, "mazzo: 📷 写真")
    }

    func testGDMMessageWithoutImagesDefaultsToEmpty() throws {
        let e = try XCTUnwrap(GDMEvent.decode(Data(#"""
        {"action":"create","group_id":3,"message":{"id":11,"group_id":3,"kind":"system","from_id":null,"from_name":null,
          "from_avatar":null,"body":"mazzo さんがグループを作りました","created_at":"2026-11-08T01:02:03Z","is_author":false}}
        """#.utf8)))
        XCTAssertEqual(e.message?.images, [])
        XCTAssertEqual(GDMLogic.preview(e.message), "mazzo さんがグループを作りました")
    }

    // MARK: The words

    func testShownText() {
        XCTAssertEqual(DMPhotoText.shown(body: "", imageCount: 1), "📷 写真")
        XCTAssertEqual(DMPhotoText.shown(body: " \n", imageCount: 4), "📷 写真")
        XCTAssertEqual(DMPhotoText.shown(body: "見て", imageCount: 2), "見て")
        XCTAssertEqual(DMPhotoText.shown(body: "", imageCount: 0), "")
        XCTAssertEqual(DMPhotoText.shown(body: "文字だけ", imageCount: 0), "文字だけ")
    }

    func testNSEImageCount() {
        // JSONSerialization's arrays (the iPhone's notification extension).
        let json = try? JSONSerialization.jsonObject(with: Data(#"{"images":["/a.jpg","/b.jpg"],"none":null}"#.utf8)) as? [String: Any]
        XCTAssertEqual(DMPhotoText.imageCount(json?["images"]), 2)
        XCTAssertEqual(DMPhotoText.imageCount(json?["none"]), 0)
        XCTAssertEqual(DMPhotoText.imageCount(nil), 0)
    }

    // MARK: ✉️ as a tab (DMRoute ⇄ the iPhone's navigation path)

    func testRoutePath() {
        let p = DMPeer(userId: "u_1", name: nil, avatar: nil)
        XCTAssertEqual(DMRoute.path(for: nil), [])
        XCTAssertEqual(DMRoute.path(for: .list), [])
        XCTAssertEqual(DMRoute.path(for: .thread(p)), [.thread(p)])
        XCTAssertEqual(DMRoute.path(for: .group(3)), [.group(3)])
        XCTAssertEqual(DMRoute.path(for: .groupMembers(3)), [.group(3), .groupMembers(3)])
        XCTAssertEqual(DMRoute.path(for: .newGroup), [.newGroup])
        // back / swipe back
        XCTAssertEqual(DMRoute.route(for: []), .list)
        XCTAssertEqual(DMRoute.route(for: [.group(3)]), .group(3))
        XCTAssertEqual(DMRoute.route(for: DMRoute.path(for: .groupMembers(3))), .groupMembers(3))
    }

    func testRouteIsThePersonNotTheirName() {
        // The store fills in the name and face after loading: the same page, not a new one pushed.
        let bare = DMRoute.thread(DMPeer(userId: "u_1", name: nil, avatar: nil))
        let filled = DMRoute.thread(DMPeer(userId: "u_1", name: "takuto", avatar: "/a.png"))
        XCTAssertEqual(bare, filled)
        XCTAssertEqual(Set([bare, filled]).count, 1)
        XCTAssertNotEqual(bare, .thread(DMPeer(userId: "u_2", name: nil, avatar: nil)))
        XCTAssertNotEqual(DMRoute.group(1), .groupMembers(1))
    }

    // MARK: ＋ 新規 DM (the group picker's rule)

    func testNewDMList() {
        struct M { var id: String; var name: String }
        let all = [M(id: "b", name: "ビーグル"), M(id: "me", name: "ドリキン"), M(id: "u1", name: "mazzo"),
                   M(id: "u2", name: "takuto"), M(id: "u3", name: "coban")] + (0..<20).map { M(id: "x\($0)", name: "member\($0)") }
        // Nothing typed: only the people I already DM (never the whole membership).
        let start = GDMLogic.newDMList(all, id: \.id, name: \.name, me: "me", peerIds: ["u1", "u3"], query: "")
        XCTAssertEqual(start.map(\.id), ["u1", "u3"])
        // Typed: matching names, not me, not ビーグル, capped.
        XCTAssertEqual(GDMLogic.newDMList(all, id: \.id, name: \.name, me: "me", peerIds: [], query: "TAK").map(\.id), ["u2"])
        XCTAssertTrue(GDMLogic.newDMList(all, id: \.id, name: \.name, me: "me", peerIds: [], query: "ドリ").isEmpty)
        XCTAssertTrue(GDMLogic.newDMList(all, id: \.id, name: \.name, me: "me", peerIds: [], query: "ビーグル").isEmpty)
        XCTAssertEqual(GDMLogic.newDMList(all, id: \.id, name: \.name, me: nil, peerIds: [], query: "member").count, GDMLogic.pickerLimit)
    }
}
