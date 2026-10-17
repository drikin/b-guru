package fm.backspace.bguru.chat

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

sealed class ApiError(message: String) : Exception(message) {
    class Unauthorized(val code: String?) : ApiError("unauthorized")
    class Http(val status: Int, val code: String?, val serverMessage: String?) : ApiError("http $status")
    class Transport(cause: String) : ApiError(cause)

    /** Retrying will not help — give the text back instead of offering 再送. */
    val isPermanent: Boolean
        get() = when (this) {
            is Unauthorized -> true
            is Http -> status in 400..499 && status != 408 && status != 429
            is Transport -> false
        }
}

object Net {
    const val BASE = "https://bsm.backspace.fm"
    val USER_AGENT = "BguruChatAndroid/${BuildConfig.VERSION_NAME}"

    /** One shared client: requests ride a warm HTTP/2 connection — the biggest
     *  factor in how fast a send feels. */
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .callTimeout(20, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            chain.proceed(chain.request().newBuilder().header("User-Agent", USER_AGENT).build())
        }
        .build()

    /** The live stream: the server sends a comment every 25 s, so 70 s of
     *  silence means the connection is dead. */
    val stream: OkHttpClient = http.newBuilder()
        .readTimeout(70, TimeUnit.SECONDS)
        .callTimeout(0, TimeUnit.SECONDS)
        .build()
}

suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = cont.resume(response) { _, _, _ -> response.close() }
        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(ApiError.Transport(e.message ?: "network"))
        }
    })
    cont.invokeOnCancellation { cancel() }
}

private val JSON_TYPE = "application/json".toMediaType()

/** The agent API (/api/agent/...) with this device's Bearer token. */
class ApiClient(val token: String) {

    private fun request(method: String, path: String, json: JsonObject? = null, query: Map<String, String> = emptyMap()): Request {
        val url = (Net.BASE + path).toHttpUrl().newBuilder().apply { query.forEach { (k, v) -> addQueryParameter(k, v) } }.build()
        val body = json?.toString()?.toRequestBody(JSON_TYPE)
        return Request.Builder().url(url).header("Authorization", "Bearer $token").method(method, body).build()
    }

    private suspend fun send(req: Request): String {
        Net.http.newCall(req).await().use { resp ->
            val text = resp.body.string()
            if (!resp.isSuccessful) {
                val err = runCatching { ApiJson.decodeFromString<ApiErrorBody>(text) }.getOrNull()
                if (resp.code == 401) throw ApiError.Unauthorized(err?.code)
                throw ApiError.Http(resp.code, err?.code, err?.error)
            }
            return text
        }
    }

    private suspend inline fun <reified T> get(path: String, query: Map<String, String> = emptyMap()): T =
        decode(send(request("GET", path, query = query)))

    private inline fun <reified T> decode(text: String): T =
        try { ApiJson.decodeFromString<T>(text) } catch (e: Exception) { throw ApiError.Transport("decode: ${e.message}") }

    suspend fun capabilities(): Capabilities = get("/api/agent/capabilities")
    suspend fun chat(limit: Int = 100): ChatListResponse = get("/api/agent/chat", mapOf("limit" to "$limit", "include" to "reactions"))
    suspend fun summary(): SummaryResponse = get("/api/agent/summary")
    suspend fun members(): List<MentionMember> = get<MembersResponse>("/api/agent/members").members
    suspend fun chatMessage(id: Long): ChatMessage = get<ChatSendResponse>("/api/agent/chat/$id").message

    suspend fun post(body: String, clientId: String): ChatMessage =
        decode<ChatSendResponse>(send(request("POST", "/api/agent/chat", buildJsonObject { put("body", body); put("client_id", clientId) }))).message

    suspend fun edit(id: Long, body: String): ChatMessage =
        decode<ChatSendResponse>(send(request("PATCH", "/api/agent/chat/$id", buildJsonObject { put("body", body) }))).message

    suspend fun toggleReaction(id: Long, emoji: String): ReactionToggleResponse =
        decode(send(request("POST", "/api/agent/chat/$id/reactions", buildJsonObject { put("emoji", emoji) })))

    suspend fun markRead(upTo: Long) {
        send(request("POST", "/api/agent/chat/read", buildJsonObject { put("last_read_id", upTo) }))
    }

    /** FCM registration token for this device. */
    suspend fun registerPush(fcmToken: String, notifyMode: String, quietHours: Boolean) {
        send(request("POST", "/api/agent/devices/push", buildJsonObject {
            put("token", fcmToken); put("environment", "fcm"); put("platform", "android")
            put("notify_mode", notifyMode); put("quiet_hours", quietHours)
        }))
    }

    suspend fun unregisterPush(fcmToken: String) {
        runCatching { send(request("DELETE", "/api/agent/devices/push", buildJsonObject { put("token", fcmToken) })) }
    }

    // MARK: timeline

    suspend fun posts(cursor: String? = null, limit: Int = 30): PostListResponse =
        get("/api/agent/posts", buildMap {
            put("limit", "$limit"); put("include", "reactions,read")
            if (cursor != null) put("cursor", cursor)
        })

    suspend fun thread(id: Long): ThreadResponse = get("/api/agent/posts/$id", mapOf("include" to "reactions,read"))

    suspend fun clubs(): List<ClubInfo> = get<ClubsResponse>("/api/agent/clubs").clubs

    suspend fun publish(text: String, images: List<String>, parentId: Long?): Post =
        decode<PublishResponse>(send(request("POST", "/api/agent/publish", buildJsonObject {
            put("text", text)
            put("images", JsonArray(images.map { JsonPrimitive(it) }))
            if (parentId != null) put("parent_id", parentId)
        }))).post

    /** JPEGs (already resized). Returns /api/media/… URLs. */
    suspend fun upload(jpegs: List<ByteArray>): List<String> {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM).apply {
            jpegs.forEachIndexed { i, b -> addFormDataPart("images", "photo$i.jpg", b.toRequestBody("image/jpeg".toMediaType())) }
        }.build()
        val req = Request.Builder().url("${Net.BASE}/api/agent/upload").header("Authorization", "Bearer $token").post(body).build()
        val resp = Net.http.newBuilder().callTimeout(120, TimeUnit.SECONDS).writeTimeout(120, TimeUnit.SECONDS).build().newCall(req).await()
        resp.use {
            val text = it.body.string()
            if (!it.isSuccessful) {
                val err = runCatching { ApiJson.decodeFromString<ApiErrorBody>(text) }.getOrNull()
                if (it.code == 401) throw ApiError.Unauthorized(err?.code)
                throw ApiError.Http(it.code, err?.code, err?.error)
            }
            return decode<UploadResponse>(text).urls
        }
    }

    suspend fun togglePostReaction(id: Long, emoji: String): PostReactionToggle =
        decode(send(request("POST", "/api/agent/reactions", buildJsonObject { put("post_id", id); put("emoji", emoji) })))

    suspend fun markPostsRead(ids: List<Long>) {
        runCatching { send(request("POST", "/api/agent/read", buildJsonObject { put("post_ids", JsonArray(ids.map { JsonPrimitive(it) })) })) }
    }

    /** The newest APK on the server (members only) — for the in-app update notice. */
    suspend fun androidRelease(): AndroidReleaseInfo = get("/api/download/android/info")

    suspend fun revokeSelf() {
        runCatching { send(request("DELETE", "/api/agent/token/self")) }
    }

    companion object {
        /** Absolute URL for avatar / emoji paths the server returns relative. */
        fun absolute(url: String?): String? = when {
            url.isNullOrBlank() -> null
            url.startsWith("http") -> url
            url.startsWith("/") -> Net.BASE + url
            else -> null
        }
    }
}
