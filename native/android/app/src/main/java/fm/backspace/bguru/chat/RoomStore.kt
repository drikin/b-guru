package fm.backspace.bguru.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.random.Random

/** The club room (ルーム, 部室) — docs/room-client-spec.md. Main thread only, like VoiceStore.
 *
 *  Who is in the house comes from GET /api/agent/room and the stream's `room` events.
 *  In the room view I walk locally at once (BFS / D-pad, one tile per STEP_MS) and send
 *  every step as a fire-and-forget POST move; a refused step resyncs from the server.
 *  Everyone else walks one tile at a time to where the server says they are.
 *  The proximity voice (volumes + who may receive my mic) is applied through VoiceStore. */
class RoomStore(private val api: ApiClient, private val voice: VoiceStore) {
    enum class Dir(val dx: Int, val dy: Int) { UP(0, -1), DOWN(0, 1), LEFT(-1, 0), RIGHT(1, 0) }

    class Look(val skin: Long, val hair: Long, val shirt: Long, val pants: Long)
    class Bubble(val text: String, val until: Long)
    class Floating(val emoji: String, val t0: Long, val small: Boolean = false)
    class Actor(val id: String, x: Int, y: Int) {
        var x = x; var y = y
        var fx = x.toFloat(); var fy = y.toFloat()
        var dir = Dir.DOWN
        var step = 0
        var fromX = x; var fromY = y
        /** 0…1 while moving one tile, null when standing. */
        var moveT: Float? = null
        val path = ArrayDeque<Dir>()
        var bubble: Bubble? = null
        val reacts = mutableListOf<Floating>()
        val look = lookFor(id)
    }
    class Beagle(var x: Int, val y: Int, val minX: Int, val maxX: Int) {
        var fx = x.toFloat(); var frame = 0; var flip = false; var bubble: Bubble? = null; var t = 0L
    }

    var enabled by mutableStateOf(false); private set
    var map by mutableStateOf<RoomMap?>(null); private set
    /** Everyone in the house (server view; my own entry carries my local position). */
    var members by mutableStateOf<List<RoomMember>>(emptyList()); private set
    var me by mutableStateOf<String?>(null); private set
    var reactions by mutableStateOf(DEFAULT_REACTIONS); private set
    /** Showing the room view (the chat tab's テキスト｜ルーム switch). Always starts in テキスト. */
    var roomView by mutableStateOf(false); private set
    /** 🎧 聞いている (true) / 👀 見るだけ (false) — what entering asks for. */
    var listening by mutableStateOf(true); private set
    var micBusy by mutableStateOf(false); private set
    /** One line under the room controls (refusals, 429 texts). */
    var notice by mutableStateOf<String?>(null)
    var hint by mutableStateOf(false); private set
    var demo = false; private set

    /** Plain (non-state) animation state, read by the Canvas every frame. */
    val actors = HashMap<String, Actor>()
    var beagle: Beagle? = null; private set
    /** Directions held on the D-pad / keyboard (the last one pressed wins). */
    private val held = mutableListOf<Dir>()
    /** Walking in from the door after enter: those steps are not sent (the server has me at the end). */
    private var entering: RoomPoint? = null
    private var path = "/api/agent/room"
    private val mem = LinkedHashMap<String, RoomMember>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var resyncJob: Job? = null
    private var hintJob: Job? = null
    private var request = 0
    private var ownReacts = mutableListOf<Pair<String, Long>>()

    val myMember: RoomMember? get() = me?.let { members.firstOrNull { m -> m.userId == it } }
    val myActor: Actor? get() = me?.let(actors::get)
    /** I am walking (or about to): the view steps me to the end even while it is off screen,
     *  so the others (and the proximity voice) see the whole walk. */
    val iAmWalking: Boolean get() = held.isNotEmpty() || entering != null || myActor?.let { it.moveT != null || it.path.isNotEmpty() } == true

    // MARK: setup

    fun configure(caps: Capabilities?) {
        if (demo) return
        enabled = caps?.roomEnabled ?: false
        path = caps?.roomPath ?: "/api/agent/room"
        if (enabled) {
            hookVoice()
            scope.launch { reload() }
        } else {
            voice.proximity = null
            voice.allowedListeners = null
            roomView = false
        }
    }

    private fun hookVoice() {
        voice.proximity = ::volumeFor
        voice.allowedListeners = ::allowedListeners
    }

    /** GET and replace everything (first load and after every reconnect). */
    suspend fun reload() {
        if (!enabled || demo) return
        val s = try {
            api.room(path)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError.Http) {
            if (e.status == 404) { enabled = false; roomView = false; voice.proximity = null; voice.allowedListeners = null }
            return
        } catch (_: Exception) {
            return
        }
        applySnapshot(s, snapMe = false)
    }

    private fun applySnapshot(s: RoomStateResponse, snapMe: Boolean) {
        map = s.map
        if (s.me.isNotEmpty()) me = s.me
        if (s.reactions.isNotEmpty()) reactions = s.reactions
        setupBeagle(s.map)
        val first = mem.isEmpty()
        val old = HashMap(mem)
        mem.clear()
        for (m in s.members) mem[m.userId] = m
        actors.keys.retainAll(mem.keys)
        for (m in s.members) {
            if (m.userId == me) mine(old[m.userId], m, snap = snapMe || first) else others(old[m.userId], m, snap = first)
        }
        publish()
    }

    /** Stream `room` event. */
    fun apply(json: String) {
        if (!enabled || demo) return
        val e = runCatching { ApiJson.decodeFromString<RoomEventData>(json) }.getOrNull() ?: return
        when (e.action) {
            "join", "update" -> e.member?.let(::upsert)
            "leave" -> e.member?.let { m ->
                if (m.userId == me) return
                mem.remove(m.userId)
                actors.remove(m.userId)
                publish()
            }
            "react" -> {
                val who = e.userId ?: return
                val emoji = e.emoji ?: return
                if (who == me) {
                    // My own reaction is shown at once when I press it; skip the echo.
                    val now = now()
                    ownReacts.removeAll { now - it.second > 4000 }
                    val i = ownReacts.indexOfFirst { it.first == emoji }
                    if (i >= 0) { ownReacts.removeAt(i); return }
                }
                showReact(who, emoji, e.to)
            }
        }
    }

    private fun upsert(m: RoomMember) {
        val prev = mem[m.userId]
        mem[m.userId] = m
        if (m.userId == me) mine(prev, m, snap = false) else others(prev, m, snap = false)
        publish()
    }

    /** Someone else: walk them to where the server has them, one tile at a time. */
    private fun others(prev: RoomMember?, m: RoomMember, snap: Boolean) {
        val a = actors[m.userId]
        if (a == null || snap || !roomView) {
            val n = a ?: Actor(m.userId, m.x, m.y).also { actors[m.userId] = it }
            place(n, m.x, m.y)
            n.dir = if (m.inRoom) Dir.DOWN else Dir.UP
            return
        }
        if (prev != null && !prev.inRoom && m.inRoom) {
            // Came into the room view: in through the door.
            val door = map?.door ?: RoomPoint(m.x, m.y)
            place(a, door.x, door.y)
            a.dir = Dir.UP
            walk(a, m.x, m.y)
            return
        }
        if (!m.inRoom) {
            place(a, m.x, m.y)
            a.dir = Dir.UP
            return
        }
        if (a.x == m.x && a.y == m.y && a.path.isEmpty()) return
        walk(a, m.x, m.y)
    }

    private fun walk(a: Actor, tx: Int, ty: Int) {
        val p = bfs(a.x, a.y, tx, ty, who = null)
        a.path.clear()
        if (p.isEmpty() || p.size > 24) place(a, tx, ty) else a.path.addAll(p)
    }

    /** My own entry: state (listening, mic, mode) follows the server; my position does not
     *  while I am in the room view (I walk locally; echoes of my steps arrive late). */
    private fun mine(prev: RoomMember?, m: RoomMember, snap: Boolean) {
        val a = actors[m.userId] ?: Actor(m.userId, m.x, m.y).also { actors[m.userId] = it; place(it, m.x, m.y) }
        if (!m.inRoom) {
            if (roomView && requestInFlight == 0 && prev?.inRoom == true) {
                // The server put me back at a chat seat (another device, or I was gone too long).
                roomView = false
                held.clear()
                voice.leave()
            }
            place(a, m.x, m.y)
            a.dir = Dir.UP
        } else if (snap || !roomView) {
            if (a.moveT == null && a.path.isEmpty() && entering == null) place(a, m.x, m.y)
        }
        // Mic turned off by the server (away 30 min, a speaker limit after a move).
        if (!m.mic && voice.micOn && !micBusy && !voice.micBusy && prev?.mic == true) {
            voice.setMic(false)
            notice = "マイクがオフになりました（離席が続いたか、話せる人数の上限のため）"
        }
    }

    private var requestInFlight = 0

    private fun place(a: Actor, x: Int, y: Int) {
        wake()
        a.path.clear()
        a.moveT = null
        a.x = x; a.y = y; a.fx = x.toFloat(); a.fy = y.toFloat(); a.step = 0
    }

    /** Members to the UI (my entry with my local position), then the voice. */
    private fun publish() {
        wake()
        val mine = myActor
        members = mem.values.map { m ->
            if (m.userId == me && mine != null && m.inRoom && roomView) m.copy(x = mine.x, y = mine.y) else m
        }
        voice.proximityChanged()
    }

    // MARK: map

    fun tileAt(x: Int, y: Int): Char = map?.tiles?.getOrNull(y)?.getOrNull(x) ?: '#'
    fun walkable(x: Int, y: Int): Boolean = tileAt(x, y) !in SOLID
    fun zoneAt(x: Int, y: Int): RoomZone? = map?.zones?.firstOrNull { it.contains(x, y) }

    /** src/lib/room-map.ts audibility(), ported exactly. */
    fun audibility(lx: Int, ly: Int, sx: Int, sy: Int): Double {
        val ls = zoneAt(lx, ly)
        val sp = zoneAt(sx, sy)
        if (sp?.kind == "stage") return 1.0
        if (ls?.kind == "table" || sp?.kind == "table") return if (ls == sp) 1.0 else 0.0
        val r = (map?.hearRadius ?: 4).toDouble()
        val d = hypot((lx - sx).toDouble(), (ly - sy).toDouble())
        if (d > r) return 0.0
        return max(0.15, min(1.0, 1 - (d - 1) / r))
    }

    private fun memberOf(id: String): RoomMember? = members.firstOrNull { it.userId == id }

    /** How loud [id] plays for me: audibility while both of us are in the room view, else 0. */
    fun volumeFor(id: String): Double {
        val mine = me?.let(::memberOf) ?: return 0.0
        val them = memberOf(id) ?: return 0.0
        if (!mine.inRoom || !them.inRoom || !roomView) return 0.0
        return audibility(mine.x, mine.y, them.x, them.y)
    }

    /** Who may receive my mic: in the room view, listening, and would hear me where I stand. */
    fun allowedListeners(): Set<String> {
        val mine = me?.let(::memberOf) ?: return emptySet()
        if (!mine.inRoom || !roomView) return emptySet()
        return members.filter { it.userId != me && it.inRoom && it.listening && audibility(it.x, it.y, mine.x, mine.y) > 0 }
            .map { it.userId }.toSet()
    }

    /** People standing in the room view (text-mode people sit at seats and do not block). */
    private fun occupied(x: Int, y: Int, who: Actor?): Boolean =
        mem.values.any { m -> m.inRoom && m.userId != who?.id && actors[m.userId]?.let { it.x == x && it.y == y } == true }

    /** Shortest 4-way path. `who` (me) avoids people standing in the way; others ignore them. */
    fun bfs(sx: Int, sy: Int, tx: Int, ty: Int, who: Actor?): List<Dir> {
        if (sx == tx && sy == ty) return emptyList()
        if (!walkable(tx, ty)) return emptyList()
        val w = map?.w ?: 32
        val prev = HashMap<Int, Triple<Int, Int, Dir>?>()
        prev[sy * 1000 + sx] = null
        val q = ArrayDeque<Pair<Int, Int>>()
        q.add(sx to sy)
        var found = false
        while (q.isNotEmpty()) {
            val (x, y) = q.removeFirst()
            if (x == tx && y == ty) { found = true; break }
            for (d in Dir.entries) {
                val nx = x + d.dx; val ny = y + d.dy
                val k = ny * 1000 + nx
                if (nx < 0 || ny < 0 || nx >= w || prev.containsKey(k) || !walkable(nx, ny)) continue
                if (who != null && occupied(nx, ny, who) && !(nx == tx && ny == ty)) continue
                prev[k] = Triple(x, y, d)
                q.add(nx to ny)
            }
        }
        if (!found) return emptyList()
        val out = ArrayList<Dir>()
        var k = ty * 1000 + tx
        while (true) {
            val p = prev[k] ?: break
            out.add(0, p.third)
            k = p.second * 1000 + p.first
        }
        return out
    }

    private fun setupBeagle(m: RoomMap) {
        if (beagle != null) return
        var minX = Int.MAX_VALUE; var maxX = -1; var bedY = -1
        m.tiles.forEachIndexed { y, row -> row.forEachIndexed { x, c -> if (c == 'b') { minX = min(minX, x); maxX = max(maxX, x); bedY = y } } }
        if (bedY < 1) return
        beagle = Beagle(minX, bedY - 1, minX - 2, maxX + 1)
    }

    // MARK: actions

    private fun body(action: String, extra: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit = {}): JsonObject =
        buildJsonObject { put("action", action); extra() }

    private suspend fun post(b: JsonObject): RoomActionResponse = api.roomAction(b, path)

    private fun errorText(e: Exception, fallback: String): String = when (e) {
        is ApiError.Http -> e.serverMessage ?: fallback
        is ApiError.Unauthorized -> "ログインし直してください"
        is ApiError.Transport -> "ネットワークにつながりません"
        else -> fallback
    }

    /** ルームへ: come in through the door and walk to where I was last time. In the voice
     *  (mic off) unless 👀 見るだけ. */
    fun enter() {
        if (!enabled || roomView) return
        notice = null
        roomView = true
        showHint()
        val mine = myActor
        if (demo) {
            val door = map?.door ?: return
            val to = RoomPoint(13, 12)
            mem[me!!] = mem[me!!]!!.copy(mode = "room", x = to.x, y = to.y, listening = listening, mic = false)
            if (mine != null) startEntry(mine, door, to)
            publish()
            if (listening && voice.canJoin) voice.join()
            beagle?.bubble = Bubble("わん！", now() + 2500)
            return
        }
        val n = ++request
        requestInFlight++
        scope.launch {
            try {
                val r = post(body("enter") { put("listening", listening) })
                if (n != request || !roomView) return@launch
                val m = r.member ?: return@launch
                mem[m.userId] = m
                me = m.userId
                val a = actors[m.userId] ?: Actor(m.userId, m.x, m.y).also { actors[m.userId] = it }
                val from = r.from
                val to = r.to
                if (from != null && to != null) startEntry(a, from, to) else place(a, m.x, m.y)
                publish()
                if (m.listening) voice.join()
                beagle?.bubble = Bubble("わん！", now() + 2500)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (n != request) return@launch
                roomView = false
                notice = errorText(e, "ルームに入れませんでした")
            } finally {
                requestInFlight--
            }
        }
    }

    private fun startEntry(a: Actor, from: RoomPoint, to: RoomPoint) {
        place(a, from.x, from.y)
        a.dir = Dir.UP
        val p = bfs(from.x, from.y, to.x, to.y, a)
        if (p.isEmpty()) { place(a, to.x, to.y); entering = null; return }
        a.path.addAll(p)
        entering = to
        wake()
    }

    /** The user moved during the entry walk: jump to where the server has me, then go on. */
    private fun finishEntry() {
        val to = entering ?: return
        entering = null
        myActor?.let { place(it, to.x, to.y) }
    }

    /** テキスト: out of the voice, back to a chat seat. */
    fun toText() {
        if (!roomView) return
        roomView = false
        held.clear()
        entering = null
        myActor?.path?.clear()
        hint = false
        if (voice.micOn) voice.setMic(false)
        voice.leave()
        if (demo) {
            val seat = map?.seats?.getOrNull(5) ?: return
            mem[me!!] = mem[me!!]!!.copy(mode = "text", x = seat.x, y = seat.y, listening = false, mic = false)
            myActor?.let { place(it, seat.x, seat.y); it.dir = Dir.UP }
            publish()
            return
        }
        val n = ++request
        requestInFlight++
        scope.launch {
            try {
                val r = post(body("text"))
                if (n == request) r.member?.let(::upsert)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Off the voice already; the next reload settles the seat.
            } finally {
                requestInFlight--
            }
        }
    }

    /** 🎧 聞いている ⇄ 👀 見るだけ. */
    fun changeListening(on: Boolean) {
        listening = on
        if (!roomView) return
        notice = null
        if (!on) {
            if (voice.micOn) voice.setMic(false)
            voice.leave()
        }
        if (demo) {
            me?.let { id -> mem[id]?.let { mem[id] = it.copy(listening = on, mic = if (on) it.mic else false) } }
            publish()
            if (on && voice.canJoin) voice.join()
            return
        }
        scope.launch {
            try {
                val r = post(body("voice") { put("listening", on) })
                r.member?.let(::upsert)
                if (on && listening && roomView) voice.join()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                notice = errorText(e, "切り替えられませんでした")
            }
        }
    }

    /** Mic on asks the server first (speaker limits → its 429 text); off is immediate.
     *  The caller already holds RECORD_AUDIO. */
    fun setMic(on: Boolean) {
        if (micBusy) return
        notice = null
        if (!on) {
            voice.setMic(false)
            if (demo) { updateMine { it.copy(mic = false) }; return }
            scope.launch { runCatching { post(body("voice") { put("mic", false) }) }.getOrNull()?.member?.let(::upsert) }
            return
        }
        if (demo) {
            updateMine { it.copy(mic = true) }
            voice.setMic(true)
            return
        }
        micBusy = true
        scope.launch {
            try {
                val r = post(body("voice") { put("mic", true) })
                r.member?.let(::upsert)
                voice.setMic(true)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                notice = errorText(e, "マイクをオンにできませんでした")
            } finally {
                micBusy = false
            }
        }
    }

    private fun updateMine(f: (RoomMember) -> RoomMember) {
        val id = me ?: return
        mem[id]?.let { mem[id] = f(it) }
        publish()
    }

    fun react(emoji: String, to: String? = null) {
        val id = me ?: return
        showReact(id, emoji, to)
        if (demo) return
        ownReacts.add(emoji to now())
        scope.launch {
            try {
                post(body("react") { put("emoji", emoji); if (to != null) put("to", to) })
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e is ApiError.Http && e.status == 429) notice = e.serverMessage ?: "速すぎます"
            }
        }
    }

    private fun showReact(id: String, emoji: String, to: String?) {
        val t = now()
        wake()
        actors[id]?.reacts?.add(Floating(emoji, t))
        if (to != null) actors[to]?.reacts?.add(Floating("👋", t + 300, small = true))
    }

    /** A new chat message: a bubble over its author for 4.5 s (photo only → 📷). */
    fun onChat(m: ChatMessage) {
        if (!enabled) return
        val id = m.authorId ?: return
        val a = actors[id] ?: return
        val text = bubbleText(m.visibleBody, m.images.size) ?: return
        a.bubble = Bubble(text, now() + 4500)
        wake()
    }

    // MARK: walking (input)

    fun press(d: Dir) {
        if (!roomView) return
        wake()
        if (entering != null) finishEntry()
        held.remove(d)
        held.add(d)
        myActor?.path?.clear()
        hint = false
    }

    fun release(d: Dir) {
        held.remove(d)
    }

    /** A tap on the map: someone there → their id (the UI opens the menu); else walk there. */
    fun tap(tx: Int, ty: Int): String? {
        val a = myActor ?: return null
        if (!roomView) return null
        val who = mem.values.firstOrNull { it.userId != me && actors[it.userId]?.let { p -> p.x == tx && p.y == ty } == true }
        if (who != null) return who.userId
        hint = false
        if (entering != null) finishEntry()
        var target = tx to ty
        if (!walkable(tx, ty)) {
            val near = Dir.entries.map { (tx + it.dx) to (ty + it.dy) }.filter { (x, y) -> walkable(x, y) }
                .minByOrNull { (x, y) -> hypot((x - a.x).toDouble(), (y - a.y).toDouble()) } ?: return null
            target = near
        }
        a.path.clear()
        a.path.addAll(bfs(a.x, a.y, target.first, target.second, a))
        wake()
        return null
    }

    /** そばへ行く: to the free tile next to them closest to me. */
    fun goNear(id: String) {
        val a = myActor ?: return
        val t = actors[id] ?: return
        if (entering != null) finishEntry()
        val near = Dir.entries.map { (t.x + it.dx) to (t.y + it.dy) }
            .filter { (x, y) -> (x == a.x && y == a.y) || (walkable(x, y) && !occupied(x, y, a)) }
            .minByOrNull { (x, y) -> hypot((x - a.x).toDouble(), (y - a.y).toDouble()) } ?: return
        a.path.clear()
        a.path.addAll(bfs(a.x, a.y, near.first, near.second, a))
        wake()
    }

    private fun showHint() {
        hint = true
        hintJob?.cancel()
        hintJob = scope.launch { delay(9000); hint = false }
    }

    // MARK: frame loop (called by the room view while something moves)

    /** Nudged by anything that moves, appears or changes in the room: the view's frame
     *  loop sleeps while nothing animates and wakes on this (or at the next timed change). */
    private val wakeups = Channel<Unit>(Channel.CONFLATED)
    fun wake() { wakeups.trySend(Unit) }

    /** The view's loop, idle: wait for [wake] or [timeoutMs] (Long.MAX_VALUE = no timer). */
    suspend fun awaitWake(timeoutMs: Long) {
        if (timeoutMs == Long.MAX_VALUE) wakeups.receive() else withTimeoutOrNull(timeoutMs) { wakeups.receive() }
    }

    /** 0 when the next frame must be drawn (someone walking or about to, a reaction
     *  floating, the beagle easing); otherwise ms until the next timed change (a bubble
     *  ending, the beagle's next step, a demo character's next move). */
    fun idleMillis(): Long {
        if (held.isNotEmpty() || entering != null) return 0
        val now = now()
        var next = Long.MAX_VALUE
        for (a in actors.values) {
            if (a.moveT != null || a.path.isNotEmpty() || a.reacts.isNotEmpty()) return 0
            a.bubble?.let { next = min(next, it.until - now) }
        }
        beagle?.let { b ->
            if (abs(b.x - b.fx) > 0.02f) return 0
            next = min(next, 900 - b.t)
            b.bubble?.let { next = min(next, it.until - now) }
        }
        if (demo) for (n in npcs.values) { if (n.nextAt == 0L) return 0; next = min(next, n.nextAt - now) }
        return if (next <= 0) 0 else next
    }

    fun update(dt: Long) {
        val now = now()
        val myId = me
        var iMoved = false
        for (a in actors.values) {
            a.moveT?.let { t ->
                val nt = t + dt / STEP_MS.toFloat()
                a.moveT = if (nt >= 1f) null else nt
            }
            if (a.moveT == null) {
                val mine = a.id == myId
                val d = if (mine && held.isNotEmpty() && roomView) held.last() else a.path.removeFirstOrNull()
                if (d != null) {
                    val ok = stepTo(a, d, check = mine)
                    if (mine) {
                        if (ok) {
                            iMoved = true
                            if (entering == null) sendMove(a.x, a.y)
                        } else a.path.clear()
                    }
                }
                if (mine && entering != null && a.path.isEmpty() && a.moveT == null) entering = null
            }
            val t = a.moveT
            a.fx = if (t != null) a.fromX + (a.x - a.fromX) * t else a.x.toFloat()
            a.fy = if (t != null) a.fromY + (a.y - a.fromY) * t else a.y.toFloat()
            a.step = if (t != null) (if (t < 0.5f) 1 else 2) else 0
            if (a.bubble?.let { it.until < now } == true) a.bubble = null
            a.reacts.removeAll { now - it.t0 > REACT_MS }
        }
        if (iMoved) publish()
        beagle?.let { b ->
            b.t += dt
            if (b.t > 900) {
                b.t = 0
                val nx = b.x + if (Random.nextBoolean()) -1 else 1
                if (nx in b.minX..b.maxX && walkable(nx, b.y)) { b.flip = nx < b.x; b.x = nx }
                b.frame = b.frame xor 1
                if (Random.nextFloat() < 0.08f) b.bubble = Bubble("わん！", now + 1800)
            }
            b.fx += (b.x - b.fx) * 0.2f
            if (b.bubble?.let { it.until < now } == true) b.bubble = null
        }
        if (demo) demoTick(now)
    }

    private fun stepTo(a: Actor, d: Dir, check: Boolean): Boolean {
        a.dir = d
        val nx = a.x + d.dx; val ny = a.y + d.dy
        if (check && (!walkable(nx, ny) || occupied(nx, ny, a))) return false
        a.fromX = a.x; a.fromY = a.y
        a.x = nx; a.y = ny
        a.moveT = 0f
        return true
    }

    private fun sendMove(x: Int, y: Int) {
        if (demo) { updateMine { it.copy(x = x, y = y) }; return }
        val id = me ?: return
        mem[id]?.let { mem[id] = it.copy(x = x, y = y) }
        scope.launch {
            try {
                post(body("move") { put("x", x); put("y", y) })
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                resync()
            }
        }
    }

    /** A step was refused: take the server's view (and my position from it). */
    private fun resync() {
        if (resyncJob?.isActive == true) return
        resyncJob = scope.launch {
            delay(250)
            val s = runCatching { api.room(path) }.getOrNull() ?: return@launch
            held.clear()
            myActor?.path?.clear()
            entering = null
            applySnapshot(s, snapMe = true)
        }
    }

    fun close() {
        scope.cancel()
    }

    // MARK: demo (debug builds, `--ez demo true`): a local fake room, no server

    private class Npc(val home: String, var nextAt: Long = 0)
    private val npcs = HashMap<String, Npc>()
    private var demoChat: ((String, String, String) -> Unit)? = null

    fun loadDemo(say: (id: String, name: String, text: String) -> Unit) {
        demo = true
        enabled = true
        demoChat = say
        hookVoice()
        val m = demoMap()
        val members = listOf(
            RoomMember("me", "ドリキン", x = 11, y = 3, mode = "text"),
            RoomMember("mazzo", "mazzo", x = 5, y = 11, mode = "room", listening = true, mic = true),
            RoomMember("takuto", "takuto", x = 6, y = 14, mode = "room", listening = true),
            RoomMember("NORIO TAKAHASHI", "NORIO TAKAHASHI", x = 26, y = 3, mode = "room", listening = true, mic = true),
            RoomMember("tochi", "tochi", x = 16, y = 12, mode = "room", listening = true),
            RoomMember("ryu", "リュー", x = 19, y = 14, mode = "room", listening = false),
            RoomMember("chii", "ちい", x = 24, y = 9, mode = "room", listening = true, away = true),
            RoomMember("EIKO", "EIKO", x = 8, y = 3, mode = "text"),
            RoomMember("coban", "coban", x = 14, y = 6, mode = "text"),
        )
        npcs["mazzo"] = Npc("table"); npcs["takuto"] = Npc("table"); npcs["NORIO TAKAHASHI"] = Npc("stage")
        npcs["tochi"] = Npc("lounge"); npcs["ryu"] = Npc("lounge"); npcs["chii"] = Npc("free")
        npcs["EIKO"] = Npc("text"); npcs["coban"] = Npc("text")
        applySnapshot(RoomStateResponse(m, members, "me", DEFAULT_REACTIONS), snapMe = true)
    }

    private fun demoTick(now: Long) {
        for ((id, n) in npcs) {
            val a = actors[id] ?: continue
            val m = mem[id] ?: continue
            if (n.nextAt == 0L) n.nextAt = now + Random.nextLong(500, 4000)
            if (Random.nextFloat() < 0.0012f) showReact(id, DEFAULT_REACTIONS.random(), null)
            if (now > n.nextAt) {
                n.nextAt = now + Random.nextLong(3000, 9000)
                if (n.home != "text" && a.path.isEmpty() && Random.nextFloat() < 0.6f) {
                    val (tx, ty) = homeTarget(n.home)
                    val p = bfs(a.x, a.y, tx, ty, a).take(12)
                    a.path.addAll(p)
                    var x = a.x; var y = a.y
                    p.forEach { x += it.dx; y += it.dy }
                    mem[id] = m.copy(x = x, y = y)
                    publish()
                }
                if (Random.nextFloat() < 0.35f) {
                    val line = LINES[n.home]!!.random()
                    demoChat?.invoke(id, m.name, line)
                    if (n.home == "stage") mem.keys.filter { it != id && it != me }.forEach { q ->
                        if (Random.nextBoolean()) scope.launch { delay(Random.nextLong(300, 1200)); showReact(q, if (Random.nextBoolean()) "👏" else "🍻", null) }
                    }
                }
            }
        }
    }

    private fun homeTarget(home: String): Pair<Int, Int> = when (home) {
        "table" -> listOf(4 to 11, 5 to 11, 6 to 11, 7 to 11, 8 to 14, 9 to 14, 3 to 12, 10 to 13).random()
        "stage" -> listOf(24 to 2, 25 to 3, 27 to 3, 28 to 2, 26 to 4).random()
        "lounge" -> listOf(14 to 12, 16 to 13, 18 to 14, 20 to 12, 15 to 15, 17 to 11).random()
        else -> (Random.nextInt(2, 29)) to (Random.nextInt(8, 17))
    }

    companion object {
        const val STEP_MS = 170L
        const val REACT_MS = 1800L
        val DEFAULT_REACTIONS = listOf("👋", "❤️", "😂", "👏", "🎉", "🍻")
        private val SOLID = setOf('#', 'w', 'D', 'C', 'B', 'T', 'M', 'F', 'V', 'P')

        fun now(): Long = System.nanoTime() / 1_000_000

        private val SKINS = longArrayOf(0xFFF1C7A0, 0xFFE8B48C, 0xFFF4CFAA, 0xFFE2AC82, 0xFFF6D4B5, 0xFFC98E66, 0xFFA8714E)
        private val HAIRS = longArrayOf(0xFF3A2A20, 0xFF6B6B6B, 0xFF1E1A22, 0xFFCFCFCF, 0xFF5A3A22, 0xFF2B2B44, 0xFF8A4A2A, 0xFFC46A3A, 0xFFD9B25A)
        private val SHIRTS = longArrayOf(0xFFF2B24C, 0xFF4F81BD, 0xFF9BBB59, 0xFF8064A2, 0xFFC0504D, 0xFF4BACC6, 0xFFF3E9D8, 0xFFE07A9A, 0xFF3CCF74)
        private val PANTS = longArrayOf(0xFF2F3E5C, 0xFF333344, 0xFF3B3B46, 0xFF2A2A33, 0xFF3A2F2A, 0xFF6B4A8C, 0xFF43384A, 0xFF4A5A3A)

        /** FNV-1a over UTF-16 units, as src/lib/room-logic.ts hashId — same id, same look on every client. */
        fun hashId(id: String): Long {
            var h = 0x811c9dc5.toInt()
            for (c in id) {
                h = h xor c.code
                h *= 0x01000193
            }
            return h.toLong() and 0xFFFFFFFFL
        }

        fun lookFor(id: String): Look {
            val h = hashId(id)
            return Look(SKINS[(h % SKINS.size).toInt()], HAIRS[((h ushr 5) % HAIRS.size).toInt()],
                SHIRTS[((h ushr 10) % SHIRTS.size).toInt()], PANTS[((h ushr 15) % PANTS.size).toInt()])
        }

        /** Over-the-head text for a chat message (photo only → 📷), as room-logic.ts bubbleText. */
        fun bubbleText(body: String, images: Int): String? {
            val t = body.replace(Regex("\\s+"), " ").trim()
            if (t.isEmpty()) return if (images > 0) "📷" else null
            val cps = t.codePoints().toArray()
            return if (cps.size > 48) String(cps, 0, 47) + "…" else t
        }

        /** The 💤 ⌨️ 👀 🔊 🎧 mark before a name. */
        fun statusMark(m: RoomMember, speaking: Boolean): String = when {
            m.away -> "💤"
            !m.inRoom -> "⌨️"
            !m.listening -> "👀"
            speaking -> "🔊"
            else -> "🎧"
        }

        private val LINES = mapOf(
            "table" to listOf("次のオフ会、どこにします？", "議題 1：部活の名前", "それ賛成です", "資料はタイムラインに貼りますね"),
            "stage" to listOf("みなさん聞こえますかー", "乾杯しましょう！", "今日は集まってくれてありがとう"),
            "lounge" to listOf("このソファいいね", "新しいカメラ買った？", "わかる〜", "あとで写真送ります"),
            "free" to listOf("自販機なに売ってるんだろう", "こんばんは！", "ビーグルかわいい"),
            "text" to listOf("仕事しながら見てます", "テキストで失礼します〜", "その話気になる！", "あとで写真あげます"),
        )

        /** The same map as src/lib/room-map.ts (the demo has no server to fetch it from). */
        fun demoMap(): RoomMap {
            val w = 32; val h = 20
            val g = Array(h) { y -> CharArray(w) { x -> if (x == 0 || y == 0 || x == w - 1 || y == h - 1) '#' else '.' } }
            fun put(x: Int, y: Int, t: Char) { g[y][x] = t }
            fun rect(x0: Int, y0: Int, rw: Int, rh: Int, t: Char) { for (y in y0 until y0 + rh) for (x in x0 until x0 + rw) put(x, y, t) }
            listOf(3, 4, 9, 10, 15, 16, 21, 22).forEach { put(it, 0, 'w') }
            put(15, h - 1, 'D'); put(16, h - 1, 'D')
            rect(1, 1, 4, 1, 'B')
            rect(6, 2, 12, 1, 'C'); rect(6, 3, 12, 1, 's'); rect(6, 5, 12, 1, 'C'); rect(6, 6, 12, 1, 's')
            rect(23, 1, 8, 4, 'S'); put(26, 2, 'M')
            rect(4, 12, 6, 2, 'T')
            for (x in 4..9) { put(x, 11, 'c'); put(x, 14, 'c') }
            put(3, 12, 'c'); put(3, 13, 'c'); put(10, 12, 'c'); put(10, 13, 'c')
            rect(14, 11, 7, 6, ','); rect(15, 17, 5, 1, 'F')
            put(30, 8, 'V'); put(30, 9, 'V')
            listOf(1 to 18, 30 to 18, 1 to 8, 20 to 1).forEach { (x, y) -> put(x, y, 'P') }
            put(26, 17, 'b'); put(27, 17, 'b')
            val seats = buildList { for (y in listOf(3, 6)) for (x in 6 until 18) add(RoomPoint(x, y)) }
            return RoomMap(
                w, h, g.map { String(it) },
                zones = listOf(RoomZone("table", "会議テーブル", 2, 10, 10, 7), RoomZone("stage", "ステージ", 23, 1, 8, 4)),
                door = RoomPoint(15, 18), seats = seats, labels = listOf(RoomLabel("チャット席", 6, 1)), hearRadius = 4,
            )
        }
    }
}
