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
    /** "notice": a quiet one-line note from B-guru (who came into / left the room). */
    val kind: String? = null,
) {
    val isNotice: Boolean get() = kind == "notice"

    /** The text to show: a photo-only message carries "📷 写真" for apps that predate
     *  photos, which this app replaces with the photos themselves. */
    val visibleBody: String get() = if (images.isNotEmpty() && body == PHOTO_PLACEHOLDER) "" else body

    companion object {
        const val PHOTO_PLACEHOLDER = "📷 写真"
    }
}

@Serializable
data class Reaction(val emoji: String, val count: Int, val mine: Boolean = false, val reactors: List<String> = emptyList())

enum class SendState { SENT, PENDING, FAILED }

/** A row in the list. `key` stays the same across the pending → stored swap
 *  (clientId when we sent it), so the bubble is never re-created on confirm.
 *  `localImages`: previews of photos this device sent, shown at once while uploading
 *  and kept after the swap so the bubble does not flash while the URLs load. */
data class ChatRow(
    val message: ChatMessage,
    val state: SendState = SendState.SENT,
    val key: String = message.clientId ?: "id-${message.id}",
    val localImages: List<androidx.compose.ui.graphics.ImageBitmap> = emptyList(),
)

@Serializable data class ChatListResponse(val unreadCount: Int = 0, val latestId: Long = 0, val messages: List<ChatMessage> = emptyList())
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
    )
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
    )
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
    val reactions: List<Reaction>? = null,
    val unread: Boolean? = null,
    /** Root posts: replies by others this member has not read yet. */
    val unreadReplies: Int? = null,
    /** The page a link in the post points to (title / image), filled in by the server. */
    val urlPreview: UrlPreview? = null,
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
@Serializable
data class UrlPreview(
    val url: String,
    val title: String? = null,
    val description: String? = null,
    val image: String? = null,
    @kotlinx.serialization.SerialName("siteName") val siteName: String? = null,
    /** YouTube video id: a play mark over the image. */
    @kotlinx.serialization.SerialName("videoId") val videoId: String? = null,
) {
    /** The preview image through our server (/api/img): the site never sees the member. */
    val proxiedImage: String?
        get() = image?.let { if (it.startsWith("http")) "${Net.BASE}/api/img?u=" + java.net.URLEncoder.encode(it, "UTF-8") else it }
}

@Serializable data class PostListResponse(val posts: List<Post> = emptyList(), val nextCursor: String? = null)
@Serializable data class ThreadResponse(val post: Post, val replies: List<Post> = emptyList())
@Serializable data class PublishResponse(val post: Post)
@Serializable data class UploadResponse(val urls: List<String> = emptyList())
@Serializable data class ClubInfo(val key: String, val name: String)
@Serializable data class ClubsResponse(val clubs: List<ClubInfo> = emptyList())
/** POST /api/agent/reactions answers without `mine`; the app fills it in. */
@Serializable data class PostReactionToggle(val added: Boolean = false, val reactions: List<Count> = emptyList()) {
    @Serializable data class Count(val emoji: String, val count: Int)
}
