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
) {
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
    @Serializable data class Features(val chat: ChatFeatures? = null, val posts: PostFeatures? = null, val voice: VoiceFeatures? = null)
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
)

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
