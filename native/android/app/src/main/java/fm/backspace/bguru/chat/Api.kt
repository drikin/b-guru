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
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** What a new post carries besides text and photos (each only when set). */
data class PublishExtra(
    val whisper: Boolean = false,
    val videoUrl: String? = null,
    val audioUrl: String? = null,
    val poll: PollInput? = null,
    val club: String? = null,
)

data class PollInput(val question: String, val options: List<String>, val durationHours: Int)

/** The sound of an edited post: unchanged, taken off, or a new upload. */
sealed interface AudioChange {
    data object Keep : AudioChange
    data object Remove : AudioChange
    data class Set(val url: String) : AudioChange
}

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

    /** Video and audio in the timeline: a whole film streams over one call, so no overall
     *  limit (the shared client's 20 s would cut it and make the player re-read). */
    val media: OkHttpClient = http.newBuilder()
        .readTimeout(30, TimeUnit.SECONDS)
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

/** The calls behind the timeline's operations (段階 3) — an interface so the tests can make them
 *  fail and check that what was shown at once is put back (PostOpsTest). */
interface PostOpsApi {
    suspend fun toggleBookmark(postId: Long): Boolean
    suspend fun setBookmark(postId: Long, on: Boolean): Boolean
    suspend fun setFavorite(userId: String, on: Boolean): Boolean
    suspend fun togglePin(id: Long): Boolean
    suspend fun setClub(id: Long, key: String?): String?
    suspend fun vote(id: Long, optionId: Long): PostPoll?
    suspend fun togglePostReaction(id: Long, emoji: String): PostReactionToggle
}

/** The agent API (/api/agent/...) with this device's Bearer token. */
class ApiClient(val token: String) : PostOpsApi {

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

    /** 🐶 Ask the server's Beagle to answer my @ビーグル question now (the answer comes on the stream). */
    suspend fun askBeagle(questionId: Long) {
        send(request("POST", "/api/agent/chat/beagle/ask", buildJsonObject { put("question_id", questionId) }))
    }

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

    // MARK: 🎮 散財ダッシュ (docs/minigame-spec.md) — GET needs read, POST needs chat

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

    // MARK: 🍻 オフ会 (docs/offkai-spec.md) — `base` is capabilities' offkai path; GET needs read, POST / DELETE chat

    suspend fun offkaiState(base: String, before: Long? = null): OffkaiState =
        get(base, if (before != null) mapOf("before" to "$before") else emptyMap())
    /** 409 `busy` when another one is on (ApiError.Http). */
    suspend fun offkaiStart(base: String, title: String): OffkaiEvent? =
        decode<OffkaiEventReply>(send(request("POST", base, buildJsonObject { put("title", title) }))).event
    suspend fun offkaiEnd(base: String): OffkaiEvent? =
        decode<OffkaiEventReply>(send(request("POST", "$base/end", buildJsonObject {}))).event
    /** Speak (the last one to press wins) or stop. Speaking gives a key that may publish the mic. */
    suspend fun offkaiSpeak(base: String, on: Boolean): OffkaiTokenReply =
        decode(send(request("POST", "$base/speak", buildJsonObject { put("on", on) })))
    suspend fun offkaiToken(base: String): OffkaiTokenReply =
        decode(send(request("POST", "$base/token", buildJsonObject {})))
    suspend fun offkaiEvent(base: String, id: Long): OffkaiEvent? = get<OffkaiEventReply>("$base/$id").event
    /** The album, oldest first; `after` = the last photo id already shown. */
    suspend fun offkaiPhotos(base: String, id: Long, after: Long? = null): OffkaiPhotosReply =
        get("$base/$id/photos", if (after != null) mapOf("after" to "$after") else emptyMap())
    suspend fun offkaiDeletePhoto(base: String, photoId: Long) { send(request("DELETE", "$base/photos/$photoId")) }

    /** Up to 4 JPEGs (already resized, EXIF gone) as multipart `images` + `caption`. */
    suspend fun offkaiUpload(base: String, jpegs: List<ByteArray>, caption: String): List<OffkaiPhoto> {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM).apply {
            jpegs.forEachIndexed { i, b -> addFormDataPart("images", "photo$i.jpg", b.toRequestBody("image/jpeg".toMediaType())) }
            if (caption.isNotBlank()) addFormDataPart("caption", caption)
        }.build()
        val req = Request.Builder().url(Net.BASE + "$base/photos").header("Authorization", "Bearer $token").post(body).build()
        Net.http.newBuilder().callTimeout(120, TimeUnit.SECONDS).writeTimeout(120, TimeUnit.SECONDS).build().newCall(req).await().use {
            val text = it.body.string()
            if (!it.isSuccessful) {
                val err = runCatching { ApiJson.decodeFromString<ApiErrorBody>(text) }.getOrNull()
                if (it.code == 401) throw ApiError.Unauthorized(err?.code)
                throw ApiError.Http(it.code, err?.code, err?.error)
            }
            return decode<OffkaiPhotosReply>(text).photos
        }
    }

    // MARK: ✉️ 簡易 DM (src/lib/dm.ts) — `base` is capabilities' dm path

    suspend fun dmConversations(base: String = "/api/agent/dm"): DMListResponse = get(base)
    suspend fun dmThread(userId: String, base: String = "/api/agent/dm", limit: Int = 200): DMThreadResponse =
        get("$base/${userId.encodedPath()}", mapOf("limit" to "$limit"))
    suspend fun dmSend(userId: String, body: String, clientId: String, base: String = "/api/agent/dm"): DMMessage =
        decode<DMSendResponse>(send(request("POST", "$base/${userId.encodedPath()}", buildJsonObject {
            put("body", body); put("client_id", clientId)
        }))).message
    /** Returns the total unread across all conversations. */
    suspend fun dmMarkRead(userId: String, lastReadId: Long, base: String = "/api/agent/dm"): Int =
        decode<DMReadResponse>(send(request("POST", "$base/${userId.encodedPath()}/read", buildJsonObject { put("last_read_id", lastReadId) }))).unreadCount
    /** One DM (for a notification): the message and the other person. */
    suspend fun dmMessage(id: Long, base: String = "/api/agent/dm"): DMMessageResponse = get("$base/messages/$id")

    private fun String.encodedPath(): String = java.net.URLEncoder.encode(this, "UTF-8").replace("+", "%20")

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
            put("limit", "$limit"); put("include", "reactions,read,display")
            if (cursor != null) put("cursor", cursor)
        })

    suspend fun thread(id: Long): ThreadResponse = get("/api/agent/posts/$id", mapOf("include" to "reactions,read,display"))

    suspend fun clubs(): List<ClubInfo> = get<ClubsResponse>("/api/agent/clubs").clubs

    /** A post or a reply (POST /api/agent/publish). Only the fields the draft uses are sent:
     *  an older server sees exactly what it saw before (text, images, parent_id). */
    suspend fun publish(text: String, images: List<String>, parentId: Long?, extra: PublishExtra = PublishExtra()): Post =
        decode<PublishResponse>(send(request("POST", "/api/agent/publish", publishBody(text, images, parentId, extra)))).post

    /** The list with one filter: `pinned=1` (pins now, oldest pin first), `bm=1`, `fav=1`. */
    suspend fun postsWhere(filter: String, cursor: String? = null, limit: Int = 30): PostListResponse =
        get("/api/agent/posts", buildMap {
            put("limit", "$limit"); put("include", "reactions,read,display"); put(filter, "1")
            if (cursor != null) put("cursor", cursor)
        })

    /** PATCH own post. App keys: text + images (the new list) + audio; `textOnly` (write keys): text only. */
    suspend fun editPost(id: Long, text: String, images: List<String>?, audio: AudioChange, textOnly: Boolean) {
        send(request("PATCH", "/api/agent/posts/$id", editBody(text, images, audio, textOnly)))
    }

    suspend fun deletePost(id: Long) { send(request("DELETE", "/api/agent/posts/$id")) }

    /** Toggle; returns whether it is pinned now. */
    override suspend fun togglePin(id: Long): Boolean = decode<PinResponse>(send(request("POST", "/api/agent/posts/$id/pin", buildJsonObject {}))).pinned

    /** key null = 「ラベルなし」. */
    override suspend fun setClub(id: Long, key: String?): String? =
        decode<ClubChangeResponse>(send(request("PATCH", "/api/agent/posts/$id/club", buildJsonObject {
            if (key == null) put("club", JsonNull) else put("club", key)
        }))).club

    override suspend fun vote(id: Long, optionId: Long): PostPoll? =
        decode<PollResponse>(send(request("POST", "/api/agent/posts/$id/poll/vote", buildJsonObject { put("option_id", optionId) }))).poll

    /** Who voted for what (only the poll's author may ask; others get 403). */
    suspend fun pollVoters(id: Long): List<PollVoterGroup> =
        decode<PollVotersResponse>(send(request("GET", "/api/agent/posts/$id/poll/voters", null))).options

    /** The answers in order: id = an existing option, null = a new one. */
    suspend fun editPoll(id: Long, options: List<Pair<Long?, String>>): PostPoll? =
        decode<PollResponse>(send(request("PUT", "/api/agent/posts/$id/poll", pollEditBody(options)))).poll

    override suspend fun toggleBookmark(postId: Long): Boolean =
        decode<BookmarkResponse>(send(request("POST", "/api/agent/bookmarks", buildJsonObject { put("post_id", postId) }))).bookmarked

    /** Idempotent (servers that say `bookmarks_set`): `{ post_id, bookmarked }`. */
    override suspend fun setBookmark(postId: Long, on: Boolean): Boolean =
        decode<BookmarkResponse>(send(request("POST", "/api/agent/bookmarks", buildJsonObject { put("post_id", postId); put("bookmarked", on) }))).bookmarked

    /** Idempotent: POST adds, DELETE removes. Returns the new state. */
    override suspend fun setFavorite(userId: String, on: Boolean): Boolean =
        decode<FavoriteResponse>(send(request(if (on) "POST" else "DELETE", "/api/agent/favorites", buildJsonObject { put("user_id", userId) }))).favorited

    suspend fun customEmojis(path: String = "/api/agent/emojis"): List<CustomEmoji> = get<EmojisResponse>(path).emojis

    /** A video or a sound (multipart `video` / `audio`, one per call): /api/media/… URL. `body`
     *  streams the file (up to 100 MB), so the call has no overall time limit beyond 15 minutes. */
    suspend fun uploadMedia(field: String, fileName: String, body: okhttp3.RequestBody): String {
        val form = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart(field, fileName, body).build()
        val req = Request.Builder().url(Net.BASE + "/api/agent/upload").header("Authorization", "Bearer $token").post(form).build()
        val client = Net.http.newBuilder().callTimeout(15, TimeUnit.MINUTES).writeTimeout(120, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS).build()
        client.newCall(req).await().use {
            val text = it.body.string()
            if (!it.isSuccessful) {
                val err = runCatching { ApiJson.decodeFromString<ApiErrorBody>(text) }.getOrNull()
                if (it.code == 401) throw ApiError.Unauthorized(err?.code)
                throw ApiError.Http(it.code, err?.code, err?.error)
            }
            val r = decode<MediaUploadResponse>(text)
            return (if (field == "video") r.videoUrl else r.audioUrl) ?: throw ApiError.Transport("decode: no url")
        }
    }

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

    override suspend fun togglePostReaction(id: Long, emoji: String): PostReactionToggle =
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
        /** The publish body (docs/timeline-spec.md §11). Pure, for the tests. */
        fun publishBody(text: String, images: List<String>, parentId: Long?, extra: PublishExtra = PublishExtra()): JsonObject = buildJsonObject {
            put("text", text)
            put("images", JsonArray(images.map { JsonPrimitive(it) }))
            if (parentId != null) put("parent_id", parentId)
            if (extra.whisper && parentId != null) put("whisper", true)
            extra.videoUrl?.let { put("video_url", it) }
            extra.audioUrl?.let { put("audio_url", it) }
            extra.poll?.let { p ->
                put("poll", buildJsonObject {
                    put("question", p.question)
                    put("options", JsonArray(p.options.map { JsonPrimitive(it) }))
                    put("duration_hours", p.durationHours)
                })
            }
            if (extra.club != null && parentId == null) put("club", extra.club)
        }

        fun editBody(text: String, images: List<String>?, audio: AudioChange, textOnly: Boolean): JsonObject = buildJsonObject {
            put("text", text)
            if (textOnly) return@buildJsonObject
            images?.let { put("images", JsonArray(it.map { u -> JsonPrimitive(u) })) }
            when (audio) {
                AudioChange.Keep -> {}
                AudioChange.Remove -> put("audio_url", JsonNull)
                is AudioChange.Set -> put("audio_url", audio.url)
            }
        }

        fun pollEditBody(options: List<Pair<Long?, String>>): JsonObject = buildJsonObject {
            put("options", JsonArray(options.map { (id, label) ->
                buildJsonObject { if (id == null) put("id", JsonNull) else put("id", id); put("label", label) }
            }))
        }

        /** Absolute URL for avatar / emoji paths the server returns relative. */
        fun absolute(url: String?): String? = when {
            url.isNullOrBlank() -> null
            url.startsWith("http") -> url
            url.startsWith("/") -> Net.BASE + url
            else -> null
        }
    }
}
