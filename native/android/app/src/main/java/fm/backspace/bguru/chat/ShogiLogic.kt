package fm.backspace.bguru.chat

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.time.Instant

/** ☗ 将棋 — the pure parts (unit-tested): reading the stream, the clock, the board bridge's
 *  messages (bridge_version 1, docs/shogi-spec.md「盤面の橋渡し」), texts, the chat card's
 *  little board, and a tiny SFEN mover for the demo. */
object ShogiLogic {
    const val INITIAL_SFEN = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"
    const val BRIDGE_VERSION = 1
    /** The server takes off up to 1 s per move for the round trip (shogi-clock.ts LAG_COMP_MS). */
    private const val LAG_COMP_MS = 1_000L

    // MARK: stream

    /** `event: shogi` data → the event (null when it is not one we can use). */
    fun parseEvent(data: String): ShogiEvent? {
        val e = runCatching { ApiJson.decodeFromString<ShogiEvent>(data) }.getOrNull() ?: return null
        val g = e.game ?: return null
        if (g.id <= 0) return null
        return e
    }

    /** Put [g] in the list. An older event never rolls back a newer state (compared by ply). */
    fun upsert(list: List<ShogiGame>, g: ShogiGame): List<ShogiGame> {
        val i = list.indexOfFirst { it.id == g.id }
        if (i < 0) return listOf(g) + list
        val old = list[i]
        if (old.ply > g.ply && old.status == g.status) return list
        // The list form has no moves: keep what the detail brought.
        val merged = if (g.moves == null && old.moves != null) g.copy(moves = old.moves, kifUrl = old.kifUrl, myColor = old.myColor) else g
        return list.toMutableList().also { it[i] = merged }
    }

    /** Merge an event's game into the detail being shown: one move on → append it; same ply →
     *  take it; anything else → null (fetch the whole game again). */
    fun mergeDetail(detail: ShogiGame, g: ShogiGame): ShogiGame? {
        if (detail.id != g.id) return detail
        val moves = detail.moves ?: emptyList()
        return when {
            g.ply == detail.ply -> g.copy(moves = g.moves ?: detail.moves, kifUrl = g.kifUrl ?: detail.kifUrl, myColor = g.myColor ?: detail.myColor)
            g.ply == detail.ply + 1 && g.lastMove != null -> g.copy(
                moves = g.moves ?: (moves + ShogiMove(g.ply, g.lastMove.usi, g.lastMove.label, g.sfen, 0, g.serverNow)),
                kifUrl = g.kifUrl ?: detail.kifUrl, myColor = g.myColor ?: detail.myColor,
            )
            g.ply < detail.ply && g.status == detail.status -> detail // stale
            else -> null
        }
    }

    fun parseInstant(iso: String?): Long? = iso?.takeIf { it.isNotBlank() }?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }

    /** Server clock − this device's clock (ms); `prev` when the server time is missing. */
    fun skewOf(serverNow: String?, now: Long, prev: Long): Long = parseInstant(serverNow)?.let { it - now } ?: prev

    // MARK: clock

    data class Clock(val blackMs: Long, val whiteMs: Long, val byoyomiMs: Long?)

    /** The remaining time at `now` (this device's clock, corrected by `skew`). Same rule as the
     *  server: the side to move loses (elapsed − 1 s); nothing runs before both sides' first move;
     *  past 0 the byo-yomi counts down. Slow games (no clocks) → null. */
    fun clockNow(g: ShogiGame, skew: Long, now: Long): Clock? {
        val c = g.clocks ?: return null
        var black = c.blackMs
        var white = c.whiteMs
        var byo: Long? = null
        val started = parseInstant(g.turnStartedAt)
        if (g.isActive && started != null && g.ply >= 2) {
            val elapsed = maxOf(0L, now + skew - started - LAG_COMP_MS)
            val main = if (g.turn == "black") black else white
            val left = main - elapsed
            if (left >= 0) {
                if (g.turn == "black") black = left else white = left
            } else {
                if (g.turn == "black") black = 0 else white = 0
                byo = maxOf(0L, c.byoyomiMs + left)
            }
        }
        return Clock(black, white, byo)
    }

    fun fmtClock(ms: Long): String {
        val s = maxOf(0L, (ms + 999) / 1000)
        return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
    }

    /** A player's line on the board: name, time left, ● on the side to move. */
    fun playerLabel(g: ShogiGame, side: String, clock: Clock?): String {
        val p = if (side == "black") g.black else g.white
        val name = p?.name?.takeIf { it.isNotBlank() } ?: "?"
        val moving = g.isActive && g.turn == side
        if (clock == null) return name + if (moving) " ●" else ""
        val main = if (side == "black") clock.blackMs else clock.whiteMs
        val t = if (g.isActive && g.ply < 2) fmtClock(g.clocks?.initialMs?.takeIf { it > 0 } ?: main) else fmtClock(main)
        val byo = if (moving && clock.byoyomiMs != null) " 秒読み ${(clock.byoyomiMs + 999) / 1000}" else ""
        return "$name $t$byo" + if (moving) " ●" else ""
    }

    // MARK: who / texts

    /** The one game on the site (one at a time, first come first served): active first, else open / offered. */
    fun liveGame(games: List<ShogiGame>): ShogiGame? =
        games.firstOrNull { it.status == "active" } ?: games.firstOrNull { it.status == "open" || it.status == "offered" }

    fun myColor(g: ShogiGame, me: String?): String? = when {
        me.isNullOrEmpty() -> null
        // A game against oneself (test): I play the side to move, every move.
        g.black?.userId == me && g.white?.userId == me -> g.turn.takeIf { it == "black" || it == "white" } ?: "black"
        g.black?.userId == me -> "black"
        g.white?.userId == me -> "white"
        else -> null
    }

    const val BEAGLE_NAME = "ビーグル"

    /** ビーグル戦: the beagle (the site's system account, name 「ビーグル」) is one of the two sides. */
    fun beagleSide(g: ShogiGame): String? = when {
        g.black?.name == BEAGLE_NAME -> "black"
        g.white?.name == BEAGLE_NAME -> "white"
        else -> null
    }


    private val END_REASON = mapOf(
        "resign" to "投了", "checkmate" to "詰み", "timeout" to "時間切れ", "sennichite" to "千日手",
        "perpetual_check" to "連続王手の千日手", "abandon" to "放置", "aborted" to "中断",
        "cancelled" to "取り下げ", "declined" to "お断り", "expired" to "期限切れ",
    )

    fun endReasonLabel(r: String?) = r?.let { END_REASON[it] ?: it } ?: ""

    /** 「☗mazzo の勝ち（投了）・87 手」. */
    fun resultText(g: ShogiGame): String {
        val how = endReasonLabel(g.endReason)
        return when (g.result) {
            null -> if (how.isNotEmpty()) "$how・${g.ply} 手" else "${g.ply} 手"
            "draw" -> "引き分け（$how）・${g.ply} 手"
            else -> {
                val w = if (g.result == "black") "☗${g.black?.name ?: "?"}" else "☖${g.white?.name ?: "?"}"
                "$w の勝ち（$how）・${g.ply} 手"
            }
        }
    }

    fun vsText(g: ShogiGame) = "☗${g.black?.name ?: "?"} vs ☖${g.white?.name ?: "?"}"

    // MARK: the board bridge (bridge_version 1)

    sealed interface BoardOut {
        data object Ready : BoardOut
        data class Move(val usi: String, val label: String) : BoardOut
        data class Haptic(val kind: String) : BoardOut
        data class Flip(val orientation: String) : BoardOut
        data class Size(val height: Int) : BoardOut
        data object Close : BoardOut
        data class Error(val message: String) : BoardOut
    }

    private val USI = Regex("^(?:[1-9][a-i][1-9][a-i]\\+?|[RBGSNLP]\\*[1-9][a-i])$")

    /** `ShogiBridge.postMessage(json)` → a message. Anything malformed, of another version or
     *  type is dropped (the page is a drawing; it never gets to ask for more). */
    fun parseBoard(json: String): BoardOut? {
        if (json.length > 4000) return null
        val o = runCatching { ApiJson.parseToJsonElement(json).jsonObject }.getOrNull() ?: return null
        fun str(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        if ((o["v"] as? JsonPrimitive)?.intOrNull != BRIDGE_VERSION) return null
        return when (str("type")) {
            "ready" -> BoardOut.Ready
            "move" -> {
                val usi = str("usi")?.takeIf { USI.matches(it) } ?: return null
                BoardOut.Move(usi, str("label")?.take(40) ?: "")
            }
            "haptic" -> str("kind")?.takeIf { it == "select" || it == "move" || it == "error" }?.let { BoardOut.Haptic(it) }
            "flip" -> str("orientation")?.takeIf { it == "black" || it == "white" }?.let { BoardOut.Flip(it) }
            "size" -> (o["height"] as? JsonPrimitive)?.doubleOrNull?.takeIf { it > 0 && it < 5000 }?.let { BoardOut.Size(kotlin.math.ceil(it).toInt()) }
            "close" -> BoardOut.Close
            "error" -> BoardOut.Error(str("message")?.take(200) ?: "")
            else -> null
        }
    }

    /** What the app tells the board (`window.shogiBoard.receive(msg)`). */
    fun stateMessage(
        sfen: String,
        myColor: String?,
        canMove: Boolean,
        lastMove: ShogiLastMove?,
        orientation: String?,
        confirmMove: Boolean,
        moveHints: Boolean,
        compact: Boolean,
        theme: String,
        topLabel: String?,
        bottomLabel: String?,
        hideBand: Boolean = false,
    ): JsonObject = buildJsonObject {
        put("type", "state")
        put("sfen", sfen)
        if (myColor != null) put("my_color", myColor) else put("my_color", null as String?)
        put("can_move", canMove)
        if (lastMove != null) putJsonObject("last_move") { put("usi", lastMove.usi); put("label", lastMove.label) }
        else put("last_move", null as String?)
        if (orientation != null) put("orientation", orientation)
        putJsonObject("settings") { put("confirm_move", confirmMove); put("move_hints", moveHints) }
        put("compact", compact)
        put("theme", theme)
        if (topLabel != null) put("top_label", topLabel)
        if (bottomLabel != null) put("bottom_label", bottomLabel)
        put("show_close", false)
        // The app shows the last move in its own band (and ⇅ in its menu).
        if (hideBand) put("hide_band", true)
    }

    /** The board fits itself into this many CSS px (bridge `max_height`). */
    fun withMaxHeight(state: JsonObject, maxHeight: Int?): JsonObject =
        if (maxHeight == null || maxHeight <= 0) state else JsonObject(state + ("max_height" to JsonPrimitive(maxHeight)))

    fun labelsMessage(top: String, bottom: String): JsonObject = buildJsonObject {
        put("type", "labels"); put("top_label", top); put("bottom_label", bottom)
    }

    fun themeMessage(theme: String): JsonObject = buildJsonObject { put("type", "theme"); put("theme", theme) }

    /** The JS that hands a message to the board (the JSON goes in as a string literal). */
    fun receiveScript(msg: JsonObject): String =
        "window.shogiBoard&&window.shogiBoard.receive(${JsonPrimitive(msg.toString())});"

    // MARK: the chat card's little board

    /** SFEN → 81 cells from the top-left (9筋1段 first): 0 empty, 1 先手, 2 後手. */
    fun miniCells(sfen: String): IntArray {
        val out = IntArray(81)
        var i = 0
        for (ch in sfen.substringBefore(' ')) {
            if (i >= 81) break
            when {
                ch == '/' || ch == '+' -> Unit
                ch.isDigit() -> i += ch - '0'
                ch.isLetter() -> { out[i] = if (ch.isUpperCase()) 1 else 2; i++ }
            }
        }
        return out
    }

    // MARK: a tiny mover (demo only: the server is the referee everywhere else)

    /** Play `usi` on `sfen` without checking legality; null when it cannot be read. */
    fun applyUsi(sfen: String, usi: String): String? {
        val parts = sfen.trim().split(' ')
        if (parts.size < 3) return null
        val board = Array(9) { arrayOfNulls<String>(9) }
        val rows = parts[0].split('/')
        if (rows.size != 9) return null
        for ((r, row) in rows.withIndex()) {
            var c = 0
            var promo = false
            for (ch in row) {
                when {
                    ch == '+' -> promo = true
                    ch.isDigit() -> c += ch - '0'
                    else -> { if (c > 8) return null; board[r][c] = (if (promo) "+" else "") + ch; c++; promo = false }
                }
            }
        }
        val side = parts[1]
        val black = side == "b"
        val hands = linkedMapOf<Char, Int>()
        if (parts[2] != "-") {
            var n = 0
            for (ch in parts[2]) if (ch.isDigit()) n = n * 10 + (ch - '0') else { hands[ch] = (hands[ch] ?: 0) + maxOf(1, n); n = 0 }
        }
        fun sq(s: String): Pair<Int, Int>? {
            if (s.length != 2) return null
            val file = s[0] - '0'; val rank = s[1] - 'a'
            if (file !in 1..9 || rank !in 0..8) return null
            return rank to (9 - file)
        }
        if (usi.length >= 4 && usi[1] == '*') {
            val (r, c) = sq(usi.substring(2, 4)) ?: return null
            val p = if (black) usi[0].uppercaseChar() else usi[0].lowercaseChar()
            val have = hands[p] ?: 0
            if (have <= 0 || board[r][c] != null) return null
            if (have == 1) hands.remove(p) else hands[p] = have - 1
            board[r][c] = p.toString()
        } else {
            if (usi.length < 4) return null
            val (fr, fc) = sq(usi.substring(0, 2)) ?: return null
            val (tr, tc) = sq(usi.substring(2, 4)) ?: return null
            val piece = board[fr][fc] ?: return null
            board[tr][tc]?.let { cap ->
                val base = cap.last()
                val mine = if (black) base.uppercaseChar() else base.lowercaseChar()
                hands[mine] = (hands[mine] ?: 0) + 1
            }
            board[fr][fc] = null
            board[tr][tc] = if (usi.endsWith("+") && !piece.startsWith("+")) "+$piece" else piece
        }
        val sb = StringBuilder()
        for (r in 0..8) {
            if (r > 0) sb.append('/')
            var empty = 0
            for (c in 0..8) {
                val p = board[r][c]
                if (p == null) { empty++; continue }
                if (empty > 0) { sb.append(empty); empty = 0 }
                sb.append(p)
            }
            if (empty > 0) sb.append(empty)
        }
        val order = "RBGSNLPrbgsnlp"
        val hand = order.mapNotNull { ch -> hands[ch]?.takeIf { it > 0 }?.let { n -> (if (n > 1) "$n" else "") + ch } }.joinToString("")
        val moveNo = (parts.getOrNull(3)?.toIntOrNull() ?: 1) + 1
        return "$sb ${if (black) "w" else "b"} ${hand.ifEmpty { "-" }} $moveNo"
    }

    /** Settings sent as one object (tests read it back). */
    fun settingsOf(msg: JsonObject): Pair<Boolean?, Boolean?> {
        val s = msg["settings"] as? JsonObject ?: return null to null
        return (s["confirm_move"] as? JsonPrimitive)?.booleanOrNull to (s["move_hints"] as? JsonPrimitive)?.booleanOrNull
    }
}
