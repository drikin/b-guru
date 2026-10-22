package fm.backspace.bguru.chat

import java.time.Duration
import java.time.Instant

/** The timeline's operations (段階 3) — which ones a post offers, in the web's order, and the
 *  rules and words they share with the web (docs/timeline-spec.md §4.2, §10, §11). Pure Kotlin:
 *  the screens draw what these decide (PostActionsTest). */
object PostActions {
    /** The long-press menu, in the order of the web card's top-right buttons, then the app's extras. */
    enum class Item { BOOKMARK, QUOTE, NETA, FAVORITE, REACT, PIN, CLUB, EDIT, EDIT_RELOGIN, DELETE, COPY, WEB }

    /** Shown, but not pressable: an explanation line. */
    fun isNote(item: Item) = item == Item.EDIT_RELOGIN

    /** What the long-press menu offers for `post`. Each operation shows only when the server says
     *  this token may do it (capabilities.features.posts — absent on an older server = not shown). */
    fun menu(post: Post, caps: Capabilities?, chatCanSend: Boolean, hasNetaUrls: Boolean): List<Item> = buildList {
        val stored = post.id > 0
        val root = post.parentId == null
        if (caps?.canBookmark == true && stored) add(Item.BOOKMARK)
        if (chatCanSend && stored) add(Item.QUOTE)
        if (caps?.netaEnabled == true && hasNetaUrls) add(Item.NETA)
        if (caps?.canFavorite == true && !post.isAuthor && !post.authorId.isNullOrBlank()) add(Item.FAVORITE)
        if (caps?.canReactPosts == true && stored) add(Item.REACT)
        if (caps?.canPin == true && post.isAuthor && root && stored) add(Item.PIN)
        if (canChangeClub(post, caps)) add(Item.CLUB)
        if (caps?.canEditPosts == true && post.isAuthor && stored) add(Item.EDIT)
        // A key from before 段階 3 (post scope, edit false): say how to get editing.
        else if (caps?.editNeedsRelogin == true && post.isAuthor && stored) add(Item.EDIT_RELOGIN)
        if (caps?.canDeletePosts == true && post.isAuthor && stored) add(Item.DELETE)
        if (post.text.isNotEmpty()) add(Item.COPY)
        if (stored) add(Item.WEB)
    }

    /** The menu's words (docs/timeline-spec.md §10.2). */
    fun label(item: Item, post: Post, pinned: Boolean): String = when (item) {
        Item.BOOKMARK -> if (post.bookmarkedByMe == true) "ブックマークを外す" else "ブックマーク"
        Item.QUOTE -> "チャットに引用"
        Item.NETA -> "ネタ帳に送る"
        Item.FAVORITE -> if (post.favoriteByMe == true) "お気に入りから外す" else "お気に入りに追加"
        Item.REACT -> "リアクション"
        Item.PIN -> if (pinned) "ピンを外す" else "ピン（24時間）"
        Item.CLUB -> "部活動を選択"
        Item.EDIT -> "編集"
        Item.EDIT_RELOGIN -> "編集するには一度ログインし直してください"
        Item.DELETE -> "削除"
        Item.COPY -> "テキストをコピー"
        Item.WEB -> "Web で開く"
    }

    /** A pin lasts 24 hours (the server also drops it then; this hides one that ran out on screen). */
    fun isPinned(post: Post, now: Instant = Instant.now()): Boolean {
        val at = post.pinnedAt?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return false
        return Duration.between(at, now) < Duration.ofHours(24)
    }

    /** The club label can be changed here: my own root post (an admin changing others' is web only). */
    fun canChangeClub(post: Post, caps: Capabilities?): Boolean =
        caps?.canChangeClub == true && post.isAuthor && post.parentId == null && post.id > 0

    /** 「うなる」 is offered next to 「吠える」 in a reply box (never for a root post). */
    fun canWhisper(caps: Capabilities?, parentId: Long?): Boolean = parentId != null && caps?.canWhisper == true

    // MARK: toasts (the web's words; tap = undo, 5 s)

    fun bookmarkToast(nowBookmarked: Boolean) =
        if (nowBookmarked) "ブックマークに保存しました（タップで取り消し）" else "ブックマークから外しました（タップで取り消し）"

    fun favoriteToast(name: String, nowFavorite: Boolean) =
        if (nowFavorite) "$name をお気に入りに追加しました（タップで取り消し）" else "$name をお気に入りから外しました（タップで取り消し）"

    const val TOAST_MS = 5_000L

    const val DELETE_TITLE = "投稿を削除"
    const val DELETE_BODY = "この投稿を削除しますか？この操作は取り消せません。"
    const val PINS_EMPTY = "ピンはありません。自分の投稿の右上にあるピンアイコンから、その投稿を24時間ピン留めできます。"

    /** What to show for a failed operation: the server's own words (Japanese, the web's), except
     *  rate limits and expired keys, which have their own (§10.2「エラーの文言」). */
    fun errorText(e: Throwable, fallback: String = "処理に失敗しました"): String = when (e) {
        is ApiError.Unauthorized -> "ログインが切れました。再接続してください"
        is ApiError.Http -> when {
            e.code == "rate_limited" || e.status == 429 -> "少し時間をおいてから試してください"
            e.code == "token_expired" || e.code == "unauthorized" -> "ログインが切れました。再接続してください"
            else -> e.serverMessage?.takeIf { it.isNotBlank() } ?: fallback
        }
        is ApiError.Transport -> "通信できませんでした。もう一度お試しください"
        else -> fallback
    }
}

/** Polls: the web's checks (src/lib/poll.ts) and words (PollCard in src/app/page.tsx). */
object PollRules {
    val DURATIONS = listOf(1, 6, 12, 24)
    const val MIN_OPTIONS = 3
    const val MAX_OPTIONS = 10
    const val QUESTION_MAX = 200
    const val LABEL_MAX = 100
    /** The author may change the answers within an hour of posting. */
    val EDIT_WINDOW: Duration = Duration.ofHours(1)

    /** null = OK; otherwise the web's message (validatePollInput). The question is the post's text. */
    fun validate(question: String, options: List<String>, durationHours: Int?): String? {
        val q = question.trim()
        if (q.isEmpty()) return "アンケートの質問を入力してください"
        if (q.length > QUESTION_MAX) return "質問は${QUESTION_MAX}文字以内で入力してください"
        val labels = options.map { it.trim() }.filter { it.isNotEmpty() }
        if (labels.size < MIN_OPTIONS) return "回答は${MIN_OPTIONS}個以上必要です"
        if (labels.size > MAX_OPTIONS) return "回答は最大${MAX_OPTIONS}個までです"
        if (labels.any { it.length > LABEL_MAX }) return "回答は${LABEL_MAX}文字以内で入力してください"
        if (durationHours != null && durationHours !in DURATIONS) return "締切の選択が不正です"
        return null
    }

    /** The answers as sent: trimmed, empty ones dropped. */
    fun cleaned(options: List<String>): List<String> = options.map { it.trim() }.filter { it.isNotEmpty() }

    /** One answer in the 「回答を編集」 dialog (id null = new). */
    data class EditOption(val id: Long?, val label: String, val votes: Int = 0)

    /** An answer with votes cannot be removed; and never fewer than three rows. */
    fun canRemove(options: List<EditOption>, index: Int): Boolean =
        index in options.indices && options[index].votes == 0 && options.size > MIN_OPTIONS

    fun canAdd(count: Int) = count < MAX_OPTIONS

    /** null = OK. Every voted answer must still be there (the server says the same). */
    fun validateEdit(original: PostPoll, options: List<EditOption>): String? {
        val kept = options.mapNotNull { it.id }.toSet()
        if (original.options.any { it.votes > 0 && it.id !in kept }) return "投票が付いた回答は削除できません"
        if (options.any { it.label.trim().isEmpty() && it.votes > 0 }) return "投票が付いた回答は削除できません"
        return validate(original.question.ifBlank { "?" }, options.map { it.label }, null)
    }

    fun editRows(poll: PostPoll): List<EditOption> = poll.options.map { EditOption(it.id, it.label, it.votes) }

    /** 「あとN時間M分」…「終了」 (pollTimeLeft). */
    fun timeLeft(endsAt: String, now: Instant = Instant.now()): String {
        val end = runCatching { Instant.parse(endsAt) }.getOrNull() ?: return ""
        val diff = Duration.between(now, end).toMillis()
        if (diff <= 0) return "終了"
        val m = diff / 60_000
        if (m < 60) return "あと${m}分"
        val h = m / 60
        val mm = m % 60
        val d = h / 24
        if (d > 0) return "あと${d}日${h % 24}時間"
        return if (mm > 0) "あと${h}時間${mm}分" else "あと${h}時間"
    }

    /** Closed by the server, or the deadline passed while on screen. */
    fun isClosed(poll: PostPoll, now: Instant = Instant.now()): Boolean =
        poll.closed || (runCatching { Instant.parse(poll.endsAt) }.getOrNull()?.let { now.isAfter(it) } ?: false)

    /** The state word of an answer (the web's aria-label). */
    fun optionState(poll: PostPoll, optionId: Long, closed: Boolean): String = when {
        closed -> "投票が終了しました"
        poll.myVote == optionId -> "投票済み"
        else -> "投票する"
    }

    /** Closed answers are drawn at 75 % (the web's opacity). */
    const val CLOSED_ALPHA = 0.75f

    /** The line under the answers: 「締め切りました · 全N票」 etc. */
    fun footer(poll: PostPoll, closed: Boolean): String {
        val head = when {
            closed -> "締め切りました"
            poll.totalVotes > 0 -> "${poll.totalVotes}人が投票"
            else -> "まだ投票はありません"
        }
        return "$head · 全${poll.totalVotes}票"
    }

    /** Straight after a tap (the server's answer replaces it): my one vote moves to `optionId`. */
    fun voted(poll: PostPoll, optionId: Long): PostPoll {
        if (poll.myVote == optionId) return poll
        val had = poll.myVote != null
        val opts = poll.options.map { o ->
            when (o.id) {
                optionId -> o.copy(votes = o.votes + 1)
                poll.myVote -> o.copy(votes = maxOf(0, o.votes - 1))
                else -> o
            }
        }
        val total = if (had) poll.totalVotes else poll.totalVotes + 1
        return poll.copy(myVote = optionId, totalVotes = total, voterCount = total,
            options = opts.map { it.copy(pct = if (total > 0) Math.round(it.votes * 100.0 / total).toInt() else 0) })
    }
}

/** Video and sound attachments: the web's formats and limit (src/lib/upload.ts). */
object MediaRules {
    val VIDEO_TYPES = setOf("video/mp4", "video/webm", "video/quicktime")
    /** The server's list (no audio/opus: an .opus file goes up as audio/ogg — uploadType). */
    val AUDIO_TYPES = setOf("audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav", "audio/x-wav", "audio/wave",
        "audio/ogg", "audio/webm", "audio/flac", "audio/x-flac")
    val AUDIO_EXTS = setOf("mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "webm", "flac")
    val VIDEO_EXTS = mapOf("mp4" to "video/mp4", "webm" to "video/webm", "mov" to "video/quicktime")

    fun isVideo(mime: String?) = mime != null && mime.startsWith("video/")

    /** null = OK; otherwise why not (Japanese). */
    fun checkVideo(mime: String?, name: String, bytes: Long, maxMb: Int): String? {
        val ext = name.substringAfterLast('.', "").lowercase()
        if (mime !in VIDEO_TYPES && ext !in VIDEO_EXTS) return "非対応の動画形式です（mp4・webm・mov）"
        if (bytes > maxMb * 1024L * 1024L) return "動画は${maxMb}MBまでです"
        return null
    }

    fun checkAudio(mime: String?, name: String, bytes: Long, maxMb: Int): String? {
        val ext = name.substringAfterLast('.', "").lowercase()
        if (mime !in AUDIO_TYPES && ext !in AUDIO_EXTS) return "非対応の音声形式です（mp3・m4a・aac・wav・ogg・opus・webm・flac）"
        if (bytes > maxMb * 1024L * 1024L) return "音声は${maxMb}MBまでです"
        return null
    }

    /** The type sent with the upload: the picker's, or one the server accepts from the extension. */
    fun uploadType(kind: String, mime: String?, name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        return if (kind == "video") (mime?.takeIf { it in VIDEO_TYPES } ?: VIDEO_EXTS[ext] ?: "video/mp4")
        else (mime?.takeIf { it in AUDIO_TYPES } ?: when (ext) { "mp3" -> "audio/mpeg"; "m4a" -> "audio/mp4"; "wav" -> "audio/wav"; "flac" -> "audio/flac"; "ogg", "oga", "opus" -> "audio/ogg"; else -> "audio/mpeg" })
    }

    fun sizeText(bytes: Long): String = when {
        bytes >= 1024L * 1024L -> String.format(java.util.Locale.ROOT, "%.1fMB", bytes / 1024.0 / 1024.0)
        else -> "${(bytes / 1024).coerceAtLeast(1)}KB"
    }
}

/** The reaction picker: the web's quick row and full set (src/components/ReactionBar.tsx). */
object EmojiSets {
    val QUICK = listOf("❤️", "👍", "🎉", "😂", "🙏", "🔥", "👏", "😮", "😢", "🤔", "💯", "✨")
    val ALL = listOf(
        "😀","😄","😁","😆","😅","😂","🤣","😊","😇","🙂","😉","😍","😘","😜","🤪","😝",
        "😎","🤓","🥳","😏","😌","😴","🤤","😪","😷","🤒","🤕","🤢","🤮","🥴","😵","🤯",
        "😤","😠","😡","🤬","😭","😢","😱","😨","😰","😥","😓","🫡","🤝","👍","👎","👌",
        "✌️","🤞","🙏","👏","💪","🤙","👋","🤌","🖐️","✋","🤚","👈","👉","👆","👇","🏆",
        "🔥","❤️","🧡","💛","💚","💙","💜","🖤","🤍","💔","💯","💥","✨","⭐","🌟","💫",
        "🎉","🎊","🎁","🎂","🍰","🍺","🍻","🥂","☕","🍵","🍜","🍣","🍩","🍪","🍎","🍉",
        "🚀","🤔","🥇","🗽","🎬","📷","🎧","🎮","💻","📱","⌚","💾","☁️","🌧️","☀️","🌙",
        "🌈","⚡","❄️","🚗","🚕","✈️","🏠","🌸","🐶","🐱","🦊","🐻","🐼","🐨","🐸","🐝",
        "🦄","🐙","🍀","🌍","⚽","🏀","🎯","🎲","🎳","🎹","🎸","🥁","🎨","🧸","🪙","💰",
        "💎","⏰","📌","🔔","🔒","✅","❌","⚠️","❓","❗","💬","📢","🗯️","🧦",
    )

    /** What a custom emoji sends: ":name:". */
    fun customRef(name: String) = ":$name:"
}
