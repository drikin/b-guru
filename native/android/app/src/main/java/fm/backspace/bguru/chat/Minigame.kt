package fm.backspace.bguru.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** 🎮 締め切りダッシュ — the pure parts (unit-tested): the game page's messages (bridge_version 1,
 *  docs/minigame-spec.md「橋渡し」) and the replies the app hands back. The game draws everything
 *  (title, run, result, leaderboard); the app is the box and relays the API with its own token. */
object MinigameLogic {
    const val BRIDGE_VERSION = 1
    private val MODES = setOf("daily", "free")
    private val CHARACTERS = setOf("drikin", "matsuo", "zenji")
    private val PERIODS = setOf("today", "week", "all")
    private val HAPTICS = setOf("hit", "dead", "powerup", "highscore", "select")

    sealed interface GameOut {
        data class Ready(val engineVersion: Int) : GameOut
        data class RequestPlay(val req: Int, val mode: String, val character: String) : GameOut
        /** `body` is what POST plays/{id}/finish takes: inputs, engine_version, score, ticks. */
        data class Finished(val req: Int, val playId: Long, val body: JsonObject) : GameOut
        data class RequestLeaderboard(val req: Int, val period: String) : GameOut
        data object RequestInfo : GameOut
        data class Haptic(val kind: String) : GameOut
        data class Size(val height: Int) : GameOut
        data class Error(val message: String) : GameOut
    }

    /** `MinigameBridge.postMessage(json)` → a message; anything malformed or of another version is dropped. */
    fun parse(json: String): GameOut? {
        // A finished run carries its inputs (≤ 30,000 numbers): allow that, not more.
        if (json.length > 400_000) return null
        val o = runCatching { ApiJson.parseToJsonElement(json).jsonObject }.getOrNull() ?: return null
        fun str(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        fun int(k: String) = (o[k] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
        if (int("v") != BRIDGE_VERSION) return null
        val req = int("req")?.takeIf { it > 0 }
        return when (str("type")) {
            "ready" -> GameOut.Ready(int("engine_version") ?: 0)
            "request_play" -> {
                val mode = str("mode")?.takeIf { it in MODES } ?: return null
                val ch = str("character")?.takeIf { it in CHARACTERS } ?: return null
                GameOut.RequestPlay(req ?: return null, mode, ch)
            }
            "finished" -> {
                val playId = (o["play_id"] as? JsonPrimitive)?.longOrNull?.takeIf { it > 0 } ?: return null
                val inputs = o["inputs"] as? JsonArray ?: return null
                if (inputs.size > 30_000 || inputs.any { (it as? JsonPrimitive)?.longOrNull == null }) return null
                val body = buildJsonObject {
                    put("inputs", inputs)
                    put("engine_version", int("engine_version") ?: return null)
                    int("score")?.let { put("score", it) }
                    int("ticks")?.let { put("ticks", it) }
                }
                GameOut.Finished(req ?: return null, playId, body)
            }
            "request_leaderboard" -> GameOut.RequestLeaderboard(req ?: return null, str("period")?.takeIf { it in PERIODS } ?: return null)
            "request_info" -> GameOut.RequestInfo
            "haptic" -> str("kind")?.takeIf { it in HAPTICS }?.let { GameOut.Haptic(it) }
            "size" -> (o["height"] as? JsonPrimitive)?.doubleOrNull?.takeIf { it > 0 && it < 5000 }?.let { GameOut.Size(kotlin.math.ceil(it).toInt()) }
            "error" -> GameOut.Error(str("message")?.take(200) ?: "")
            else -> null
        }
    }

    /** The answer to a request (`{ req, ...ok }` or `{ req, error, code }`), from the API's status and body.
     *  `inner`: the key the API wraps it in ("play", "result"), or null to use the body itself (leaderboard). */
    fun reply(req: Int, status: Int, body: JsonObject?, inner: String?): JsonObject {
        if (status in 200..299 && body != null) {
            val ok = if (inner != null) body[inner] as? JsonObject else JsonObject(body - "apiVersion")
            if (ok != null) return JsonObject(ok + ("req" to JsonPrimitive(req)))
        }
        return errorReply(req, (body?.get("error") as? JsonPrimitive)?.contentOrNull ?: "うまくいきませんでした",
            (body?.get("code") as? JsonPrimitive)?.contentOrNull ?: "error")
    }

    fun errorReply(req: Int, error: String, code: String): JsonObject =
        buildJsonObject { put("req", req); put("error", error); put("code", code) }

    /** `state`: the info (GET me's body spread out), theme, max_height and/or one reply. */
    fun state(info: JsonObject? = null, theme: String? = null, maxHeight: Int? = null, replyKey: String? = null, reply: JsonObject? = null): JsonObject =
        buildJsonObject {
            put("type", "state")
            info?.forEach { (k, v) -> if (k != "apiVersion" && k != "type") put(k, v) }
            if (theme != null) put("theme", theme)
            if (maxHeight != null && maxHeight > 0) put("max_height", maxHeight)
            if (replyKey != null && reply != null) put(replyKey, reply)
        }

    /** The stream's `minigame` event, as it came. */
    fun event(data: String): JsonObject? {
        val d = runCatching { ApiJson.parseToJsonElement(data) as? JsonObject }.getOrNull() ?: return null
        return buildJsonObject { put("type", "event"); put("data", d) }
    }

    fun simple(type: String): JsonObject = buildJsonObject { put("type", type) }

    fun receiveScript(msg: JsonObject): String =
        "window.bguruMinigame&&window.bguruMinigame.receive(${JsonPrimitive(msg.toString())});"
}

/** 🎮 state and the API relay. Main thread. */
class MinigameStore(private val api: ApiClient) {
    var enabled by mutableStateOf(false); private set
    var canPlay by mutableStateOf(false); private set
    /** 🎮 is the selected mode at the top of the chat (never together with ☗). */
    var open by mutableStateOf(false)
    var basePath = "/api/agent/minigame"; private set
    var gameUrl = "/minigame/index.html"; private set
    /** Debug only: answers made up here, nothing goes out. */
    var demo = false; private set
    /** The open game page, for the stream's `minigame` events. */
    var eventSink: ((JsonObject) -> Unit)? = null

    fun configure(caps: Capabilities?) {
        if (demo) return
        enabled = caps?.minigameEnabled == true
        canPlay = caps?.canPlayMinigame == true
        caps?.let { basePath = it.minigamePath; gameUrl = it.minigameGameUrl }
        if (!enabled) open = false
    }

    /** The stream's `event: minigame`: straight to the game (today's top 10, my best). */
    fun onStreamEvent(data: String) {
        MinigameLogic.event(data)?.let { eventSink?.invoke(it) }
    }

    /** GET me (null when it failed: the game keeps what it had). */
    suspend fun info(): JsonObject? {
        if (demo) return demoInfo()
        return try {
            val (status, body) = api.minigame("GET", "me", base = basePath)
            if (status == 200) body else null
        } catch (e: CancellationException) { throw e } catch (_: Exception) { null }
    }

    /** A request from the game → the `state` message that answers it. */
    suspend fun answer(out: MinigameLogic.GameOut): JsonObject? = when (out) {
        is MinigameLogic.GameOut.RequestPlay -> MinigameLogic.state(replyKey = "play", reply =
            if (demo) demoPlay(out) else call(out.req, "play") { api.minigame("POST", "plays", buildJsonObject { put("mode", out.mode); put("character", out.character) }, basePath) })
        is MinigameLogic.GameOut.Finished -> MinigameLogic.state(replyKey = "result", reply =
            if (demo) demoResult(out) else call(out.req, "result") { api.minigame("POST", "plays/${out.playId}/finish", out.body, basePath) })
        is MinigameLogic.GameOut.RequestLeaderboard -> MinigameLogic.state(replyKey = "leaderboard", reply =
            if (demo) demoLeaderboard(out) else call(out.req, null) { api.minigame("GET", "leaderboard", base = basePath, query = mapOf("period" to out.period)) })
        MinigameLogic.GameOut.RequestInfo -> info()?.let { MinigameLogic.state(info = it) }
        else -> null
    }

    private suspend fun call(req: Int, inner: String?, work: suspend () -> Pair<Int, JsonObject?>): JsonObject = try {
        val (status, body) = work()
        MinigameLogic.reply(req, status, body, inner)
    } catch (e: CancellationException) {
        throw e
    } catch (e: ApiError.Unauthorized) {
        MinigameLogic.errorReply(req, "ログインし直してください", "unauthorized")
    } catch (_: Exception) {
        MinigameLogic.errorReply(req, "通信できませんでした", "network")
    }

    // MARK: demo (`--ez demo true`)

    private var demoEngine = 1
    private var demoPlayId = 900L
    private var demoBest = 0
    private var demoPlays = 0
    private val demoSeed = 822266587L

    fun loadDemo() {
        demo = true
        enabled = true
        canPlay = true
    }

    fun demoEngineVersion(v: Int) { if (v > 0) demoEngine = v }

    private fun today() = LocalDate.now(ZoneId.of("Asia/Tokyo")).minusDays(if (java.time.LocalTime.now(ZoneId.of("Asia/Tokyo")).hour < 5) 1 else 0).toString()

    private fun entry(rank: Int, name: String, score: Int, ch: String) = buildJsonObject {
        put("rank", rank); put("user_id", "demo-$rank"); put("name", name); put("avatar", null as String?)
        put("score", score); put("distance", score * 3 / 4); put("character", ch); put("achieved_at", Instant.now().toString())
    }

    private fun demoTop(): JsonArray = buildJsonArray {
        add(entry(1, "ぜんじ", 2980, "zenji")); add(entry(2, "mazzo", 2140, "matsuo")); add(entry(3, "takuto", 1560, "drikin"))
    }

    private fun demoInfo(): JsonObject = buildJsonObject {
        put("engine_version", demoEngine)
        putJsonObject("me") { put("user_id", "me"); put("name", "ドリキン") }
        putJsonObject("daily") { put("date", today()); put("seed", demoSeed); put("resets_at", Instant.now().plusSeconds(6 * 3600).toString()) }
        putJsonObject("best") {
            if (demoBest > 0) putJsonObject("today") { put("score", demoBest); put("distance", demoBest * 3 / 4); put("rank", 2); put("play_id", demoPlayId); put("character", "drikin"); put("achieved_at", Instant.now().toString()) }
            else put("today", JsonNull)
            put("week", JsonNull); put("all", JsonNull)
        }
        put("plays_today", demoPlays)
        put("top_today", demoTop()[0])
    }

    private fun demoPlay(r: MinigameLogic.GameOut.RequestPlay): JsonObject = buildJsonObject {
        demoPlayId++
        put("req", r.req); put("play_id", demoPlayId)
        put("seed", if (r.mode == "daily") demoSeed else (System.nanoTime() and 0x7fffffff))
        put("mode", r.mode); put("character", r.character); put("engine_version", demoEngine)
        if (r.mode == "daily") put("date", today()) else put("date", null as String?)
        put("expires_at", Instant.now().plusSeconds(1800).toString())
    }

    /** The demo trusts the game's own count (the server would replay the inputs). */
    private fun demoResult(f: MinigameLogic.GameOut.Finished): JsonObject {
        val score = (f.body["score"] as? JsonPrimitive)?.intOrNull ?: 0
        val ticks = (f.body["ticks"] as? JsonPrimitive)?.intOrNull ?: 0
        val newBest = score > demoBest
        if (newBest) demoBest = score
        demoPlays++
        val rank = if (demoBest >= 2980) 1 else if (demoBest >= 2140) 2 else if (demoBest >= 1560) 3 else 4
        return buildJsonObject {
            put("req", f.req); put("play_id", f.playId); put("mode", "daily"); put("score", score); put("distance", score * 3 / 4)
            put("sd", 0); put("ticks", ticks); put("cause", "deadline"); put("best", demoBest); put("new_best", newBest)
            put("rank", rank); put("period", "today"); put("rank_today", rank); put("plays_today", demoPlays)
            put("rest_hint", false); put("mismatch", false)
        }
    }

    private fun demoLeaderboard(r: MinigameLogic.GameOut.RequestLeaderboard): JsonObject = buildJsonObject {
        put("req", r.req); put("period", r.period); put("mode", if (r.period == "week") "free" else "daily")
        put("key", if (r.period == "today") today() else null)
        put("entries", demoTop())
        if (demoBest > 0) putJsonObject("me") { put("rank", 4); put("score", demoBest); put("distance", demoBest * 3 / 4) } else put("me", null as String?)
    }
}
