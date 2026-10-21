package fm.backspace.bguru.chat

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.time.Instant
import java.util.UUID

/** ☗ 将棋 (docs/shogi-spec.md) — the same model as the web's lib/shogi-client.ts. Main thread.
 *  The server is the referee: a move shows on the board at once (the board keeps it as
 *  「送信中」) and is settled by the reply or the stream; a 409 brings the newest game back. */
class ShogiStore(private val api: ApiClient, context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("shogi", Context.MODE_PRIVATE)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** On for this member (capabilities.features.shogi.enabled). */
    var enabled by mutableStateOf(false); private set
    /** May start / accept / play (the chat scope). */
    var canPlay by mutableStateOf(false); private set
    /** 🐶 ビーグルと対局 (practice) is on (capabilities.shogi.beagle). */
    var beagle by mutableStateOf(false); private set
    var basePath = "/api/agent/shogi"; private set
    var boardUrl = "/shogi-board/index.html"; private set

    var me by mutableStateOf<String?>(null); private set
    /** May accept my own open game (a test game against myself; GET games' me.self_play). */
    var selfPlay by mutableStateOf(false); private set
    var games by mutableStateOf<List<ShogiGame>>(emptyList()); private set
    /** 「☗ 将棋」 is the selected mode at the top of the chat. */
    var open by mutableStateOf(false)
    /** The game on the board (null = the lobby). */
    var selectedId by mutableStateOf<Long?>(null); private set
    var detail by mutableStateOf<ShogiGame?>(null); private set
    var busy by mutableStateOf(false); private set
    var notice by mutableStateOf<String?>(null)
    /** Server clock − this device's clock. */
    var skew by mutableLongStateOf(0L); private set
    /** Bumped when a notification / the chat card asks for the shogi screen (MainScreen shows the chat page). */
    var revealTick by mutableIntStateOf(0); private set

    var confirmMove by mutableStateOf(prefs.getBoolean("confirmMove", false)); private set
    var moveHints by mutableStateOf(prefs.getBoolean("moveHints", true)); private set

    /** The chat is in the foreground (its stream is up): only then do we send the watch signal. */
    var foreground = false

    /** Debug only: local sample games, nothing goes out. */
    var demo = false; private set

    fun configure(caps: Capabilities?) {
        val on = caps?.shogiEnabled == true
        enabled = on
        canPlay = caps?.canPlayShogi == true
        beagle = caps?.shogiBeagle == true
        caps?.let { basePath = it.shogiPath; boardUrl = it.shogiBoardUrl }
        if (!on) { open = false; selectedId = null; detail = null; games = emptyList(); return }
        load()
    }

    val selected: ShogiGame?
        get() = selectedId?.let { id -> detail?.takeIf { it.id == id } ?: games.firstOrNull { it.id == id } }

    fun myColorIn(g: ShogiGame) = ShogiLogic.myColor(g, me)

    /** Things waiting for me: offers to me + my games where it is my turn (the ☗ badge). */
    val waitingCount: Int
        get() = games.count { (it.status == "offered" && it.invitee?.userId == me) || (it.isActive && myColorIn(it) == it.turn) }

    val liveCount: Int get() = games.count { it.isActive }

    // MARK: loading

    fun load() {
        if (demo || !enabled) return
        scope.launch {
            try {
                val (status, r) = api.shogiGames(basePath)
                if (status == 404) { enabled = false; open = false; return@launch }
                if (status != 200 || r == null) return@launch
                me = r.me?.userId ?: me
                selfPlay = r.me?.selfPlay == true
                val list = r.games ?: emptyList()
                games = list.map { g -> games.firstOrNull { it.id == g.id && it.moves != null }?.let { old -> g.copy(moves = old.moves, kifUrl = old.kifUrl) } ?: g }
                list.firstOrNull()?.let { skew = ShogiLogic.skewOf(it.serverNow, System.currentTimeMillis(), skew) }
                selectedId?.let { loadDetail(it) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // offline: keep what we have; the stream's `ready` loads again
            }
        }
    }

    private fun loadDetail(id: Long) {
        if (demo) return
        scope.launch {
            try {
                val (status, r) = api.shogiGame(id, basePath)
                val g = r?.game
                if (status != 200 || g == null) {
                    if (selectedId == id) { detail = null; notice = r?.error ?: "対局が見つかりません" }
                    return@launch
                }
                if (selectedId != id) return@launch
                detail = g
                games = ShogiLogic.upsert(games, g)
                skew = ShogiLogic.skewOf(g.serverNow, System.currentTimeMillis(), skew)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) { }
        }
    }

    /** The stream's `event: shogi`. */
    fun apply(data: String) {
        val e = ShogiLogic.parseEvent(data) ?: return
        applyGame(e.action, e.game!!)
    }

    private fun applyGame(action: String, g: ShogiGame) {
        val before = games.firstOrNull { it.id == g.id }
        games = ShogiLogic.upsert(games, g)
        skew = ShogiLogic.skewOf(g.serverNow, System.currentTimeMillis(), skew)
        if (action == "offer" && g.invitee?.userId == me) {
            notice = "${g.creator.name} さんから対局の申し込みが届きました（${ShogiLogic.modeLabel(g.mode)}）"
        }
        // My offer was accepted: open that board (if the lobby is what is showing).
        if (g.isActive && before != null && !before.isActive && myColorIn(g) != null && selectedId == null) {
            notice = "対局が始まりました"
            select(g.id)
            return
        }
        val d = detail
        if (d != null && d.id == g.id) {
            val merged = ShogiLogic.mergeDetail(d, g)
            if (merged != null) detail = merged else loadDetail(g.id)
        }
    }

    // MARK: navigation

    fun select(id: Long?) {
        selectedId = id
        detail = detail?.takeIf { it.id == id }
        if (id != null) {
            if (demo) detail = games.firstOrNull { it.id == id }
            else loadDetail(id)
        }
    }

    /** From the chat card or a notification: the shogi screen at that game. */
    fun openGame(id: Long) {
        open = true
        select(id)
        revealTick++
    }

    fun setSettings(confirm: Boolean = confirmMove, hints: Boolean = moveHints) {
        confirmMove = confirm
        moveHints = hints
        prefs.edit().putBoolean("confirmMove", confirm).putBoolean("moveHints", hints).apply()
    }

    // MARK: actions

    private fun act(work: suspend () -> Pair<Int, ShogiReply?>, onOk: (Int, ShogiGame?) -> Unit = { _, _ -> }) {
        if (busy) return
        busy = true
        notice = null
        scope.launch {
            try {
                val (status, r) = work()
                r?.game?.let { applyGame("state", it) }
                if (status == 409 && r?.code == "busy") {
                    // One game at a time, site-wide: someone else's open / offered / active game is up.
                    val g = r.game
                    if (g != null) select(g.id)
                    notice = if (g != null) r.error ?: "対局は 1 局ずつです" else "対局は 1 局ずつです。募集中の対局を受けるか、対局中なら観戦してください"
                } else if (status >= 400) notice = r?.error ?: "うまくいきませんでした"
                else onOk(status, r?.game)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError.Unauthorized) {
                notice = "ログインし直してください"
            } catch (_: Exception) {
                notice = "通信できませんでした"
            } finally {
                busy = false
            }
        }
    }

    /** The one game on the site (docs/shogi-spec.md: one at a time, first come first served):
     *  open, offered or active. While there is one, nobody can start another. */
    val liveGame: ShogiGame?
        get() = ShogiLogic.liveGame(games)

    fun create(mode: String, inviteeUserId: String? = null, rematchOf: Long? = null, inviteeName: String? = null) {
        if (demo && liveGame != null) { notice = "対局は 1 局ずつです（デモ）"; select(liveGame!!.id); return }
        if (demo) { demoCreate(mode, inviteeUserId, inviteeName, rematchOf); return }
        act({ api.shogiCreate(mode, inviteeUserId, rematchOf, basePath) }) { _, g ->
            notice = if (g?.status == "offered") "${g.invitee?.name ?: "相手"} さんに申し込みました" else "募集しました（15 分）"
        }
    }

    /** ビーグル戦: starts at once (no offer / accept), active from the reply; opens its board.
     *  `rematchOf`: もう一局 (sides swapped). */
    fun startBeagle(mode: String, rematchOf: Long? = null) {
        if (demo) { demoBeagle(mode, rematchOf); return }
        act({ api.shogiCreate(mode, null, rematchOf, basePath, opponent = "beagle") }) { _, g ->
            if (g != null) { notice = "ビーグルとの対局が始まりました（先後は振り駒）"; select(g.id) }
        }
    }

    fun accept(id: Long) {
        if (demo) { demoAccept(id); return }
        act({ api.shogiAction(id, "accept", basePath) }) { _, _ -> select(id) }
    }

    fun decline(id: Long) = if (demo) demoEnd(id, "closed", "declined") else act({ api.shogiAction(id, "decline", basePath) })
    fun cancel(id: Long) = if (demo) demoEnd(id, if (games.firstOrNull { it.id == id }?.isActive == true) "ended" else "closed", if (games.firstOrNull { it.id == id }?.isActive == true) "aborted" else "cancelled") else act({ api.shogiAction(id, "cancel", basePath) })
    fun resign(id: Long) = if (demo) demoResign(id) else act({ api.shogiAction(id, "resign", basePath) })

    /** The board sent a move. Expected ply = the ply the board was showing. Sent once more with
     *  the same client_move_id if the reply is lost (the server never plays it twice). */
    fun move(id: Long, usi: String, label: String, expectedPly: Int) {
        if (demo) { demoMove(id, usi, label); return }
        val clientMoveId = UUID.randomUUID().toString().replace("-", "")
        scope.launch {
            var reply: Pair<Int, ShogiReply?>? = null
            for (attempt in 0..1) {
                try {
                    reply = api.shogiMove(id, usi, expectedPly, clientMoveId, basePath)
                    break
                } catch (e: CancellationException) {
                    throw e
                } catch (e: ApiError.Unauthorized) {
                    notice = "ログインし直してください"; break
                } catch (_: Exception) { }
            }
            val r = reply
            if (r == null) {
                notice = "通信できませんでした。もう一度指してください"
                // Puts the board back (a state message drops the board's 「送信中」 move).
                refreshBoard()
                loadDetail(id)
                return@launch
            }
            r.second?.game?.let { applyGame("state", it) }
            if (r.first >= 400) {
                notice = r.second?.error ?: "その手は指せませんでした"
                refreshBoard()
                loadDetail(id)
            }
        }
    }

    /** Bumped to make the board take the state again (after a refused move). */
    var boardEpoch by mutableIntStateOf(0); private set
    private fun refreshBoard() { boardEpoch++ }

    /** 観戦中の合図 (every 30 s while watching; players do not send it). */
    fun watch(id: Long) {
        if (demo || !foreground) return
        scope.launch {
            runCatching { api.shogiAction(id, "watch", basePath) }.getOrNull()?.second?.spectators?.let { n ->
                games = games.map { if (it.id == id) it.copy(spectators = n) else it }
                detail = detail?.let { if (it.id == id) it.copy(spectators = n) else it }
            }
        }
    }

    fun close() = scope.cancel()

    // MARK: demo (`--ez demo true`): nothing leaves the device

    /** `scenario` (`--es demo_shogi_game`): play (me vs mazzo, default) / watch / offer / open / none. */
    fun loadDemo(meId: String, meName: String, scenario: String = "play") {
        demo = true
        enabled = true
        canPlay = true
        beagle = true
        selfPlay = true
        me = meId
        val now = Instant.now()
        val iso = { ms: Long -> now.minusMillis(ms).toString() }
        fun p(id: String, name: String) = ShogiPlayer(id, name)
        val mine = listOf("7g7f", "3c3d", "2g2f", "8c8d")
        val watched = listOf("7g7f", "3c3d", "8h2b+", "3a2b", "B*4e")
        fun sfenAfter(moves: List<String>) = moves.fold(ShogiLogic.INITIAL_SFEN) { s, m -> ShogiLogic.applyUsi(s, m) ?: s }
        val labels = mapOf("8c8d" to "△8四歩", "B*4e" to "▲4五角打")
        val all = listOf(
            ShogiGame(12, "active", "blitz", creator = p("mazzo", "mazzo"), black = p(meId, meName), white = p("mazzo", "mazzo"),
                sfen = sfenAfter(mine), ply = 4, turn = "black", lastMove = ShogiLastMove("8c8d", labels["8c8d"]!!),
                clocks = ShogiClocks(571_000, 583_000, 30_000, 600_000), turnStartedAt = iso(4_000), serverNow = now.toString(),
                spectators = 3, createdAt = iso(120_000), startedAt = iso(110_000),
                moves = mine.mapIndexed { i, u -> ShogiMove(i + 1, u, "", sfenAfter(mine.take(i + 1))) }),
            ShogiGame(13, "active", "slow", creator = p("takuto", "takuto"), black = p("takuto", "takuto"), white = p("coban", "coban"),
                sfen = sfenAfter(watched), ply = 5, turn = "white", lastMove = ShogiLastMove("B*4e", labels["B*4e"]!!),
                turnStartedAt = iso(3_600_000), serverNow = now.toString(), spectators = 5, createdAt = iso(86_400_000), startedAt = iso(86_000_000)),
            ShogiGame(14, "offered", "slow", creator = p("NORIO", "NORIO TAKAHASHI"), invitee = p(meId, meName),
                serverNow = now.toString(), createdAt = iso(600_000), deadlineAt = now.plusSeconds(80_000).toString()),
            ShogiGame(15, "open", "blitz", creator = p("ちい", "ちい"), serverNow = now.toString(), createdAt = iso(60_000),
                deadlineAt = now.plusSeconds(840).toString()),
            ShogiGame(9, "ended", "blitz", creator = p(meId, meName), black = p("coban", "coban"), white = p(meId, meName),
                sfen = sfenAfter(watched), ply = 87, result = "white", endReason = "resign", serverNow = now.toString(),
                createdAt = iso(7_200_000), endedAt = iso(5_000_000)),
        )
        // One live game at a time (site-wide): the scenario picks which.
        val live = when (scenario) { "watch" -> 13L; "offer" -> 14L; "open" -> 15L; "none" -> -1L; else -> 12L }
        games = all.filter { it.isEnded || it.id == live }
    }

    /** The game the demo's chat card shows (the live one when it is in play). */
    val demoCardGame: Long? get() = games.firstOrNull { it.isActive }?.id

    private fun demoMove(id: Long, usi: String, label: String) {
        val g = games.firstOrNull { it.id == id } ?: return
        val next = ShogiLogic.applyUsi(g.sfen, usi) ?: run { refreshBoard(); return }
        val c = g.clocks?.let { cl ->
            val left = ShogiLogic.clockNow(g, 0, System.currentTimeMillis())
            if (g.turn == "black") cl.copy(blackMs = left?.blackMs ?: cl.blackMs) else cl.copy(whiteMs = left?.whiteMs ?: cl.whiteMs)
        }
        val ng = g.copy(sfen = next, ply = g.ply + 1, turn = if (g.turn == "black") "white" else "black",
            lastMove = ShogiLastMove(usi, label), clocks = c, turnStartedAt = Instant.now().toString(), serverNow = Instant.now().toString(),
            moves = (g.moves ?: emptyList()) + ShogiMove(g.ply + 1, usi, label, next))
        games = ShogiLogic.upsert(games, ng)
        if (detail?.id == id) detail = ng
    }

    /** Demo: an active game against the beagle (it does not move in the demo: it keeps 「考え中」). */
    private fun demoBeagle(mode: String, rematchOf: Long?) {
        if (rematchOf == null && liveGame != null) { notice = "対局は 1 局ずつです（デモ）"; select(liveGame!!.id); return }
        val id = (games.maxOfOrNull { it.id } ?: 0L) + 1
        val meP = ShogiPlayer(me ?: "me", "ドリキン")
        val dog = ShogiPlayer("beagle", ShogiLogic.BEAGLE_NAME, "/icon-192.png")
        val prev = rematchOf?.let { r -> games.firstOrNull { it.id == r } }
        val meBlack = prev?.let { it.black?.userId != me } ?: true
        val now = Instant.now().toString()
        val g = ShogiGame(id, "active", mode, creator = meP, invitee = dog, black = if (meBlack) meP else dog, white = if (meBlack) dog else meP,
            clocks = if (mode == "blitz") ShogiClocks(600_000, 600_000, 30_000, 600_000) else null,
            turnStartedAt = now, serverNow = now, createdAt = now, startedAt = now, rematchOf = rematchOf, moves = emptyList())
        games = listOf(g) + games
        notice = "ビーグルとの対局が始まりました（デモ: ビーグルは指しません）"
        select(id)
    }

    private fun demoEnd(id: Long, status: String, reason: String, result: String? = null) {
        val g = games.firstOrNull { it.id == id } ?: return
        val ng = g.copy(status = status, endReason = reason, result = result, endedAt = Instant.now().toString())
        games = ShogiLogic.upsert(games, ng)
        if (detail?.id == id) detail = ng
    }

    private fun demoResign(id: Long) {
        val g = games.firstOrNull { it.id == id } ?: return
        demoEnd(id, "ended", "resign", if (myColorIn(g) == "black") "white" else "black")
    }

    private fun demoAccept(id: Long) {
        val g = games.firstOrNull { it.id == id } ?: return
        val meP = ShogiPlayer(me ?: "me", g.invitee?.name ?: "ドリキン")
        // My own open game (self-play test): I am both sides.
        val other = if (g.creator.userId == me) g.creator else meP
        val ng = g.copy(status = "active", black = g.creator, white = other, sfen = ShogiLogic.INITIAL_SFEN, ply = 0, turn = "black",
            clocks = if (g.mode == "blitz") ShogiClocks(600_000, 600_000, 30_000, 600_000) else null,
            turnStartedAt = Instant.now().toString(), startedAt = Instant.now().toString(), moves = emptyList())
        games = ShogiLogic.upsert(games, ng)
        select(id)
    }

    private fun demoCreate(mode: String, inviteeId: String?, inviteeName: String?, rematchOf: Long?) {
        val id = (games.maxOfOrNull { it.id } ?: 0L) + 1
        val meP = ShogiPlayer(me ?: "me", "ドリキン")
        val g = ShogiGame(id, if (inviteeId != null) "offered" else "open", mode, creator = meP,
            invitee = inviteeId?.let { ShogiPlayer(it, inviteeName ?: it) }, rematchOf = rematchOf,
            createdAt = Instant.now().toString(), serverNow = Instant.now().toString())
        games = listOf(g) + games
        notice = if (inviteeId != null) "${inviteeName ?: "相手"} さんに申し込みました（デモ: 送っていません）" else "募集しました（デモ: 送っていません）"
        if (rematchOf != null) select(null)
    }
}
