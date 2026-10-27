package fm.backspace.bguru.chat

/** カスタム絵文字の登録・削除の決まり（Android の部品なし。CustomEmojiRulesTest）。
 *  サーバの決まりは src/lib/custom-emoji.ts と reactions.ts の CUSTOM_NAME_RE（/^[a-z0-9_]{1,32}$/）。
 *  2026-10-27 オーナー「誰でもどこからでも絵文字を登録削除できるようにする」。 */
object CustomEmojiRules {
    /** サーバが受け付ける画像の大きさ（EMOJI_MAX_BYTES）。 */
    const val MAX_BYTES = 256 * 1024
    /** 端末で縮める長辺。チップでは 20px 前後で見えるので 128px で十分。 */
    const val MAX_SIDE = 128
    const val NAME_MAX = 32
    /** 端末で読む元の画像の上限（これより大きいファイルは読まない）。 */
    const val SOURCE_MAX_BYTES = 30 * 1024 * 1024

    private val NAME_RE = Regex("^[a-z0-9_]{1,$NAME_MAX}$")

    const val DELETE_NOTE_SUFFIX = " を削除すると、この絵文字のリアクションも全部消えます"
    fun deleteTitle(name: String) = ":$name: を削除"
    fun deleteBody(name: String) = ":$name:$DELETE_NOTE_SUFFIX"

    /** 入力を名前に: 前後の空白と「:name:」の : を外し、小文字に（サーバも小文字にする）。 */
    fun normalize(raw: String): String = raw.trim().removePrefix(":").removeSuffix(":").trim().lowercase()

    /** 名前の誤り（なければ null）。`taken` は今の一覧の名前。空のときは「入れてください」。 */
    fun nameError(name: String, taken: Collection<String> = emptyList()): String? = when {
        name.isEmpty() -> "名前を入れてください"
        name.length > NAME_MAX -> "名前は $NAME_MAX 文字までです"
        !NAME_RE.matches(name) -> "使えるのは英小文字・数字・_ だけです"
        name in taken -> "その名前は既に使われています"
        else -> null
    }

    /** ファイル名から名前の候補（拡張子を外し、使えない文字は _ に）。使えるものが無ければ null。 */
    fun suggestName(fileName: String?): String? {
        val base = fileName?.substringBeforeLast('.')?.lowercase() ?: return null
        val s = base.map { if (it in 'a'..'z' || it in '0'..'9' || it == '_') it else '_' }.joinToString("")
            .replace(Regex("_+"), "_").trim('_').take(NAME_MAX).trimEnd('_')
        return s.takeIf { it.isNotEmpty() && NAME_RE.matches(it) }
    }

    enum class Output { GIF, PNG }

    /** 送る形: GIF は 256KB 以下ならそのまま（動きを残す）、それ以外は 1 枚目を PNG に縮める。 */
    fun chooseOutput(mime: String?, size: Long): Output =
        if (mime == "image/gif" && size in 1..MAX_BYTES.toLong()) Output.GIF else Output.PNG

    /** 中身の先頭から種類を当てる（ContentResolver の MIME が無い・違うときのため）。 */
    fun sniffMime(head: ByteArray, declared: String?): String? = when {
        head.size >= 4 && head[0] == 'G'.code.toByte() && head[1] == 'I'.code.toByte() && head[2] == 'F'.code.toByte() && head[3] == '8'.code.toByte() -> "image/gif"
        head.size >= 8 && head[0] == 0x89.toByte() && head[1] == 'P'.code.toByte() && head[2] == 'N'.code.toByte() && head[3] == 'G'.code.toByte() -> "image/png"
        head.size >= 3 && head[0] == 0xFF.toByte() && head[1] == 0xD8.toByte() && head[2] == 0xFF.toByte() -> "image/jpeg"
        head.size >= 12 && String(head, 0, 4, Charsets.ISO_8859_1) == "RIFF" && String(head, 8, 4, Charsets.ISO_8859_1) == "WEBP" -> "image/webp"
        else -> declared
    }

    /** 長辺を `max` 以下に（小さい画像は広げない）。 */
    fun fit(w: Int, h: Int, max: Int = MAX_SIDE): Pair<Int, Int> {
        if (w <= 0 || h <= 0) return 1 to 1
        val scale = minOf(1.0, max.toDouble() / maxOf(w, h))
        return (w * scale).toInt().coerceAtLeast(1) to (h * scale).toInt().coerceAtLeast(1)
    }

    /** サーバの答えを人の言葉に。`status` null = 通信できなかった。 */
    fun errorText(status: Int?, code: String?, serverMessage: String?, deleting: Boolean = false): String = when {
        status == null -> "通信できませんでした。もう一度試してください"
        status == 401 -> "ログインし直してください"
        status == 403 -> "この操作はアプリからだけできます。ログインし直してください"
        code == "name_taken" -> "その名前は既に使われています"
        code == "invalid_name" -> "使えるのは英小文字・数字・_ だけ、$NAME_MAX 文字までです"
        code == "too_large" -> "画像は256KBまでです"
        status == 429 -> if (deleting) "削除が多すぎます。少し待ってください" else "登録が多すぎます。少し待ってください"
        !serverMessage.isNullOrBlank() -> serverMessage
        else -> if (deleting) "削除できませんでした（$status）" else "登録できませんでした（$status）"
    }
}
