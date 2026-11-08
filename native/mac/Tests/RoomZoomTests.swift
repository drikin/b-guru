import XCTest

/// 部室の拡大・縮小（shared/RoomZoom.swift）: 倍率の上下限・カメラ・タップの座標変換。
///   cd native/mac && xcodegen generate && xcodebuild test -project BguruChat.xcodeproj -scheme BguruChatTests
final class RoomZoomTests: XCTestCase {
    // 40×24 タイルの地図（art-pixel 640×384）。
    private let map = CGSize(width: 40 * 16, height: 24 * 16)
    private let phone = CGSize(width: 390, height: 360)
    private let mac = CGSize(width: 800, height: 400)

    func testScaleOneIsTheOldZoom() {
        XCTAssertEqual(RoomZoom.auto(view: phone), max(1.5, 390 / (16 * 13)), accuracy: 1e-9)
        XCTAssertEqual(RoomZoom.auto(view: mac), 800 / (16 * 20), accuracy: 1e-9)
        XCTAssertEqual(RoomZoom.zoom(scale: 1, view: phone, map: map), RoomZoom.auto(view: phone), accuracy: 1e-9)
    }

    func testLowerBoundShowsTheWholeMap() {
        let z = RoomZoom.zoom(scale: 0, view: phone, map: map)
        XCTAssertEqual(z, min(390 / 640, 360 / 384), accuracy: 1e-9)
        XCTAssertLessThanOrEqual(map.width * z, phone.width + 1e-9)
        XCTAssertLessThanOrEqual(map.height * z, phone.height + 1e-9)
        XCTAssertTrue(RoomZoom.isWhole(0, view: phone, map: map))
        XCTAssertTrue(RoomZoom.isWhole(0.01, view: phone, map: map))
        XCTAssertFalse(RoomZoom.isWhole(1, view: phone, map: map))
    }

    func testUpperBoundIsTwiceTheAutoZoom() {
        XCTAssertEqual(RoomZoom.zoom(scale: 9, view: mac, map: map), RoomZoom.auto(view: mac) * 2, accuracy: 1e-9)
        XCTAssertEqual(RoomZoom.clamp(.infinity, view: mac, map: map), 1)
    }

    func testSmallMapKeepsScaleOne() {
        // 地図が画面より小さい: 1.0 は今までと同じ（全体が収まる倍率まで勝手に大きくしない）。
        let small = CGSize(width: 8 * 16, height: 6 * 16)
        XCTAssertEqual(RoomZoom.minScale(view: mac, map: small), 1)
        XCTAssertEqual(RoomZoom.clamp(0, view: mac, map: small), 1)
        XCTAssertEqual(RoomZoom.toggledWhole(1, view: mac, map: small), 0)
    }

    func testStepsAndWholeToggle() {
        XCTAssertEqual(RoomZoom.zoomedIn(1, view: mac, map: map), 1.25, accuracy: 1e-9)
        XCTAssertEqual(RoomZoom.zoomedOut(1, view: mac, map: map), 0.8, accuracy: 1e-9)
        XCTAssertEqual(RoomZoom.zoomedIn(1.9, view: mac, map: map), 2, accuracy: 1e-9)
        // 全体から ＋ は今見えている倍率から 1.25 倍。
        let lo = RoomZoom.minScale(view: phone, map: map)
        XCTAssertEqual(RoomZoom.zoomedIn(0, view: phone, map: map), lo * 1.25, accuracy: 1e-9)
        XCTAssertEqual(RoomZoom.zoomedOut(lo * 1.1, view: phone, map: map), lo, accuracy: 1e-9)
        // 全体 ⇄ 1.0
        XCTAssertEqual(RoomZoom.toggledWhole(1.5, view: phone, map: map), 0)
        XCTAssertEqual(RoomZoom.toggledWhole(0, view: phone, map: map), 1)
    }

    func testCameraFollowsAndStopsAtEdges() {
        let z = RoomZoom.zoom(scale: 1, view: mac, map: map) // 2.5 → 320×160 art-pixels visible
        let mid = RoomZoom.camera(view: mac, z: z, map: map, focus: (20, 12))
        XCTAssertEqual(mid, CGPoint(x: 20.5 * 16 - 160, y: 12.5 * 16 - 80))
        XCTAssertEqual(RoomZoom.camera(view: mac, z: z, map: map, focus: (0, 0)), .zero)
        XCTAssertEqual(RoomZoom.camera(view: mac, z: z, map: map, focus: (39, 23)), CGPoint(x: 640 - 320, y: 384 - 160))
    }

    func testCameraCentersAWholeMap() {
        let z = RoomZoom.zoom(scale: 0, view: mac, map: map) // 高さで決まる: 400/384
        let cam = RoomZoom.camera(view: mac, z: z, map: map, focus: (3, 3))
        XCTAssertEqual(cam.y, 0)
        XCTAssertEqual(cam.x, ((640 - 800 / z) / 2).rounded())
        XCTAssertLessThan(cam.x, 0)
    }

    func testTapUsesTheSameZoomAndCamera() {
        for scale in [0.0, 0.8, 1, 1.37, 2] {
            let z = RoomZoom.zoom(scale: scale, view: phone, map: map)
            let cam = RoomZoom.camera(view: phone, z: z, map: map, focus: (17, 9))
            // 自分のタイルの真ん中は、描いた場所をタップすると自分のタイルに戻る。
            let p = CGPoint(x: ((17 + 0.5) * 16 - cam.x) * z, y: ((9 + 0.5) * 16 - cam.y) * z)
            let t = RoomZoom.tile(at: p, z: z, cam: cam)
            XCTAssertEqual(t.x, 17, "scale \(scale)")
            XCTAssertEqual(t.y, 9, "scale \(scale)")
        }
        // 地図の左の余白（cam.x < 0）はマイナスのタイル（歩けない）で、0 に丸めない（左に 64 art-pixel = 4 タイルの余白）。
        let z = RoomZoom.zoom(scale: 0, view: mac, map: map)
        let cam = RoomZoom.camera(view: mac, z: z, map: map, focus: (0, 0))
        XCTAssertEqual(RoomZoom.tile(at: CGPoint(x: 2, y: 10), z: z, cam: cam).x, -4)
        XCTAssertEqual(RoomZoom.tile(at: CGPoint(x: (64 - 8) * z, y: 10), z: z, cam: cam).x, -1)
    }
}
