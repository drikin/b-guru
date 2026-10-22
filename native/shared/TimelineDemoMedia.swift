#if DEBUG
import Foundation
import AVFoundation
import ImageIO
import UniformTypeIdentifiers
import SwiftUI

/// Dev only: the timeline's sample posts that show each display rule (the web's long-text
/// fold, pictures of every count and shape, a video, a sound, GIFs, many reactions,
/// mentions). Everything is made here, offline: pictures and the GIF go straight into the
/// image cache, the video and the sound are written to the app's temporary folder.
@MainActor
enum TimelineDemoMedia {
    /// Members for the demo (decides which @ are mentions): "Ryu Ishii" has a space, so it is
    /// written `@[Ryu Ishii]` and shown as "@Ryu Ishii".
    static let members = ["ドリキン", "mazzo", "NORIO TAKAHASHI", "Ryu Ishii", "takuto", "ビーグル", "kei", "sumi", "coban",
                          "ポンコツ散財王ドリキン", "りとる"]

    /// A picture `w`×`h` (two colour bands and its size written on it), in the image cache.
    static func picture(_ name: String, _ w: Int, _ h: Int, hue: CGFloat) -> String {
        let path = "selftest-media/parity-\(name).jpg"
        if MediaCache.shared.cached(path) == nil, let cg = draw(w, h, hue: hue, label: "\(w)×\(h)") {
            MediaCache.shared.debugInsert(PlatformImage.decoded(cg), for: path)
        }
        return path
    }

    /// An animated GIF (a bar sweeping across, 24 frames), in the data cache, under `i`.
    static func gif(_ i: Int) -> String {
        let path = "selftest-media/anim.gif?i=\(i)"
        MediaCache.shared.debugInsertData(gifData, for: path)
        return path
    }

    private static let gifData: Data = {
        let out = NSMutableData()
        let n = 24
        guard let dest = CGImageDestinationCreateWithData(out, UTType.gif.identifier as CFString, n, nil) else { return Data() }
        CGImageDestinationSetProperties(dest, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
        for f in 0..<n {
            guard let cg = draw(480, 270, hue: 0.33, label: "GIF \(f + 1)/\(n)", bar: CGFloat(f) / CGFloat(n)) else { continue }
            CGImageDestinationAddImage(dest, cg, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 0.08]] as CFDictionary)
        }
        CGImageDestinationFinalize(dest)
        return out as Data
    }()

    /// A 3-second 640×360 video (H.264) in the temporary folder, as a file URL.
    static let video: String = {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("bguru-demo-video.mp4")
        if !FileManager.default.fileExists(atPath: url.path) { writeVideo(to: url) }
        return url.absoluteString
    }()

    /// A 20-second tone in the temporary folder, as a file URL.
    static let audio: String = {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("bguru-demo-tone.caf")
        if !FileManager.default.fileExists(atPath: url.path) {
            let rate = 22_050.0
            let fmt = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
            let frames = AVAudioFrameCount(rate * 20)
            if let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames), let file = try? AVAudioFile(forWriting: url, settings: fmt.settings) {
                buf.frameLength = frames
                let p = buf.floatChannelData![0]
                for i in 0..<Int(frames) { p[i] = Float(sin(2 * Double.pi * 440 * Double(i) / rate) * 0.2) }
                try? file.write(from: buf)
            }
        }
        return url.absoluteString
    }()

    /// The sample posts, newest first (ids 101–112).
    static func posts(now: String) -> [Post] {
        let body501: String = {
            let head = "@ドリキン さん、@[Ryu Ishii] さん、@だれか さん（会員でない @ は普通の文字）。長文の折りたたみの確認です。"
            let filler = "タイムラインの長い投稿は Web と同じく 500 文字で畳み、続きを読むで開きます。"
            var s = head
            while s.utf16.count < 501 { s += filler }
            return TimelineRules.prefix(s, utf16: 500) + "末"
        }()
        let many = ["mazzo", "takuto", "NORIO TAKAHASHI", "リュウ", "ビーグル", "kei", "sumi", "coban", "りとる", "ゆう", "おもち", "ちー"]
        return [
            Post(id: 101, authorId: "r", authorName: "Ryu Ishii", isAuthor: false, replyCount: 1, text: body501, createdAt: now, club: "chat",
                 reactions: [Reaction(emoji: "👍", count: 3, mine: false, reactors: ["mazzo", "kei", "sumi"]),
                             Reaction(emoji: "❤️", count: 15, mine: true, reactors: many),
                             Reaction(emoji: "🎉", count: 3, mine: false, reactors: ["takuto", "coban", "りとる"]),
                             Reaction(emoji: "😂", count: 7, mine: false, reactors: Array(many.prefix(7)))],
                 unread: true),
            Post(id: 102, authorId: "a", authorName: "mazzo", isAuthor: false, replyCount: 0, text: "縦長 1 枚（400×1200）",
                 images: [picture("tall1", 400, 1200, hue: 0.1)], createdAt: now, club: "pet"),
            Post(id: 103, authorId: "a", authorName: "mazzo", isAuthor: false, replyCount: 0, text: "横長 1 枚（1800×600）",
                 images: [picture("wide1", 1800, 600, hue: 0.6)], createdAt: now, club: "pet"),
            Post(id: 104, authorId: "t", authorName: "takuto", isAuthor: false, replyCount: 0, text: "2 枚（縦長と横長）",
                 images: [picture("tall2", 600, 900, hue: 0.2), picture("wide2", 1600, 900, hue: 0.7)], createdAt: now, club: "apple"),
            Post(id: 105, authorId: "t", authorName: "takuto", isAuthor: false, replyCount: 0, text: "3 枚",
                 images: [picture("p3a", 1200, 900, hue: 0.3), picture("p3b", 900, 1200, hue: 0.8), picture("p3c", 1000, 1000, hue: 0.5)],
                 createdAt: now, club: "apple"),
            Post(id: 106, authorId: "n", authorName: "NORIO TAKAHASHI", isAuthor: false, replyCount: 0, text: "5 枚（いろいろな形）",
                 images: [picture("p5a", 1200, 900, hue: 0.05), picture("p5b", 600, 1200, hue: 0.25), picture("p5c", 1800, 600, hue: 0.45),
                          picture("p5d", 900, 900, hue: 0.65), picture("p5e", 900, 1600, hue: 0.85)],
                 createdAt: now, club: "car"),
            Post(id: 107, authorId: "k", authorName: "kei", isAuthor: false, replyCount: 0, text: "動画です（▶ で再生）",
                 videoUrl: video, createdAt: now, club: "chat"),
            Post(id: 108, authorId: "s", authorName: "sumi", isAuthor: false, replyCount: 0, text: "音声です",
                 audioUrl: audio, createdAt: now, club: "chat"),
            Post(id: 109, authorId: "c", authorName: "coban", isAuthor: false, replyCount: 0, text: "GIF 1 枚", images: [gif(0)],
                 createdAt: now, club: "chat"),
            Post(id: 110, authorId: "c", authorName: "coban", isAuthor: false, replyCount: 0, text: "GIF と写真",
                 images: [gif(1), picture("g2", 1200, 900, hue: 0.9)], createdAt: now, club: "chat"),
            Post(id: 111, authorId: "y", authorName: "ゆう", isAuthor: false, replyCount: 0,
                 text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", createdAt: now, club: "chat",
                 urlPreview: UrlPreview(url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "YouTube のカード（16:9）",
                                        description: "サムネは 16:9、最大幅 480", image: picture("yt", 1280, 720, hue: 0.0), siteName: "YouTube", videoId: "dQw4w9WgXcQ")),
        ]
    }

    private static func draw(_ w: Int, _ h: Int, hue: CGFloat, label: String, bar: CGFloat? = nil) -> CGImage? {
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.setFillColor(CGColor(red: 0.3 + hue * 0.6, green: 0.55, blue: 0.9 - hue * 0.5, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.35))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h / 3))
        if let bar {
            ctx.setFillColor(CGColor(red: 1, green: 0.85, blue: 0.1, alpha: 1))
            ctx.fill(CGRect(x: CGFloat(w) * bar, y: 0, width: CGFloat(w) / 8, height: CGFloat(h)))
        }
        // The size, big and black, so a picture's shape can be read off the screenshot.
        let font = CTFontCreateWithName("Helvetica-Bold" as CFString, CGFloat(min(w, h)) / 6, nil)
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: label, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 0, green: 0, blue: 0, alpha: 1),
        ]))
        ctx.textPosition = CGPoint(x: CGFloat(w) * 0.06, y: CGFloat(h) * 0.45)
        CTLineDraw(line, ctx)
        return ctx.makeImage()
    }

    private static func writeVideo(to url: URL) {
        guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return }
        let w = 640, h = 360, fps: Int32 = 15
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h,
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h,
        ])
        writer.add(input)
        guard writer.startWriting() else { return }
        writer.startSession(atSourceTime: .zero)
        for f in 0..<Int(fps) * 3 {
            while !input.isReadyForMoreMediaData { usleep(1000) }
            guard let pool = adaptor.pixelBufferPool else { break }
            var pb: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
            guard let pb, let img = draw(w, h, hue: 0.55, label: "VIDEO \(f / Int(fps) + 1)s", bar: CGFloat(f % Int(fps)) / CGFloat(fps)) else { continue }
            CVPixelBufferLockBaseAddress(pb, [])
            if let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb), width: w, height: h, bitsPerComponent: 8,
                                   bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                   bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
                ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
            }
            CVPixelBufferUnlockBaseAddress(pb, [])
            adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(f), timescale: fps))
        }
        input.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        done.wait()
    }
}
#endif
