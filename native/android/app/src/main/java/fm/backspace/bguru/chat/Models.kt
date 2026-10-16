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
)

@Serializable
data class Reaction(val emoji: String, val count: Int, val mine: Boolean = false, val reactors: List<String> = emptyList())

enum class SendState { SENT, PENDING, FAILED }

/** A row in the list. `key` stays the same across the pending → stored swap
 *  (clientId when we sent it), so the bubble is never re-created on confirm. */
data class ChatRow(
    val message: ChatMessage,
    val state: SendState = SendState.SENT,
    val key: String = message.clientId ?: "id-${message.id}",
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
    @Serializable data class Features(val chat: ChatFeatures? = null)
    @Serializable data class ChatFeatures(
        val read: Boolean? = null,
        val send: Boolean? = null,
        val editOwn: Boolean? = null,
        val reactions: Boolean? = null,
        val markRead: Boolean? = null,
        val maxBody: Int? = null,
    )
    val canSend get() = features?.chat?.send ?: false
    val canEdit get() = features?.chat?.editOwn ?: false
    val canReact get() = features?.chat?.reactions ?: false
    val canMarkRead get() = features?.chat?.markRead ?: false
    val maxBody get() = features?.chat?.maxBody ?: 1000
}
