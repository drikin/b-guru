package fm.backspace.bguru.chat

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNamingStrategy

/** The agent API is snake_case; unknown fields are ignored and missing optional
 *  ones default, so the web can add fields without breaking the app. */
@OptIn(ExperimentalSerializationApi::class)
val ApiJson = Json {
    namingStrategy = JsonNamingStrategy.SnakeCase
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
}

/** Mirrors `AgentChatMessageDto` in src/lib/agent-chat.ts. */
@androidx.compose.runtime.Immutable
@Serializable
data class ChatMessage(
    val id: Long,
    val authorId: String? = null,
    val authorName: String? = null,
    val avatar: String? = null,
    val body: String,
    val createdAt: String = "",
    val edited: Boolean = false,
    val editedAt: String? = null,
    val isAuthor: Boolean = false,
    val mentionsMe: Boolean = false,
    val clientId: String? = null,
    val reactions: List<Reaction>? = null,
    /** /api/media/… URLs of attached photos (always sent by new servers; empty when none). */
    val images: List<String> = emptyList(),
    /** "notice": a quiet one-line note from B-guru (who came into / left the room).
     *  "shogi": the ☗ 将棋 game card (`shogiGameId` is the game; the body reads fine as text). */
    val kind: String? = null,
    val shogiGameId: Long? = null,
    /** kind "beagle_ai": 🐶 Beagle's answer; the question it answers. */
    val replyToId: Long? = null,
) {
    val isNotice: Boolean get() = kind == "notice"
    /** The ☗ 将棋 game card (drawn as a small board when the server turns shogi on for me). */
    val isShogiCard: Boolean get() = kind == "shogi" && (shogiGameId ?: 0L) > 0L

    /** The text to show: a photo-only message carries "📷 写真" for apps that predate
     *  photos, which this app replaces with the photos themselves. */
    val visibleBody: String get() = if (images.isNotEmpty() && body == PHOTO_PLACEHOLDER) "" else body

    companion object {
        const val PHOTO_PLACEHOLDER = "📷 写真"
    }
}

@androidx.compose.runtime.Immutable
@Serializable
data class Reaction(val emoji: String, val count: Int, val mine: Boolean = false, val reactors: List<String> = emptyList())

enum class SendState { SENT, PENDING, FAILED }

/** A row in the list. `key` stays the same across the pending → stored swap
 *  (clientId when we sent it), so the bubble is never re-created on confirm.
 *  `localImages`: previews of photos this device sent, shown at once while uploading
 *  and kept after the swap so the bubble does not flash while the URLs load. */
@androidx.compose.runtime.Immutable
data class ChatRow(
    val message: ChatMessage,
    val state: SendState = SendState.SENT,
    val key: String = message.clientId ?: "id-${message.id}",
    val localImages: List<androidx.compose.ui.graphics.ImageBitmap> = emptyList(),
)

/** `lastReadId`: the member's read cursor (servers before 2026-10-19 omit it). */
@Serializable data class ChatListResponse(val unreadCount: Int = 0, val latestId: Long = 0, val lastReadId: Long? = null, val messages: List<ChatMessage> = emptyList())
@Serializable data class ChatSendResponse(val message: ChatMessage)
@Serializable data class ReactionToggleResponse(val added: Boolean = false, val reactions: List<Reaction> = emptyList())
@Serializable data class SummaryResponse(val onlineCount: Int = 0)
@Serializable data class MembersResponse(val members: List<MentionMember> = emptyList())
@Serializable data class MentionMember(val userId: String, val name: String, val avatar: String? = null)
@Serializable data class TokenIssueResponse(val token: String = "", val error: String? = null, val hint: String? = null, val code: String? = null)
@Serializable data class AndroidReleaseInfo(val available: Boolean = false, val version: String = "", val versionCode: Long = 0, val notes: String = "")
@Serializable data class ApiErrorBody(val error: String? = null, val code: String? = null)

/** GET /api/agent/capabilities. A feature the server does not report is absent. */
@Serializable
data class Capabilities(val scopes: List<String> = emptyList(), val features: Features? = null) {
    @Serializable data class Features(
        val chat: ChatFeatures? = null,
        val posts: PostFeatures? = null,
        val voice: VoiceFeatures? = null,
        val room: RoomFeatures? = null,
        val jukebox: JukeboxFeatures? = null,
        val neta: NetaFeatures? = null,
        val shogi: ShogiFeatures? = null,
        val minigame: MinigameFeatures? = null,
        val dm: DMFeatures? = null,
        val watch: WatchFeatures? = null,
        val offkai: OffkaiFeatures? = null,
        /** チャットの上に機能を重ねる形 (docs/chat-overlay-spec.md), behind CHAT_OVERLAY_ENABLED. */
        val chatOverlay: ChatOverlayFeatures? = null,
    )
    @Serializable data class ChatOverlayFeatures(val enabled: Boolean? = null)
    /** 🍻 オフ会 (docs/offkai-spec.md), behind OFFKAI_ENABLED. `control` = may start, speak, upload (chat scope). */
    @Serializable data class OffkaiFeatures(
        val enabled: Boolean? = null,
        val path: String? = null,
        val control: Boolean? = null,
    )
    /** 📺 YouTube 共同鑑賞 (src/lib/watch.ts), behind WATCH_ENABLED. `control` = may operate (chat scope). */
    @Serializable data class WatchFeatures(
        val enabled: Boolean? = null,
        val path: String? = null,
        val playerUrl: String? = null,
        val bridgeVersion: Int? = null,
        val control: Boolean? = null,
    )
    /** ✉️ 簡易 DM (1 対 1・テキストだけ・30 日で消える), behind DM_ENABLED. `send` = this token may send (chat scope). */
    @Serializable data class DMFeatures(
        val enabled: Boolean? = null,
        val path: String? = null,
        val send: Boolean? = null,
        val maxBody: Int? = null,
        val ttlHours: Int? = null,
        val rateLimitPerHour: Int? = null,
        val streamEvent: String? = null,
    )
    /** 🎮 散財ダッシュ (docs/minigame-spec.md), behind MINIGAME_ENABLED. `play` = may play (chat scope). */
    @Serializable data class MinigameFeatures(
        val enabled: Boolean? = null,
        val path: String? = null,
        val gameUrl: String? = null,
        val bridgeVersion: Int? = null,
        val engineVersion: Int? = null,
        val play: Boolean? = null,
    )
    /** ☗ 将棋 (docs/shogi-spec.md), behind SHOGI_ENABLED. `play` = this token may act (chat scope). */
    @Serializable data class ShogiFeatures(
        val enabled: Boolean? = null,
        val path: String? = null,
        val boardUrl: String? = null,
        val bridgeVersion: Int? = null,
        val play: Boolean? = null,
        /** ビーグル戦 (practice against the beagle): POST games { mode, opponent: "beagle" }. */
        val beagle: Boolean? = null,
        val timeControls: List<ShogiTimeControl> = emptyList(),
        /** ビーグルの実況 (stream `shogi_commentary`, GET games/{id} `commentary`). Absent on older servers. */
        val commentary: Boolean? = null,
    )
    @Serializable data class ShogiTimeControl(val mode: String, val label: String = "", val initialMs: Long = 0, val byoyomiMs: Long = 0)
    /** 「ネタ帳に送る」: the article a post links to → BS ネタ帳 (public site). Needs the post scope. */
    @Serializable data class NetaFeatures(val enabled: Boolean? = null, val path: String? = null, val site: String? = null)
    /** The jukebox (backspace.fm back catalogue), behind a rollout list. */
    @Serializable data class JukeboxFeatures(val enabled: Boolean? = null, val path: String? = null)
    /** The club room (ルーム): 8-bit room view + proximity voice, behind a rollout flag. */
    @Serializable data class RoomFeatures(val enabled: Boolean? = null, val path: String? = null)
    @Serializable data class VoiceFeatures(
        val enabled: Boolean? = null,
        val join: Boolean? = null,
        val admin: Boolean? = null,
        val maxParticipants: Int? = null,
        val maxSpeakers: Int? = null,
    )
    @Serializable data class PostFeatures(
        val read: Boolean? = null,
        val publish: Boolean? = null,
        val upload: Boolean? = null,
        val reactions: Boolean? = null,
        val markRead: Boolean? = null,
        val maxImages: Int? = null,
        // 段階 3「操作」(docs/timeline-spec.md §10–§11). Absent on older servers = not offered.
        val edit: Boolean? = null,
        val delete: Boolean? = null,
        val editTextOnly: Boolean? = null,
        val whisper: Boolean? = null,
        val video: Boolean? = null,
        val audio: Boolean? = null,
        val maxMediaMb: Int? = null,
        val poll: Boolean? = null,
        val pollVote: Boolean? = null,
        val pollEdit: Boolean? = null,
        val pin: Boolean? = null,
        val pinnedList: Boolean? = null,
        val bookmarks: Boolean? = null,
        /** POST /api/agent/bookmarks takes `{ post_id, bookmarked }` (set, not toggle). */
        val bookmarksSet: Boolean? = null,
        val favorites: Boolean? = null,
        val customEmojiList: String? = null,
        /** カスタム絵文字の登録（POST multipart: name・image）と削除（DELETE …/{id}）。誰でも（オーナー 2026-10-27）、アプリの鍵だけ。 */
        val customEmojiRegister: String? = null,
        val customEmojiDelete: String? = null,
        val clubSelect: Boolean? = null,
        val clubChange: Boolean? = null,
        /** 部活の表示・非表示（GET で隠している部活、PUT { club, hidden }）。無い（古いサーバ）なら出さない。 */
        val clubVisibility: String? = null,
        /** NG ワード（GET で一覧、PUT { words } で置き換え）。無い（古いサーバ）なら出さない。 */
        val mutedWords: String? = null,
        val mentions: String? = null,
    )
    @Serializable data class ChatFeatures(
        val read: Boolean? = null,
        val send: Boolean? = null,
        val editOwn: Boolean? = null,
        val reactions: Boolean? = null,
        val markRead: Boolean? = null,
        val maxBody: Int? = null,
        val images: Boolean? = null,
        val imageUpload: String? = null,
        val maxImages: Int? = null,
        val imageMaxSide: Int? = null,
        /** 🐶 the server's Beagle (さくらの AI Engine) answers @ビーグル: POST beagle/ask. */
        val beagleServer: Boolean? = null,
    )
    val canAskBeagle get() = features?.chat?.beagleServer ?: false
    val canSend get() = features?.chat?.send ?: false
    val canEdit get() = features?.chat?.editOwn ?: false
    val canReact get() = features?.chat?.reactions ?: false
    val canMarkRead get() = features?.chat?.markRead ?: false
    val maxBody get() = features?.chat?.maxBody ?: 1000
    /** Photos in chat: hidden until the server says it accepts them. */
    val canSendImages get() = canSend && (features?.chat?.images ?: false)
    val maxChatImages get() = features?.chat?.maxImages?.takeIf { it > 0 } ?: 4
    val chatImageMaxSide get() = features?.chat?.imageMaxSide?.takeIf { it > 0 } ?: 1280
    /** Only paths on our own server: the upload carries the token. */
    val chatImageUpload get() = features?.chat?.imageUpload?.takeIf { it.startsWith("/api/") } ?: "/api/agent/chat/upload"
    val hasTimeline get() = features?.posts?.read ?: false
    /** Posting needs the "post" scope — tokens from before the timeline must reconnect once. */
    val canPublish get() = features?.posts?.publish ?: false
    val canReactPosts get() = features?.posts?.reactions ?: false
    val maxImages get() = features?.posts?.maxImages ?: 5
    private val p get() = features?.posts
    /** Edit own posts: the whole post (app keys), or only the text (`edit_text_only`, write keys). */
    val canEditPosts get() = (p?.edit ?: false) || (p?.editTextOnly ?: false)
    val editTextOnly get() = !(p?.edit ?: false) && (p?.editTextOnly ?: false)
    val canDeletePosts get() = p?.delete ?: false
    /** A post key from before 段階 3 (the server says edit false): signing in again gives editing. */
    val editNeedsRelogin get() = canPublish && p?.edit == false && p?.editTextOnly != true
    /** The idempotent bookmark (else the toggle). */
    val bookmarksSet get() = p?.bookmarksSet ?: false
    /** 「うなる」: a reply that does not lift the thread. */
    val canWhisper get() = p?.whisper ?: false
    val canPostVideo get() = p?.video ?: false
    val canPostAudio get() = p?.audio ?: false
    val maxMediaMb get() = p?.maxMediaMb?.takeIf { it > 0 } ?: 100
    val canCreatePoll get() = p?.poll ?: false
    val canVote get() = p?.pollVote ?: false
    val canEditPoll get() = p?.pollEdit ?: false
    val canPin get() = p?.pin ?: false
    val canListPinned get() = p?.pinnedList ?: false
    val canBookmark get() = p?.bookmarks ?: false
    val canFavorite get() = p?.favorites ?: false
    /** Only paths on our own server (the request carries the token). */
    val customEmojiPath get() = p?.customEmojiList?.takeIf { it.startsWith("/api/") }
    /** ピッカーの「＋ 登録」: サーバが言うときだけ（自分のサーバのパスだけ）。 */
    val customEmojiRegisterPath get() = p?.customEmojiRegister?.takeIf { it.startsWith("/api/") }
    /** 長押しの「:name: を削除」: `{id}` を置き換えて DELETE。 */
    val customEmojiDeletePath get() = p?.customEmojiDelete?.takeIf { it.startsWith("/api/") && it.contains("{id}") }
    val canSelectClub get() = p?.clubSelect ?: false
    val canChangeClub get() = p?.clubChange ?: false
    val clubVisibilityPath get() = p?.clubVisibility?.takeIf { it.startsWith("/api/") }
    val mutedWordsPath get() = p?.mutedWords?.takeIf { it.startsWith("/api/") }
    val mentionsPath get() = p?.mentions?.takeIf { it.startsWith("/api/") }
    /** Voice room is on for this member (server configured + in the rollout). */
    val voiceEnabled get() = features?.voice?.enabled ?: false
    /** This token may join (has the "voice" scope — older tokens must sign in again). */
    val canJoinVoice get() = features?.voice?.join ?: false
    val isVoiceAdmin get() = features?.voice?.admin ?: false
    val voiceMaxSpeakers get() = features?.voice?.maxSpeakers ?: 10
    /** The club room is on for this member. */
    val roomEnabled get() = features?.room?.enabled ?: false
    /** Only paths on our own server (the request carries the token). */
    val roomPath get() = features?.room?.path?.takeIf { it.startsWith("/api/") } ?: "/api/agent/room"
    /** The jukebox tab is on for this member. */
    val jukeboxEnabled get() = features?.jukebox?.enabled ?: false
    /** Only paths on our own server (the request carries the token). */
    val jukeboxPath get() = features?.jukebox?.path?.takeIf { it.startsWith("/api/") } ?: "/api/agent/jukebox"
    /** ☗ 将棋 is on for this member (and the board speaks a bridge this app knows). */
    val shogiEnabled get() = features?.shogi?.enabled == true && (features?.shogi?.bridgeVersion ?: 1) == 1
    /** May start, accept and play (the chat scope); otherwise watch only. */
    val canPlayShogi get() = shogiEnabled && (features?.shogi?.play ?: false)
    /** 📺 is on for this member (and the player page speaks a bridge this app knows). */
    val watchEnabled get() = features?.watch?.enabled == true && (features?.watch?.bridgeVersion ?: 1) == 1
    val canControlWatch get() = watchEnabled && (features?.watch?.control ?: false)
    val watchPath get() = features?.watch?.path?.takeIf { it.startsWith("/api/") }?.trimEnd('/') ?: "/api/agent/watch"
    /** The player page (no token): only under /watch/ on our own server. */
    val watchPlayerUrl get() = features?.watch?.playerUrl?.takeIf { it.startsWith("/watch/") && !it.contains("..") } ?: "/watch/index.html"
    /** The chat's second row is switches and the features sit over the chat (false: the old row as before). */
    val chatOverlayEnabled get() = features?.chatOverlay?.enabled ?: false
    /** 🍻 オフ会 is on for this member. */
    val offkaiEnabled get() = features?.offkai?.enabled ?: false
    /** May start, speak, upload and end (the chat scope); otherwise look and listen only. */
    val canControlOffkai get() = offkaiEnabled && (features?.offkai?.control ?: false)
    /** Only paths on our own server (the request carries the token). */
    val offkaiPath get() = features?.offkai?.path?.takeIf { it.startsWith("/api/") }?.trimEnd('/') ?: "/api/agent/offkai"
    /** 🎮 is on for this member (and the game speaks a bridge this app knows). */
    val minigameEnabled get() = features?.minigame?.enabled == true && (features?.minigame?.bridgeVersion ?: 1) == 1
    val canPlayMinigame get() = minigameEnabled && (features?.minigame?.play ?: false)
    /** Only paths on our own server (the request carries the token). */
    val minigamePath get() = features?.minigame?.path?.takeIf { it.startsWith("/api/") }?.trimEnd('/') ?: "/api/agent/minigame"
    /** The game page (no token, no cookies): only under /minigame/ on our own server. */
    val minigameGameUrl get() = features?.minigame?.gameUrl?.takeIf { it.startsWith("/minigame/") && !it.contains("..") } ?: "/minigame/index.html"
    /** 🐶 ビーグルと対局 (practice) is offered. */
    val shogiBeagle get() = canPlayShogi && (features?.shogi?.beagle ?: false)
    /** ビーグルの実況 is on for this member (older servers: absent = off; the app still shows any that arrive). */
    val shogiCommentary get() = shogiEnabled && (features?.shogi?.commentary ?: false)
    /** Only paths on our own server (the request carries the token). */
    val shogiPath get() = features?.shogi?.path?.takeIf { it.startsWith("/api/") }?.trimEnd('/') ?: "/api/agent/shogi"
    /** The board page (no token, no cookies): only under /shogi-board/ on our own server. */
    val shogiBoardUrl get() = features?.shogi?.boardUrl?.takeIf { it.startsWith("/shogi-board/") && !it.contains("..") } ?: "/shogi-board/index.html"
    /** ✉️ DM is on for this member (absent or enabled false: nothing DM is shown). */
    val dmEnabled get() = features?.dm?.enabled ?: false
    val canSendDM get() = dmEnabled && (features?.dm?.send ?: false)
    val dmMaxBody get() = features?.dm?.maxBody?.takeIf { it > 0 } ?: 1000
    val dmTtlHours get() = features?.dm?.ttlHours?.takeIf { it > 0 } ?: (30 * 24)
    /** Only paths on our own server (the request carries the token). */
    val dmPath get() = features?.dm?.path?.takeIf { it.startsWith("/api/") }?.trimEnd('/') ?: "/api/agent/dm"
    /** 「ネタ帳に送る」 is on for this token. */
    val netaEnabled get() = features?.neta?.enabled ?: false
    /** Only paths on our own server (the request carries the token). */
    val netaPath get() = features?.neta?.path?.takeIf { it.startsWith("/api/") } ?: "/api/agent/neta"
    /** Only http(s): it is opened in the browser. */
    val netaSite get() = features?.neta?.site?.takeIf { it.startsWith("https://") || it.startsWith("http://") } ?: "https://neta.backspace.fm"
}

/** POST /api/agent/neta reply (201 / 409 / 4xx / 5xx all share this shape). */
@Serializable
data class NetaResponse(
    val ok: Boolean? = null,
    /** Not read by the app (ApiJson's snake_case naming looks for topic_id). */
    val topicId: kotlinx.serialization.json.JsonElement? = null,
    val site: String? = null,
    val code: String? = null,
    val error: String? = null,
    val existing: NetaExisting? = null,
) {
    @Serializable data class NetaExisting(val title: String? = null, val submitter: String? = null)
}

// MARK: voice room

/** Who is in the voice room, as the server sees it (GET /api/agent/voice and the
 *  stream's `voice` event). Shown to people who have not joined. */
@Serializable
data class VoiceRoomInfo(
    val active: Boolean = false,
    val openedBy: String? = null,
    val startedAt: String? = null,
    val participants: List<Member> = emptyList(),
) {
    @Serializable data class Member(val userId: String, val name: String? = null, val avatar: String? = null)
}

@Serializable data class VoiceStateResponse(val enabled: Boolean = false, val room: VoiceRoomInfo? = null)
@Serializable data class VoiceTokenResponse(val url: String, val token: String, val room: String = "", val identity: String = "")
@Serializable data class VoiceMuteResponse(val ok: Boolean = false, val muted: Boolean? = null)

// MARK: club room (ルーム) — docs/room-client-spec.md

@Serializable data class RoomPoint(val x: Int, val y: Int)
@Serializable data class RoomZone(val kind: String, val name: String, val x: Int, val y: Int, val w: Int, val h: Int) {
    fun contains(px: Int, py: Int) = px >= x && px < x + w && py >= y && py < y + h
}
@Serializable data class RoomLabel(val name: String, val x: Int, val y: Int)

/** The map (src/lib/room-map.ts roomMapDto). Tiles: one character per tile, h rows of w. */
@Serializable
data class RoomMap(
    val w: Int = 32,
    val h: Int = 20,
    val tiles: List<String> = emptyList(),
    val zones: List<RoomZone> = emptyList(),
    val door: RoomPoint = RoomPoint(15, 18),
    val seats: List<RoomPoint> = emptyList(),
    val labels: List<RoomLabel> = emptyList(),
    val hearRadius: Int = 4,
)

/** Someone in the house: in the room view (mode "room") or at a chat seat ("text"). */
@androidx.compose.runtime.Immutable
@Serializable
data class RoomMember(
    val userId: String,
    val name: String = "",
    val avatar: String? = null,
    val x: Int = 0,
    val y: Int = 0,
    val mode: String = "text",
    val listening: Boolean = false,
    val mic: Boolean = false,
    val away: Boolean = false,
) {
    val inRoom get() = mode == "room"
}

@Serializable
data class RoomStateResponse(
    val map: RoomMap = RoomMap(),
    val members: List<RoomMember> = emptyList(),
    val me: String = "",
    val reactions: List<String> = emptyList(),
)

@Serializable data class RoomActionResponse(val ok: Boolean = false, val member: RoomMember? = null, val from: RoomPoint? = null, val to: RoomPoint? = null)

/** The stream's `room` event: join / update / leave carry `member`; react carries user_id, emoji, to. */
@Serializable data class RoomEventData(val action: String, val member: RoomMember? = null, val userId: String? = null, val emoji: String? = null, val to: String? = null)

// MARK: timeline

/** Mirrors `agentPostDto` (+ include=reactions,read) in src/app/api/agent/posts/route.ts. */
@androidx.compose.runtime.Immutable
@Serializable
data class Post(
    val id: Long,
    val authorId: String? = null,
    val authorName: String? = null,
    val authorAvatar: String? = null,
    val isAuthor: Boolean = false,
    val parentId: Long? = null,
    val replyCount: Int = 0,
    val text: String = "",
    val images: List<String> = emptyList(),
    val videoUrl: String? = null,
    val audioUrl: String? = null,
    val createdAt: String = "",
    val lastActivityAt: String? = null,
    val club: String? = null,
    /** The club was chosen by hand (not by the AI). */
    val clubManual: Boolean? = null,
    /** Set while the author's pin lasts (24 hours). */
    val pinnedAt: String? = null,
    /** A poll (the text is its question). */
    val poll: PostPoll? = null,
    /** This member saved the post (🔖) / follows its author (☆). Absent on older servers. */
    val bookmarkedByMe: Boolean? = null,
    val favoriteByMe: Boolean? = null,
    val reactions: List<Reaction>? = null,
    val unread: Boolean? = null,
    /** Root posts: replies by others this member has not read yet. */
    val unreadReplies: Int? = null,
    /** The page a link in the post points to (title / image), filled in by the server. */
    val urlPreview: UrlPreview? = null,
    /** The server's display decisions (`include=display`, TimelineDisplay.kt); null = decide here. */
    @Serializable(with = SafePostDisplay::class) val display: PostDisplay? = null,
) {
    /** The post is just one link that has a preview: show the card, not the bare URL. */
    val isBareLink: Boolean
        get() {
            if (urlPreview == null) return false
            val t = text.trim()
            return t.isNotEmpty() && t.none { it.isWhitespace() } && (t.startsWith("http://") || t.startsWith("https://"))
        }
}

/** Link preview (posts.url_preview — the same object the web uses, camelCase inside). */
@androidx.compose.runtime.Immutable
@Serializable
data class UrlPreview(
    val url: String,
    val title: String? = null,
    val description: String? = null,
    val image: String? = null,
    @kotlinx.serialization.json.JsonNames("siteName") val siteName: String? = null,
    /** YouTube video id: a play mark over the image. */
    @kotlinx.serialization.json.JsonNames("videoId") val videoId: String? = null,
    /** A Spotify link: the web embeds its player (the app shows the card — owner 2026-10-22). */
    @kotlinx.serialization.SerialName("spotify") val spotify: SpotifyEmbed? = null,
) {
    /** The preview image through our server (/api/img): the site never sees the member. */
    val proxiedImage: String?
        get() = image?.let { if (it.startsWith("http")) "${Net.BASE}/api/img?u=" + java.net.URLEncoder.encode(it, "UTF-8") else it }
}

/** posts.poll — the web's PostPoll (src/lib/poll.ts), camelCase inside like url_preview. */
@androidx.compose.runtime.Immutable
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class PostPoll(
    val question: String = "",
    @kotlinx.serialization.json.JsonNames("endsAt") val endsAt: String = "",
    val closed: Boolean = false,
    /** I am the author and it is within an hour of posting: 「回答を編集」. */
    val editable: Boolean = false,
    @kotlinx.serialization.json.JsonNames("totalVotes") val totalVotes: Int = 0,
    @kotlinx.serialization.json.JsonNames("voterCount") val voterCount: Int = 0,
    @kotlinx.serialization.json.JsonNames("myVote") val myVote: Long? = null,
    val options: List<Option> = emptyList(),
) {
    @androidx.compose.runtime.Immutable
    @Serializable data class Option(val id: Long, val label: String = "", val votes: Int = 0, val pct: Int = 0)
}

@Serializable data class PollResponse(val ok: Boolean = false, val poll: PostPoll? = null)
/** 「投票した人」: one answer and who chose it (GET …/poll/voters, the poll's author only). */
@Serializable data class PollVoterGroup(val id: Long, val label: String = "", val voters: List<Voter> = emptyList()) {
    @Serializable data class Voter(val userId: String = "", val name: String? = null, val avatar: String? = null)
}
@Serializable data class PollVotersResponse(val ok: Boolean = false, val options: List<PollVoterGroup> = emptyList())
@Serializable data class PinResponse(val ok: Boolean = false, val pinned: Boolean = false)
@Serializable data class ClubChangeResponse(val ok: Boolean = false, val club: String? = null)
@Serializable data class BookmarkResponse(val bookmarked: Boolean = false)
@Serializable data class FavoriteResponse(val favorited: Boolean = false)
@Serializable data class MediaUploadResponse(val videoUrl: String? = null, val audioUrl: String? = null)
@Serializable data class CustomEmoji(val id: Long = 0, val name: String, val imageUrl: String)
@Serializable data class EmojisResponse(val emojis: List<CustomEmoji> = emptyList())
@Serializable data class EmojiRegisterResponse(val emoji: CustomEmoji)

@Serializable data class PostListResponse(val posts: List<Post> = emptyList(), val nextCursor: String? = null)
@Serializable data class ThreadResponse(val post: Post, val replies: List<Post> = emptyList())
@Serializable data class PublishResponse(val post: Post)
@Serializable data class UploadResponse(val urls: List<String> = emptyList())
@Serializable data class ClubInfo(val key: String, val name: String)
@Serializable data class HiddenClubsResponse(val hidden: List<String> = emptyList())
@Serializable data class ClubHiddenResponse(val club: String = "", val hidden: Boolean = false)
@Serializable data class MutedWordsResponse(val words: List<String> = emptyList(), val max: Int = 50, val maxLength: Int = 40)
@Serializable data class ClubsResponse(val clubs: List<ClubInfo> = emptyList())
/** POST /api/agent/reactions answers without `mine`; the app fills it in. */
@Serializable data class PostReactionToggle(val added: Boolean = false, val reactions: List<Count> = emptyList()) {
    @Serializable data class Count(val emoji: String, val count: Int)
}

// MARK: jukebox — docs/jukebox-client-spec.md

/** One episode of backspace.fm (GET /api/agent/jukebox). `audioUrl` is used exactly as
 *  given: the redirects through it are how the show counts downloads. */
@androidx.compose.runtime.Immutable
@Serializable
data class JukeboxEpisode(
    val id: String,
    val title: String = "",
    val publishedAt: String = "",
    val audioUrl: String = "",
    val durationSec: Int? = null,
    val series: String = "本編",
    val number: Int? = null,
    val summary: String = "",
    val webUrl: String? = null,
)

/** "N 年前の今日" (posted to the timeline at 7:00 JST; post_id is null before that). */
@Serializable data class JukeboxToday(val id: String, val yearsAgo: Int = 0, val postId: Long? = null)
@Serializable data class JukeboxResponse(val apiVersion: Int = 1, val episodes: List<JukeboxEpisode> = emptyList(), val today: JukeboxToday? = null)

// MARK: ☗ 将棋 — docs/shogi-spec.md (ShogiGameDto in src/lib/shogi-types.ts)

@Serializable data class ShogiPlayer(val userId: String = "", val name: String = "", val avatar: String? = null)
@Serializable data class ShogiLastMove(val usi: String = "", val label: String = "")
/** The clock when the turn started (blitz only; slow games have none). */
@Serializable data class ShogiClocks(val blackMs: Long = 0, val whiteMs: Long = 0, val byoyomiMs: Long = 0, val initialMs: Long = 0)
@Serializable data class ShogiMove(val ply: Int = 0, val usi: String = "", val label: String = "", val sfen: String = "", val spentMs: Long = 0, val at: String = "")

/** One game. `moves`, `kifUrl`, `myColor` come only with GET games/{id}. */
@androidx.compose.runtime.Immutable
@Serializable
data class ShogiGame(
    val id: Long,
    val status: String = "open",
    val mode: String = "blitz",
    val creator: ShogiPlayer = ShogiPlayer(),
    val invitee: ShogiPlayer? = null,
    val black: ShogiPlayer? = null,
    val white: ShogiPlayer? = null,
    val sfen: String = ShogiLogic.INITIAL_SFEN,
    val ply: Int = 0,
    val turn: String = "black",
    val lastMove: ShogiLastMove? = null,
    val clocks: ShogiClocks? = null,
    val turnStartedAt: String? = null,
    val deadlineAt: String? = null,
    val serverNow: String = "",
    val spectators: Int = 0,
    val result: String? = null,
    val endReason: String? = null,
    val createdAt: String = "",
    val startedAt: String? = null,
    val endedAt: String? = null,
    val rematchOf: Long? = null,
    val cardMessageId: Long? = null,
    val resultPostId: Long? = null,
    val moves: List<ShogiMove>? = null,
    val kifUrl: String? = null,
    val myColor: String? = null,
    /** GET games/{id} only, for members with ビーグルの実況: the newest one (null = none yet). */
    val commentary: ShogiCommentary? = null,
    /** GET games/{id} of an ended game: one per move that has one. */
    val commentaries: List<ShogiCommentary>? = null,
) {
    val isActive get() = status == "active"
    val isEnded get() = status == "ended" || status == "closed"
}

/** `self_play`: this member may accept their own open game (a test game against oneself). */
@Serializable data class ShogiMe(val userId: String? = null, val selfPlay: Boolean? = null)
/** Every shogi reply: `{ game }`, the list `{ me, games }`, watch `{ spectators }`, or an error `{ error, code, game? }`. */
@Serializable data class ShogiReply(
    val game: ShogiGame? = null,
    val games: List<ShogiGame>? = null,
    val me: ShogiMe? = null,
    val duplicate: Boolean? = null,
    val spectators: Int? = null,
    val error: String? = null,
    val code: String? = null,
)
/** The stream's `event: shogi` (apps get `{ action, game }`). */
@Serializable data class ShogiEvent(val action: String = "state", val game: ShogiGame? = null)

/** ビーグルの実況, one move (ShogiCommentaryDto in src/lib/shogi-types.ts). The same move comes again
 *  when the AI's text replaces the template's (`source` template → ai): the later one wins. */
@androidx.compose.runtime.Immutable
@Serializable data class ShogiCommentary(
    val gameId: Long = 0,
    val ply: Int = 0,
    val moveLabel: String = "",
    val text: String? = null,
    /** From ☗'s side (歩 = 100; a mate line ±9999); null when it could not be read. */
    val evalCp: Double? = null,
    val mate: String? = null,
    val best: ShogiLastMove? = null,
    val source: String = "template",
    val highlight: String? = null,
    val at: String = "",
)
/** The stream's `event: shogi_commentary` (apps get `{ game_id, commentary }`). */
@Serializable data class ShogiCommentaryEvent(val gameId: Long = 0, val commentary: ShogiCommentary? = null)

// MARK: 🍻 オフ会 (src/lib/offkai.ts — EventDto / PhotoDto)

@Serializable data class OffkaiPerson(val userId: String = "", val name: String? = null, val avatar: String? = null)
/** The one who speaks now; `connected` = in the room right now (only then 「◯◯が話しています」). */
@Serializable data class OffkaiSpeaker(val userId: String = "", val name: String? = null, val avatar: String? = null, val connected: Boolean = false)

@androidx.compose.runtime.Immutable
@Serializable
data class OffkaiEvent(
    val id: Long,
    val version: Int = 0,
    val title: String = "",
    val startedBy: OffkaiPerson = OffkaiPerson(),
    val startedAt: String = "",
    val endsAt: String = "",
    val endedAt: String? = null,
    val speaker: OffkaiSpeaker? = null,
    val photoCount: Int = 0,
    val cover: String? = null,
    /** For the viewer who asked (GET); always false on the stream. */
    val canEnd: Boolean = false,
)

@androidx.compose.runtime.Immutable
@Serializable
data class OffkaiPhoto(
    val id: Long,
    val url: String = "",
    val uploader: OffkaiPerson = OffkaiPerson(),
    val caption: String = "",
    val createdAt: String = "",
    /** For the viewer who asked (GET / my upload); always false on the stream. */
    val mine: Boolean = false,
)

@Serializable data class OffkaiCan(val start: Boolean = false, val speak: Boolean = false, val upload: Boolean = false)
/** GET /offkai: `{ enabled, can, current, listeners, archive }` (archive newest first, 20 a page). */
@Serializable data class OffkaiState(
    val enabled: Boolean = false,
    val can: OffkaiCan? = null,
    val current: OffkaiEvent? = null,
    val listeners: Int = 0,
    val archive: List<OffkaiEvent> = emptyList(),
)
@Serializable data class OffkaiEventReply(val event: OffkaiEvent? = null)
/** POST token / speak: the key to the room (speak also carries the event). */
@Serializable data class OffkaiTokenReply(val event: OffkaiEvent? = null, val token: String = "", val url: String = "", val room: String = "", val canSpeak: Boolean = false)
/** `can_download`: this viewer may 「⬇ まとめて保存」 (took part in that event, or an admin). */
@Serializable data class OffkaiPhotosReply(val photos: List<OffkaiPhoto> = emptyList(), val nextAfter: Long? = null, val canDownload: Boolean = false)
/** The stream's `event: offkai`. */
@Serializable data class OffkaiStreamData(
    val action: String = "",
    val event: OffkaiEvent? = null,
    val eventId: Long? = null,
    val photo: OffkaiPhoto? = null,
    val photoId: Long? = null,
    val listeners: Int? = null,
)
