import Foundation

// 📷 DM の写真（docs/dm-photos-spec.md）: 本文が空で写真だけの発言は、一覧のプレビューと通知で「📷 写真」と出す。
// Foundation だけ: アプリ（1 対 1・グループ）、iPhone の通知拡張（NSE）、Mac の単体テストが同じ文言を使う。

enum DMPhotoText {
    static let photo = "📷 写真"

    /// The body as it is, or 「📷 写真」 when it is empty (only whitespace) and there are photos.
    static func shown(body: String, imageCount: Int) -> String {
        if imageCount > 0, body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return photo }
        return body
    }

    /// The NSE's JSON (`message.images` as decoded by JSONSerialization): how many photos it has.
    static func imageCount(_ raw: Any?) -> Int { (raw as? [Any])?.count ?? 0 }
}
