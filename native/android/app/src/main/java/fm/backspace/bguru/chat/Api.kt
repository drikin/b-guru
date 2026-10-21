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

    suspend fun post(body: String, clientId: String, images: List<String> = emptyList()): ChatMessage =
        decode<ChatSendResponse>(send(request("POST", "/api/agent/chat", buildJsonObject {
            put("body", body); put("client_id", clientId)
            if (images.isNotEmpty()) put("images", JsonArray(images.map { JsonPrimitive(it) }))
        }))).message

    /** Chat photos (JPEGs, already resized). Returns /api/media/… URLs for [post]. */
    suspend fun uploadChatImages(jpegs: List<ByteArray>, path: String = "/api/agent/chat/upload"): List<String> =
        uploadImages(path, jpegs)

    suspend fun edit(id: Long, body: String): ChatMessage =
        decode<ChatSendResponse>(send(request("PATCH", "/api/agent/chat/$id", buildJsonObject { put("body", body) }))).message

    suspend fun toggleReaction(id: Long, emoji: String): ReactionToggleResponse =
        decode(send(request("POST", "/api/agent/chat/$id/reactions", buildJsonObject { put("emoji", emoji) })))

    suspend fun markRead(upTo: Long) {
        send(request("POST", "/api/agent/chat/read", buildJsonObject { put("last_read_id", upTo) }))
    }

    /** FCM registration token for this device. */
    suspend fun registerPush(fcmToken: String, notifyMode: String, quietHours: Boolean, notifyTimeline: Boolean, notifyShogi: Boolean = true) {
        send(request("POST", "/api/agent/devices/push", buildJsonObject {
            put("token", fcmToken); put("environment", "fcm"); put("platform", "android")
            put("notify_mode", notifyMode); put("quiet_hours", quietHours)
            put("notify_timeline", notifyTimeline)
            // ☗ 将棋 pushes (shogi_offer / shogi_turn) go only to apps that say they know them.
            put("notify_shogi", notifyShogi)
        }))
    }

    suspend fun unregisterPush(fcmToken: String) {
        runCatching { send(request("DELETE", "/api/agent/devices/push", buildJsonObject { put("token", fcmToken) })) }
    }

    // MARK: voice room

    suspend fun voiceState(): VoiceStateResponse = get("/api/agent/voice")

    suspend fun voiceToken(): VoiceTokenResponse =
        decode(send(request("POST", "/api/agent/voice/token", buildJsonObject {})))

    suspend fun voiceReport(userId: String, reason: String) {
        send(request("POST", "/api/agent/voice/report", buildJsonObject { put("user_id", userId); put("reason", reason) }))
    }

    /** Returns whether the mic was on (and is now off). */
    suspend fun voiceMute(userId: String): Boolean =
        decode<VoiceMuteResponse>(send(request("POST", "/api/agent/voice/mute", buildJsonObject { put("user_id", userId) }))).muted ?: false

    suspend fun voiceKick(userId: String, ban: Boolean) {
        send(request("POST", "/api/agent/voice/kick", buildJsonObject { put("user_id", userId); put("ban", ban) }))
    }

    // MARK: club room (ルーム)

    suspend fun room(path: String = "/api/agent/room"): RoomStateResponse = get(path)

    /** POST { action: "enter" | "text" | "move" | "voice" | "react", … }. */
    suspend fun roomAction(body: JsonObject, path: String = "/api/agent/room"): RoomActionResponse =
        decode(send(request("POST", path, body)))

    // MARK: ☗ 将棋 (docs/shogi-spec.md) — GET needs read, POST needs chat

    /** One call under `base` (capabilities' shogi path). Every status comes back with the parsed
     *  body: a 409 carries the newest `game`. Throws on 401 (Unauthorized) and transport errors. */
    suspend fun shogi(method: String, path: String, body: JsonObject? = null, base: String = "/api/agent/shogi", query: Map<String, String> = emptyMap()): Pair<Int, ShogiReply?> {
        val req = request(method, "$base/$path", if (method == "GET") null else (body ?: buildJsonObject {}), query)
        Net.http.newCall(req).await().use { resp ->
            val text = resp.body.string()
            val parsed = runCatching { ApiJson.decodeFromString<ShogiReply>(text) }.getOrNull()
            if (resp.code == 401) throw ApiError.Unauthorized(parsed?.code)
            return resp.code to parsed
        }
    }

    suspend fun shogiGames(base: String = "/api/agent/shogi") = shogi("GET", "games", base = base, query = mapOf("status" to "open,offered,active,ended"))
    suspend fun shogiGame(id: Long, base: String = "/api/agent/shogi") = shogi("GET", "games/$id", base = base)
    suspend fun shogiCreate(mode: String, inviteeUserId: String?, rematchOf: Long?, base: String = "/api/agent/shogi", opponent: String? = null) =
        shogi("POST", "games", buildJsonObject {
            put("mode", mode)
            if (opponent != null) put("opponent", opponent)
            if (inviteeUserId != null) put("invitee_user_id", inviteeUserId)
            if (rematchOf != null) put("rematch_of", rematchOf)
        }, base)
    /** accept / decline / cancel / resign / watch. */
    suspend fun shogiAction(id: Long, action: String, base: String = "/api/agent/shogi") = shogi("POST", "games/$id/$action", base = base)
    suspend fun shogiMove(id: Long, usi: String, expectedPly: Int, clientMoveId: String, base: String = "/api/agent/shogi") =
        shogi("POST", "games/$id/move", buildJsonObject {
            put("usi", usi); put("expected_ply", expectedPly); put("client_move_id", clientMoveId)
        }, base)

    // MARK: 🎮 締め切りダッシュ (docs/minigame-spec.md) — GET needs read, POST needs chat

    /** One call under `base`; every status comes back with the body as JSON (errors are `{ error, code }`),
     *  which the app hands to the game as it is. Throws on 401 and transport errors. */
    suspend fun minigame(method: String, path: String, body: JsonObject? = null, base: String = "/api/agent/minigame", query: Map<String, String> = emptyMap()): Pair<Int, JsonObject?> {
        val req = request(method, "$base/$path", if (method == "GET") null else (body ?: buildJsonObject {}), query)
        Net.http.newBuilder().callTimeout(30, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build().newCall(req).await().use { resp ->
            val text = resp.body.string()
            val parsed = runCatching { ApiJson.parseToJsonElement(text) as? JsonObject }.getOrNull()
            if (resp.code == 401) throw ApiError.Unauthorized(null)
            return resp.code to parsed
        }
    }

    // MARK: jukebox

    /** The whole catalogue as text (it is cached on disk as is). */
    suspend fun jukeboxText(path: String = "/api/agent/jukebox"): String = send(request("GET", path))

    // MARK: ネタ帳

    /** POST { url, title, description? }. Every status comes back (201 / 409 / 4xx …) with
     *  the parsed body — the caller words the result. Throws only on transport errors. */
    suspend fun sendNeta(url: String, title: String, description: String, path: String = "/api/agent/neta"): Pair<Int, NetaResponse?> {
        val req = request("POST", path, buildJsonObject {
            put("url", url); put("title", title)
            if (description.isNotBlank()) put("description", description)
        })
        Net.http.newCall(req).await().use { resp ->
            val text = resp.body.string()
            return resp.code to runCatching { ApiJson.decodeFromString<NetaResponse>(text) }.getOrNull()
        }
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
    suspend fun upload(jpegs: List<ByteArray>): List<String> = uploadImages("/api/agent/upload", jpegs)

    /** Multipart `images` parts, with a longer timeout than JSON calls (photos on a slow uplink). */
    private suspend fun uploadImages(path: String, jpegs: List<ByteArray>): List<String> {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM).apply {
            jpegs.forEachIndexed { i, b -> addFormDataPart("images", "photo$i.jpg", b.toRequestBody("image/jpeg".toMediaType())) }
        }.build()
        val req = Request.Builder().url(Net.BASE + path).header("Authorization", "Bearer $token").post(body).build()
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
