package fm.backspace.bguru.chat

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import java.io.File
import java.security.MessageDigest
import java.time.Instant

/** Small files of the signed-in account in the app's private storage (the chat's last rows, the timeline's
 *  first page). One account at a time: a file is named after a hash of the token, a new sign-in starts empty,
 *  and sign-out removes the folder. */
object AccountCache {
    private fun dir(ctx: android.content.Context) = File(ctx.filesDir, "account-cache")

    fun file(ctx: android.content.Context, token: String, name: String): File =
        File(dir(ctx), "$name-${tokenKey(token)}.json")

    /** Removes the files of other sign-ins (left from before a token change). Off the main thread. */
    fun keepOnly(ctx: android.content.Context, token: String) {
        val key = tokenKey(token)
        dir(ctx).listFiles()?.forEach { if (!it.name.endsWith("-$key.json")) it.delete() }
    }

    fun clear(ctx: android.content.Context) { dir(ctx).deleteRecursively() }

    fun clearToken(ctx: android.content.Context, token: String) {
        val key = tokenKey(token)
        dir(ctx).listFiles()?.forEach { if (it.name.endsWith("-$key.json")) it.delete() }
    }

    fun tokenKey(token: String): String =
        MessageDigest.getInstance("SHA-256").digest(token.toByteArray()).take(8).joinToString("") { "%02x".format(it) }

    /** Write then rename: a crash mid-write leaves the old file, never half a file. */
    fun write(f: File, text: String) {
        f.parentFile?.mkdirs()
        val tmp = File(f.parentFile, f.name + ".tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
    }
}

/** What is kept of the chat between launches: the server's rows only (never a pending or failed one). */
@Serializable
data class ChatCacheFile(val v: Int = 1, val latestId: Long = 0, val messages: List<ChatMessage> = emptyList())

/** The chat's cache and delta resync, as pure functions (ChatDeltaTest). Same rules as the Swift apps. */
object ChatDelta {
    /** As many rows as the full reload reads (GET /api/agent/chat?limit=100): the list stays bounded the same way. */
    const val KEEP = 100
    /** Chat messages expire after 24 h on the server. */
    const val TTL_MS = 24 * 3600_000L
    /** The server's window answers at most this many ids (the newest of the range). */
    const val WINDOW_LIMIT = 200

    /** The rows worth keeping on disk: stored ones, by id, the newest [KEEP]. */
    fun forCache(messages: List<ChatMessage>): List<ChatMessage> =
        messages.filter { it.id > 0 }.distinctBy { it.id }.sortedBy { it.id }.takeLast(KEEP)

    /** The cache as read at launch: what is older than 24 h is gone on the server too. A date that cannot be
     *  read is kept (the first resync checks it). */
    fun fresh(messages: List<ChatMessage>, nowMs: Long): List<ChatMessage> =
        forCache(messages).filter { m ->
            val t = runCatching { Instant.parse(m.createdAt).toEpochMilli() }.getOrNull()
            t == null || nowMs - t < TTL_MS
        }

    /** `window` as sent: [[id, sig], …]. Anything malformed is skipped. */
    fun parseWindow(window: List<JsonArray>): Map<Long, String?> = buildMap {
        for (pair in window) {
            val id = (pair.getOrNull(0) as? JsonPrimitive)?.longOrNull ?: continue
            put(id, (pair.getOrNull(1) as? JsonPrimitive)?.contentOrNull)
        }
    }

    /** What the delta answer means for the rows we have.
     *  `kept`: the cached rows still there and unchanged; `reread`: ids to read again (sig changed, or in the
     *  window but not here); `newer`: the messages after `after`. */
    data class Plan(val kept: List<ChatMessage>, val reread: List<Long>, val newer: List<ChatMessage>)

    /**
     * [cached]: the stored rows we have from [from] to [after] (by id). [window]: the server's [id → sig] for
     * that range. A cached id missing from the window was deleted / expired → dropped. When the window came back
     * full ([WINDOW_LIMIT]), it only covers its newest ids: rows older than its oldest id are dropped too (they are
     * the oldest, and the list is bounded anyway) rather than trusted unchecked.
     */
    fun plan(cached: List<ChatMessage>, window: Map<Long, String?>, newer: List<ChatMessage>, after: Long): Plan {
        val floor = if (window.size >= WINDOW_LIMIT) window.keys.minOrNull() ?: 0L else Long.MIN_VALUE
        val byId = cached.associateBy { it.id }
        val kept = ArrayList<ChatMessage>()
        val reread = ArrayList<Long>()
        for (m in cached) {
            if (m.id < floor || m.id !in window) continue
            val sig = window[m.id]
            if (m.sig != null && m.sig == sig) kept += m else reread += m.id
        }
        for (id in window.keys) if (id !in byId && id >= floor) reread += id
        return Plan(kept, reread.distinct().sorted(), newer.filter { it.id > after })
    }

    /** The rows after the resync: kept + re-read (an id asked for but not returned is gone) + newer, by id,
     *  the newest [KEEP]. */
    fun merge(plan: Plan, reread: List<ChatMessage>): List<ChatMessage> {
        val wanted = plan.reread.toSet()
        val out = LinkedHashMap<Long, ChatMessage>()
        plan.kept.forEach { out[it.id] = it }
        reread.filter { it.id in wanted }.forEach { out[it.id] = it }
        plan.newer.forEach { out[it.id] = it }
        return out.values.sortedBy { it.id }.takeLast(KEEP)
    }
}
