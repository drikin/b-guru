// Upside-down check for screenshots of the apps (Mac panel / iOS simulator).
//
//   swift native/mac/scripts/orientation-check.swift [--min N] IMAGE…
//   swift native/mac/scripts/orientation-check.swift --make-photo OUT.jpg   (the tour's test picture)
//
// Reads each image with Vision's text recognition (Japanese + English) as it is and mirrored
// top to bottom. A screen drawn the right way up reads far better as it is; one flipped —
// the whole frame, or every glyph (the 2026-10-19 glyph-cache bug) — reads better mirrored.
// Prints one line per image and exits 1 if any image is not clearly upright (or has too
// little text to tell: fewer than --min characters, default 12).
import AppKit
import Vision

func readText(_ image: CGImage) -> (chars: Int, sample: String) {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["ja-JP", "en-US"]
    req.usesLanguageCorrection = false
    req.minimumTextHeight = 0.008 // small labels count too (the default skips text under 1/32 of the height)
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try? handler.perform([req])
    var chars = 0
    var lines: [String] = []
    for o in req.results ?? [] {
        guard let c = o.topCandidates(1).first, c.confidence >= 0.5 else { continue }
        chars += c.string.count
        lines.append(c.string)
    }
    return (chars, lines.prefix(3).joined(separator: " / "))
}

func mirrored(_ image: CGImage) -> CGImage? {
    let w = image.width, h = image.height
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    // Mirrored top to bottom: what an upside-down frame (or upside-down glyphs) needs to
    // read again. (A 180° turn would not do: Vision reads turned text as well.)
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: 1, y: -1)
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()
}

var args = Array(CommandLine.arguments.dropFirst())
// --make-photo OUT.png: a picture with large words, for the picture viewer step of the tour
// (a photo without words could not be told upright from upside down).
if args.first == "--make-photo", args.count >= 2 {
    let size = NSSize(width: 900, height: 600)
    let img = NSImage(size: size, flipped: false) { r in
        NSColor.white.setFill(); r.fill()
        let style: [NSAttributedString.Key: Any] = [.font: NSFont.boldSystemFont(ofSize: 64), .foregroundColor: NSColor.black]
        ("写真のテスト" as NSString).draw(at: NSPoint(x: 60, y: 380), withAttributes: style)
        ("B-guru Photo 2026" as NSString).draw(at: NSPoint(x: 60, y: 260), withAttributes: style)
        ("上が上です" as NSString).draw(at: NSPoint(x: 60, y: 140), withAttributes: style)
        return true
    }
    guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
          let jpg = rep.representation(using: .jpeg, properties: [:]) else { exit(1) }
    try? jpg.write(to: URL(fileURLWithPath: args[1]))
    exit(0)
}
var minChars = 12
if let i = args.firstIndex(of: "--min"), i + 1 < args.count, let n = Int(args[i + 1]) {
    minChars = n
    args.removeSubrange(i...(i + 1))
}
guard !args.isEmpty else {
    FileHandle.standardError.write(Data("usage: orientation-check.swift [--min N] IMAGE…\n".utf8))
    exit(2)
}

var failed = 0
for path in args {
    guard let src = NSImage(contentsOfFile: path),
          let img = src.cgImage(forProposedRect: nil, context: nil, hints: nil),
          let flip = mirrored(img) else {
        print("FAIL  \(path): cannot read")
        failed += 1
        continue
    }
    let a = readText(img), b = readText(flip)
    let ok = a.chars >= minChars && Double(a.chars) > Double(b.chars) * 1.5
    if !ok { failed += 1 }
    print("\(ok ? "ok  " : "FAIL") \((path as NSString).lastPathComponent): upright \(a.chars) chars, mirrored \(b.chars)  [\(a.sample.prefix(60))]")
}
exit(failed == 0 ? 0 : 1)
