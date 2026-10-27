import Foundation
import ImageIO
import UniformTypeIdentifiers

/// カスタム絵文字の登録の決まり（サーバの lib/custom-emoji.ts・lib/reactions.ts と同じ）。画面を持たないのでテストできる。
/// 2026-10-27 オーナー「誰でもどこからでも絵文字を登録削除できるようにする」。
enum CustomEmojiRules {
    /// サーバが受け取る画像の上限（EMOJI_MAX_BYTES）。
    static let maxBytes = 256 * 1024
    /// 端末で縮める長い辺。チップでは 20px ほどなので 128px で十分（Retina の 3 倍でも足りる）。
    static let maxPixel = 128
    /// 名前の長さの上限（CUSTOM_NAME_RE）。
    static let maxNameLength = 32

    /// 打った名前をサーバと同じ形に（前後の空白と「:」を外して小文字に）。
    static func normalized(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while s.hasPrefix(":") { s.removeFirst() }
        while s.hasSuffix(":") { s.removeLast() }
        return s
    }

    /// 名前に問題があればその理由（入力中にそのまま出す）。nil なら送れる。
    /// `taken`: いま登録されている名前（同じ名前は 409 になるので先に知らせる）。
    static func nameProblem(_ raw: String, taken: Set<String> = []) -> String? {
        let name = normalized(raw)
        if name.isEmpty { return "名前を入れてください" }
        if name.count > maxNameLength { return "名前は\(maxNameLength)文字までです" }
        if !name.unicodeScalars.allSatisfy(isNameScalar) { return "名前は英小文字・数字・_ だけ使えます" }
        if taken.contains(name) { return "その名前は既に使われています" }
        return nil
    }

    private static func isNameScalar(_ c: Unicode.Scalar) -> Bool {
        ("a"..."z").contains(c) || ("0"..."9").contains(c) || c == "_"
    }

    /// ファイル名から名前の候補（使えない文字は _、32 文字まで）。候補が作れなければ空。
    static func suggestedName(fromFilename filename: String) -> String {
        let base = (filename as NSString).deletingPathExtension.lowercased()
        var out = ""
        var lastUnderscore = false
        for c in base.unicodeScalars {
            if isNameScalar(c) {
                out.unicodeScalars.append(c)
                lastUnderscore = c == "_"
            } else if !lastUnderscore, !out.isEmpty {
                out.append("_")
                lastUnderscore = true
            }
        }
        while out.hasSuffix("_") { out.removeLast() }
        return String(out.prefix(maxNameLength))
    }

    /// 送り方: GIF は 256KB 以内ならそのまま（動きを残す）。それ以外は縮めた PNG（GIF なら 1 コマ目）。
    enum Output: Equatable {
        case asIs(mime: String, ext: String)
        case png
    }

    static func output(isGIF: Bool, byteCount: Int) -> Output {
        if isGIF, byteCount <= maxBytes { return .asIs(mime: "image/gif", ext: "gif") }
        return .png
    }

    /// 長い辺を `maxPixel` 以下に（小さい画像は広げない）。縦横比はそのまま、1px 未満にはしない。
    static func fittedSize(width: Int, height: Int, maxPixel: Int = maxPixel) -> (width: Int, height: Int) {
        guard width > 0, height > 0 else { return (0, 0) }
        let longSide = max(width, height)
        guard longSide > maxPixel else { return (width, height) }
        let scale = Double(maxPixel) / Double(longSide)
        return (max(1, Int((Double(width) * scale).rounded())), max(1, Int((Double(height) * scale).rounded())))
    }

    /// 送る形にした画像。
    struct Prepared: Equatable, Sendable {
        var data: Data
        var mime: String
        var filename: String
        var width: Int
        var height: Int
    }

    /// 選んだ画像のバイト列を送れる形に（端末で縮める。位置情報などのメタデータは PNG に入れない）。
    /// 画像として読めない・縮めても 256KB を超えるときは nil。
    static func prepare(_ data: Data) -> Prepared? {
        guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(src) > 0 else { return nil }
        let type = CGImageSourceGetType(src) as String?
        let isGIF = type == UTType.gif.identifier
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
        let w = props?[kCGImagePropertyPixelWidth] as? Int ?? 0
        let h = props?[kCGImagePropertyPixelHeight] as? Int ?? 0
        switch output(isGIF: isGIF, byteCount: data.count) {
        case let .asIs(mime, ext):
            return Prepared(data: data, mime: mime, filename: "emoji.\(ext)", width: w, height: h)
        case .png:
            // 向き（EXIF）を当てたうえで、長い辺を maxPixel 以下に。
            let opts: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixel,
                kCGImageSourceShouldCacheImmediately: true,
            ]
            guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
            let out = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(dest, cg, nil)
            guard CGImageDestinationFinalize(dest), out.length > 0, out.length <= maxBytes else { return nil }
            return Prepared(data: out as Data, mime: "image/png", filename: "emoji.png", width: cg.width, height: cg.height)
        }
    }

    /// 削除の確認の文（Web と同じ意味: リアクションも消える）。
    static func deleteWarning(_ name: String) -> String {
        ":\(name): を削除すると、この絵文字のリアクションも全部消えます"
    }

    /// multipart/form-data の本文（name と image）。
    static func multipartBody(name: String, image: Prepared, boundary: String) -> Data {
        var body = Data()
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\n\(name)\r\n".utf8))
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"image\"; filename=\"\(image.filename)\"\r\nContent-Type: \(image.mime)\r\n\r\n".utf8))
        body.append(image.data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return body
    }
}
