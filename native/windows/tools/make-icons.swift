// アイコンを作る（Mac で実行）: swift native/windows/tools/make-icons.swift
// 元: public/icon-chat.png（B-guru のビーグル）。未読の版は右上に赤い点。ICO は PNG を並べた形式。
import AppKit

let root = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : FileManager.default.currentDirectoryPath)
let src = NSImage(contentsOf: root.appendingPathComponent("public/icon-chat.png"))!
let out = root.appendingPathComponent("native/windows/src/BguruChat.App/Assets")

func png(_ size: Int, dot: Bool) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    let s = CGFloat(size)
    src.draw(in: NSRect(x: 0, y: 0, width: s, height: s))
    if dot {
        let d = max(5, s * 0.42)
        let r = NSRect(x: s - d, y: s - d, width: d, height: d)
        NSColor.white.setFill(); NSBezierPath(ovalIn: r).fill()
        NSColor(red: 0.91, green: 0.16, blue: 0.18, alpha: 1).setFill()
        NSBezierPath(ovalIn: r.insetBy(dx: max(1, s * 0.04), dy: max(1, s * 0.04))).fill()
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

func ico(_ name: String, sizes: [Int], dot: Bool) throws {
    let images = sizes.map { png($0, dot: dot) }
    var d = Data()
    func u16(_ v: Int) { var x = UInt16(v).littleEndian; d.append(Data(bytes: &x, count: 2)) }
    func u32(_ v: Int) { var x = UInt32(v).littleEndian; d.append(Data(bytes: &x, count: 4)) }
    u16(0); u16(1); u16(images.count)
    var offset = 6 + 16 * images.count
    for (i, s) in sizes.enumerated() {
        d.append(UInt8(s >= 256 ? 0 : s)); d.append(UInt8(s >= 256 ? 0 : s)); d.append(0); d.append(0)
        u16(1); u16(32); u32(images[i].count); u32(offset)
        offset += images[i].count
    }
    images.forEach { d.append($0) }
    try d.write(to: out.appendingPathComponent(name))
}

try ico("app.ico", sizes: [16, 20, 24, 32, 40, 48, 64, 256], dot: false)
try ico("tray.ico", sizes: [16, 20, 24, 32, 40, 48], dot: false)
try ico("tray-unread.ico", sizes: [16, 20, 24, 32, 40, 48], dot: true)
try png(256, dot: false).write(to: out.appendingPathComponent("logo.png"))
print("ok")
