import XCTest

/// 🌐 パブリック DM と 🗄 アーカイブ (shared/GroupDMLogic.swift; docs/group-dm-spec.md「パブリック DM と アーカイブ」):
/// decoding with and without the new keys, the list's three parts, and what the screens offer.
final class GroupDMPublicTests: XCTestCase {
    private func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase // as APIClient
        return d
    }

    private func g(_ id: Int, isPublic: Bool? = nil, member: Bool? = nil, archived: Bool? = nil, creator: Bool = false) -> GDMGroup {
        GDMGroup(id: id, name: nil, title: "g\(id)", members: [], memberCount: 2, isCreator: creator, muted: false,
                 createdAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-Double(id) * 60)),
                 isPublic: isPublic, isMember: member, archived: archived)
    }

    private func s(_ group: GDMGroup, unread: Int = 0, isNew: Bool? = nil) -> GDMSummary {
        GDMSummary(group: group, lastMessage: nil, unreadCount: unread, isNew: isNew)
    }

    // MARK: Decoding

    func testOldServerListHasNoNewKeys() throws {
        let r = try decoder().decode(GDMListResponse.self, from: Data(#"""
        {"groups":[{"group":{"id":1,"name":null,"title":"a、b","members":[],"member_count":3,"is_creator":true,"muted":false,
                    "created_at":"2026-11-06T01:00:00Z"},"last_message":null,"unread_count":2}],"group_unread_count":2}
        """#.utf8))
        XCTAssertNil(r.publicGroups)
        XCTAssertNil(r.archivedGroups)
        let grp = r.groups[0].group
        XCTAssertNil(grp.isPublic)
        XCTAssertFalse(grp.isPublicDM)
        XCTAssertTrue(grp.joined, "older servers: I am in it")
        XCTAssertFalse(grp.isArchived)
        XCTAssertTrue(GDMLogic.belongsInMyList(grp))
        XCTAssertNil(r.groups[0].isNew)
        let sec = GDMLogic.sections(r)
        XCTAssertEqual(sec.mine.map(\.id), [1])
        XCTAssertTrue(sec.publicGroups.isEmpty)
        XCTAssertTrue(sec.archived.isEmpty)
        XCTAssertEqual(GDMLogic.composerMode(grp, canSend: true, groupCanSend: true), .write)
    }

    func testNewServerListDecodesPublicAndArchived() throws {
        let r = try decoder().decode(GDMListResponse.self, from: Data(#"""
        {"groups":[{"group":{"id":1,"name":"雑談","title":"雑談","members":[],"is_public":true,"is_member":true,"archived":false,"archived_at":null},
                    "last_message":null,"unread_count":1}],
         "public_groups":[{"group":{"id":2,"name":"ひろば","title":"ひろば","members":[],"is_public":true,"is_member":false,"archived":false,"archived_at":null},
                    "last_message":null,"unread_count":0,"is_new":true}],
         "archived_groups":[{"group":{"id":3,"name":"昔","title":"昔","members":[],"is_public":true,"is_member":true,"archived":true,
                    "archived_at":"2026-11-09T01:00:00.000Z"},"last_message":null,"unread_count":0}],
         "group_unread_count":1}
        """#.utf8))
        XCTAssertEqual(r.groups[0].group.isPublic, true)
        XCTAssertEqual(r.publicGroups?.first?.isNew, true)
        XCTAssertEqual(r.publicGroups?.first?.group.isMember, false)
        XCTAssertEqual(r.archivedGroups?.first?.group.archivedAt, "2026-11-09T01:00:00.000Z")
        let sec = GDMLogic.sections(r)
        XCTAssertEqual(sec.mine.map(\.id), [1])
        XCTAssertEqual(sec.publicGroups.map(\.id), [2])
        XCTAssertEqual(sec.publicGroups.first?.isNew, true)
        XCTAssertEqual(sec.archived.map(\.id), [3])
    }

    func testStreamGroupEventCarriesArchive() throws {
        let e = try XCTUnwrap(GDMEvent.decode(Data(#"""
        {"action":"group","group":{"id":5,"name":"x","title":"x","members":[],"is_public":true,"is_member":true,"archived":true,"archived_at":"2026-11-09T01:00:00Z"}}
        """#.utf8)))
        XCTAssertEqual(e.group?.isArchived, true)
        XCTAssertFalse(GDMLogic.belongsInMyList(try XCTUnwrap(e.group)))
    }

    // MARK: Sections

    func testSectionsNeverShowAGroupTwiceAndDropStrays() {
        let r = GDMListResponse(
            groups: [s(g(1)), s(g(2, isPublic: true, member: true, archived: true))],
            publicGroups: [s(g(1, isPublic: true, member: false)), s(g(4, isPublic: true, member: false), unread: 3),
                           s(g(5, isPublic: true, member: true))],
            archivedGroups: [s(g(2, isPublic: true, member: true, archived: true)), s(g(6, isPublic: true, archived: false))],
            groupUnreadCount: 0)
        let sec = GDMLogic.sections(r)
        XCTAssertEqual(sec.mine.map(\.id), [1], "an archived group never stays in my list")
        XCTAssertEqual(sec.archived.map(\.id), [2], "only archived ones")
        XCTAssertEqual(sec.publicGroups.map(\.id), [4], "not mine, not joined, not archived")
        XCTAssertEqual(sec.publicGroups[0].unreadCount, 0, "nothing is unread in a group I am not in")
    }

    func testPlacingMovesGroupsBetweenParts() {
        let start = GDMListSections(mine: [s(g(1)), s(g(2, isPublic: true, member: true), unread: 2)],
                                    publicGroups: [s(g(3, isPublic: true, member: false))],
                                    archived: [s(g(4, isPublic: true, member: true, archived: true))])
        // Archived by someone: out of mine (read the list again).
        var r = GDMLogic.placing(g(2, isPublic: true, member: true, archived: true), in: start)
        XCTAssertTrue(r.leftMine)
        XCTAssertEqual(r.sections.mine.map(\.id), [1])
        XCTAssertEqual(r.sections.archived.map(\.id), [2, 4])

        // I left a public one (is_member false): out of mine, under public.
        r = GDMLogic.placing(g(2, isPublic: true, member: false), in: start)
        XCTAssertTrue(r.leftMine)
        XCTAssertEqual(r.sections.publicGroups.map(\.id), [2, 3])

        // Joined: from public to the top of mine, nothing unread.
        r = GDMLogic.placing(g(3, isPublic: true, member: true), in: start)
        XCTAssertFalse(r.leftMine)
        XCTAssertEqual(r.sections.mine.map(\.id), [3, 1, 2])
        XCTAssertEqual(r.sections.mine[0].unreadCount, 0)
        XCTAssertTrue(r.sections.publicGroups.isEmpty)

        // Un-archived: from archived to mine.
        r = GDMLogic.placing(g(4, isPublic: true, member: true, archived: false), in: start)
        XCTAssertEqual(r.sections.mine.first?.id, 4)
        XCTAssertTrue(r.sections.archived.isEmpty)

        // A non-member's read of a public group: updated where it is, never into mine.
        var renamed = g(3, isPublic: true, member: false)
        renamed.title = "新しい名前"
        r = GDMLogic.placing(renamed, in: start)
        XCTAssertFalse(r.leftMine)
        XCTAssertEqual(r.sections.mine.map(\.id), [1, 2])
        XCTAssertEqual(r.sections.publicGroups.first?.group.title, "新しい名前")

        // A plain (older server) group update stays as before.
        r = GDMLogic.placing(g(1), in: start)
        XCTAssertEqual(r.sections, start)
    }

    // MARK: What the screens offer

    func testComposerMode() {
        XCTAssertEqual(GDMLogic.composerMode(g(1, isPublic: true, member: false), canSend: true, groupCanSend: false), .join)
        XCTAssertEqual(GDMLogic.composerMode(g(1, isPublic: true, member: false), canSend: false, groupCanSend: false), .cannotSend)
        XCTAssertEqual(GDMLogic.composerMode(g(1, isPublic: true, member: true, archived: true), canSend: true, groupCanSend: false), .archived)
        XCTAssertEqual(GDMLogic.composerMode(g(1, isPublic: true, member: false, archived: true), canSend: true, groupCanSend: false), .archived)
        XCTAssertEqual(GDMLogic.composerMode(g(1, isPublic: true, member: true), canSend: true, groupCanSend: true), .write)
        XCTAssertEqual(GDMLogic.composerMode(g(1), canSend: true, groupCanSend: false), .cannotSend)
        XCTAssertEqual(GDMLogic.composerMode(nil, canSend: true, groupCanSend: true), .write)
    }

    func testMembersScreenRules() {
        XCTAssertTrue(GDMLogic.canRemoveOthers(g(1, creator: true)))
        XCTAssertFalse(GDMLogic.canRemoveOthers(g(1, isPublic: true, member: true, creator: true)), "no 「外す」 in a public group")
        XCTAssertFalse(GDMLogic.canChangeSettings(g(1, isPublic: true, member: true, archived: true)))
        XCTAssertFalse(GDMLogic.canChangeSettings(g(1, isPublic: true, member: false)))
        XCTAssertTrue(GDMLogic.canChangeSettings(g(1)))
        XCTAssertTrue(GDMLogic.canArchive(g(1, isPublic: true, member: true)))
        XCTAssertTrue(GDMLogic.canArchive(g(1, isPublic: true, member: true, archived: true)), "to un-archive")
        XCTAssertFalse(GDMLogic.canArchive(g(1, isPublic: true, member: false)))
        XCTAssertFalse(GDMLogic.canArchive(g(1)))
        XCTAssertTrue(GDMLogic.leaveMessage(isPublic: true).contains("いつでもまた参加できます"))
        XCTAssertEqual(GDMLogic.kindMark(g(1, isPublic: true)), "🌐 ")
        XCTAssertEqual(GDMLogic.kindMark(g(1, isPublic: true, archived: true)), "🗄 ")
        XCTAssertEqual(GDMLogic.kindMark(g(1)), "")
    }

    func testCanCreate() {
        XCTAssertFalse(GDMLogic.canCreate(isPublic: false, name: "名前", memberCount: 0))
        XCTAssertTrue(GDMLogic.canCreate(isPublic: false, name: "", memberCount: 1))
        XCTAssertTrue(GDMLogic.canCreate(isPublic: true, name: "ひろば", memberCount: 0), "public: just me is fine")
        XCTAssertFalse(GDMLogic.canCreate(isPublic: true, name: "  ", memberCount: 3), "public needs a name")
    }
}
