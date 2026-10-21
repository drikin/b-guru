package fm.backspace.bguru.chat

import android.Manifest
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.foundation.layout.height
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** The club room UI (docs/room-client-spec.md): the テキスト｜ルーム switch, the banner shown
 *  in the text view (in place of the voice bar), and the 8-bit room itself — drawn in code
 *  on a Canvas at an integer pixel scale, ported from docs/room-prototype/bguru-room.html. */

private val RoomBg = Color(0xFF1D1820)
private val RoomPanelColor = Color(0xFF2A2230)
private val RoomFg = Color(0xFFF3E9D8)
private val RoomMuted = Color(0xFFB3A6B8)
private val Amber = Color(0xFFF2B24C)
private val VoiceGreen = Color(0xFF3CCF74)

/** Enter (with the Bluetooth permission ask the voice bar does) and the mic toggle (with the
 *  RECORD_AUDIO ask) — shared by the banner and the room panel. */
private class RoomActions(val enter: () -> Unit, val toggleMic: () -> Unit)

@Composable
private fun rememberRoomActions(room: RoomStore, voice: VoiceStore): RoomActions {
    val context = LocalContext.current
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) room.setMic(true) else room.notice = "マイクを使えません（設定でマイクを許可してください）"
    }
    val btPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { room.enter() }
    return remember(room, voice) {
        RoomActions(
            enter = {
                val needBt = room.listening && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && voice.bluetoothAudioConnected &&
                    ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED
                if (needBt) btPermission.launch(Manifest.permission.BLUETOOTH_CONNECT) else room.enter()
            },
            toggleMic = {
                when {
                    voice.micOn -> room.setMic(false)
                    voice.hasMicPermission -> room.setMic(true)
                    else -> micPermission.launch(Manifest.permission.RECORD_AUDIO)
                }
            },
        )
    }
}

/** テキスト｜ルーム, at the top of the chat. The ルーム tab shows how many are in the
 *  room's voice (and a green dot while someone talks) — the text view's way in. */
@Composable
fun RoomModeSwitch(room: RoomStore, voice: VoiceStore) {
    val actions = rememberRoomActions(room, voice)
    BackHandler(enabled = room.roomView) { room.toText() }
    val inVoice = room.members.count { it.inRoom && it.listening }
    val talking = voice.phase == VoiceStore.Phase.CONNECTED && voice.members.any { it.speaking }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        SingleChoiceSegmentedButtonRow(Modifier.width(196.dp).height(32.dp)) {
            SegmentedButton(selected = !room.roomView, onClick = { room.toText() }, shape = SegmentedButtonDefaults.itemShape(0, 2), icon = {}) {
                Text("テキスト", style = MaterialTheme.typography.labelSmall)
            }
            SegmentedButton(selected = room.roomView, onClick = { actions.enter() }, shape = SegmentedButtonDefaults.itemShape(1, 2), icon = {}) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(if (inVoice > 0) "ルーム 🎧$inVoice" else "ルーム", style = MaterialTheme.typography.labelSmall, maxLines = 1)
                    if (talking) Box(Modifier.size(7.dp).background(AccentGreen, CircleShape))
                }
            }
        }
        if (!room.roomView) room.notice?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
    }
}

/** Camera / scale of the last frame, for turning a tap into a tile. */
private class Camera { var zoom = 3f; var camX = 0f; var camY = 0f }

/** The room view: controls, the map, the reactions. */
@Composable
fun RoomPanel(room: RoomStore, voice: VoiceStore, modifier: Modifier = Modifier) {
    val actions = rememberRoomActions(room, voice)
    val me = room.myMember
    val zone = me?.let { room.zoneAt(it.x, it.y) }
    val focus = remember { FocusRequester() }
    // A physical keyboard attached (and open): arrows/WASD instead of the on-screen pad.
    val config = LocalConfiguration.current
    val hasKeyboard = config.keyboard == Configuration.KEYBOARD_QWERTY && config.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    Column(modifier.clipToBounds().background(RoomBg)) {
        // 🎧 / 👀, 🎙, where I am.
        Row(
            Modifier.fillMaxWidth().background(RoomPanelColor).padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            val listening = room.listening
            Chip(if (listening) "🎧 聞いている" else "👀 見るだけ", on = listening) { room.changeListening(!listening) }
            val micEnabled = listening && voice.phase == VoiceStore.Phase.CONNECTED && !room.micBusy && !voice.micBusy
            Chip(if (voice.micOn) "🎙 マイク オン" else "🎙 マイク オフ", on = voice.micOn, enabled = micEnabled, onClick = actions.toggleMic)
            if (voice.phase == VoiceStore.Phase.CONNECTING || voice.phase == VoiceStore.Phase.RECONNECTING) {
                Text("接続中…", color = RoomMuted, fontSize = 12.sp)
            }
            Spacer(Modifier.weight(1f))
            if (zone != null) {
                Text(
                    "${zone.name}にいます", color = VoiceGreen, fontSize = 12.sp, maxLines = 1,
                    modifier = Modifier.border(1.dp, VoiceGreen.copy(alpha = 0.6f), RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 2.dp),
                )
            }
        }
        (room.notice ?: voice.notice)?.let {
            Text(it, color = Amber, fontSize = 12.sp, modifier = Modifier.fillMaxWidth().background(RoomPanelColor).padding(horizontal = 10.dp, vertical = 2.dp))
        }
        Box(
            Modifier.weight(1f).fillMaxWidth()
                .focusRequester(focus)
                .focusable()
                .onKeyEvent { e -> roomKey(room, e.key, e.type == KeyEventType.KeyDown, e.type == KeyEventType.KeyUp) },
        ) {
            RoomCanvas(room, voice, focus = focus)
            if (room.hint) {
                Text(
                    "タップした場所へ歩きます。人をタップすると手を振れます",
                    color = RoomFg, fontSize = 12.sp,
                    modifier = Modifier.align(Alignment.TopCenter).padding(top = 8.dp)
                        .background(Color(0xCC120E14), RoundedCornerShape(6.dp)).padding(horizontal = 10.dp, vertical = 4.dp),
                )
            }
            if (!hasKeyboard) DPad(room, Modifier.align(Alignment.BottomEnd).padding(10.dp))
        }
        // Reactions (keys 1–6 on a keyboard).
        Row(
            Modifier.fillMaxWidth().background(RoomPanelColor).padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            room.reactions.take(6).forEach { e ->
                Box(
                    Modifier.size(40.dp).background(Color(0x22F3E9D8), RoundedCornerShape(8.dp))
                        .pointerInput(e) { detectTapGestures { room.react(e) } }
                        .semantics { contentDescription = "リアクション $e" },
                    contentAlignment = Alignment.Center,
                ) { Text(e, fontSize = 20.sp) }
            }
        }
    }
}

private fun roomKey(room: RoomStore, key: Key, down: Boolean, up: Boolean): Boolean {
    val d = when (key) {
        Key.DirectionUp, Key.W -> RoomStore.Dir.UP
        Key.DirectionDown, Key.S -> RoomStore.Dir.DOWN
        Key.DirectionLeft, Key.A -> RoomStore.Dir.LEFT
        Key.DirectionRight, Key.D -> RoomStore.Dir.RIGHT
        else -> null
    }
    if (d != null) {
        if (down) room.press(d) else if (up) room.release(d)
        return true
    }
    val i = listOf(Key.One, Key.Two, Key.Three, Key.Four, Key.Five, Key.Six).indexOf(key)
    if (i >= 0) {
        if (down) room.reactions.getOrNull(i)?.let { room.react(it) }
        return true
    }
    return false
}

@Composable
private fun Chip(text: String, on: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        Modifier
            .background(if (on) VoiceGreen.copy(alpha = 0.22f) else Color(0x22F3E9D8), RoundedCornerShape(6.dp))
            .border(1.dp, if (on) VoiceGreen else Color(0x55F3E9D8), RoundedCornerShape(6.dp))
            .pointerInput(enabled, onClick) { detectTapGestures { if (enabled) onClick() } }
            .padding(horizontal = 8.dp, vertical = 5.dp),
    ) { Text(text, color = if (enabled) RoomFg else RoomMuted, fontSize = 13.sp, maxLines = 1) }
}

/** On-screen pad: press and hold to keep walking. */
@Composable
private fun DPad(room: RoomStore, modifier: Modifier) {
    @Composable
    fun Key(d: RoomStore.Dir, label: String, x: Int, y: Int) {
        Box(
            Modifier.offset(x.dp, y.dp).size(40.dp)
                .background(Color(0x99120E14), RoundedCornerShape(8.dp))
                .border(1.dp, Color(0x66F3E9D8), RoundedCornerShape(8.dp))
                .pointerInput(d) {
                    awaitEachGesture {
                        awaitFirstDown().consume()
                        room.press(d)
                        try { waitForUpOrCancellation() } finally { room.release(d) }
                    }
                }
                .semantics { contentDescription = label },
            contentAlignment = Alignment.Center,
        ) { Text(label, color = RoomFg, fontSize = 16.sp) }
    }
    Box(modifier.size(120.dp)) {
        Key(RoomStore.Dir.UP, "▲", 40, 0)
        Key(RoomStore.Dir.LEFT, "◀", 0, 40)
        Key(RoomStore.Dir.RIGHT, "▶", 80, 40)
        Key(RoomStore.Dir.DOWN, "▼", 40, 80)
    }
}

@Composable
private fun RoomCanvas(room: RoomStore, voice: VoiceStore, focus: FocusRequester) {
    var frame by remember { mutableLongStateOf(0L) }
    val cam = remember { Camera() }
    val painter = remember { RoomPainter() }
    var menu by remember { mutableStateOf<Pair<String, Offset>?>(null) }
    val density = LocalDensity.current
    // Every frame while something moves; asleep (no frames at all) while the room is
    // still, until RoomStore.wake() or the next timed change (a bubble ending, the beagle).
    LaunchedEffect(room) {
        var last = 0L
        var slept = false
        while (true) {
            withFrameMillis { t ->
                // After a sleep nothing was walking: pass the real gap (the beagle's clock).
                val dt = if (last == 0L) 16L else min(if (slept) 2_000L else 100L, t - last)
                last = t
                slept = false
                room.update(dt)
                frame = t
            }
            val idle = room.idleMillis()
            if (idle > 0) { room.awaitWake(idle); slept = true }
        }
    }
    Box(Modifier.fillMaxSize()) {
        Canvas(
            Modifier.fillMaxSize().clipToBounds().pointerInput(room) {
                detectTapGestures { off ->
                    runCatching { focus.requestFocus() }
                    menu = null
                    val tx = floor((off.x / cam.zoom + cam.camX) / T).toInt()
                    val ty = floor((off.y / cam.zoom + cam.camY) / T).toInt()
                    room.tap(tx, ty)?.let { menu = it to off }
                }
            },
        ) {
            if (frame < 0) return@Canvas // read every frame: redraws as the room moves
            val speaking = buildSet {
                voice.members.forEach { if (it.speaking) add(it.userId) }
                if (voice.micActive) room.me?.let(::add)
            }
            val widthDp = size.width / density.density
            drawIntoCanvas { c -> painter.draw(c.nativeCanvas, room, speaking, size.width, size.height, widthDp, cam) }
        }
        menu?.let { (id, at) ->
            val m = room.members.firstOrNull { it.userId == id }
            Box(Modifier.offset { IntOffset(at.x.roundToInt(), at.y.roundToInt()) }) {
                DropdownMenu(expanded = true, onDismissRequest = { menu = null }) {
                    Text(
                        (m?.name ?: "?") + if (m?.inRoom == false) "（テキストで参加）" else "",
                        style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                    )
                    DropdownMenuItem(text = { Text("👋 手を振る") }, onClick = { menu = null; room.react("👋", to = id) })
                    if (m?.inRoom == true) DropdownMenuItem(text = { Text("そばへ行く") }, onClick = { menu = null; room.goNear(id) })
                }
            }
        }
    }
}

private const val T = 16

/** All the pixel art, drawn on the platform canvas with anti-aliasing off. Colours as 0xAARRGGBB. */
private class RoomPainter {
    private val p = Paint().apply { isAntiAlias = false; style = Paint.Style.FILL }
    private val bmp = Paint().apply { isFilterBitmap = false; isAntiAlias = false }
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD) }
    private var base: Bitmap? = null
    private var baseFor: RoomMap? = null
    private lateinit var c: android.graphics.Canvas

    private fun px(col: Long, x: Number, y: Number, w: Number = 1, h: Number = 1) {
        p.color = col.toInt()
        val fx = x.toFloat(); val fy = y.toFloat()
        c.drawRect(fx, fy, fx + w.toFloat(), fy + h.toFloat(), p)
    }

    fun draw(canvas: android.graphics.Canvas, room: RoomStore, speaking: Set<String>, wPx: Float, hPx: Float, widthDp: Float, cam: Camera) {
        val map = room.map ?: return
        val b = baseBitmap(room, map)
        val mapW = map.w * T; val mapH = map.h * T
        // About 13 tiles across on a phone, more on a wide screen; always an integer scale.
        val zoom = max(2, floor(wPx / (T * min(map.w.toFloat(), max(13f, widthDp / 46f)))).toInt()).toFloat()
        val vw = wPx / zoom; val vh = hPx / zoom
        val me = room.myActor
        val cx = if (me != null) (me.fx + 0.5f) * T - vw / 2 else (mapW - vw) / 2
        val cy = if (me != null) (me.fy + 0.5f) * T - vh / 2 else (mapH - vh) / 2
        val camX = max(min(cx, mapW - vw), min(0f, (mapW - vw) / 2)).roundToInt().toFloat()
        val camY = max(min(cy, mapH - vh), min(0f, (mapH - vh) / 2)).roundToInt().toFloat()
        cam.zoom = zoom; cam.camX = camX; cam.camY = camY

        c = canvas
        canvas.save()
        canvas.clipRect(0f, 0f, wPx, hPx)
        canvas.drawColor(0xFF120E14.toInt())
        canvas.save()
        canvas.translate(-camX * zoom, -camY * zoom)
        canvas.scale(zoom, zoom)
        canvas.drawBitmap(b, 0f, 0f, bmp)

        val myMember = room.myMember
        val inZone = me != null && room.zoneAt(me.x, me.y) != null
        // The hearing range around me (outside the zones).
        if (me != null && myMember?.inRoom == true && room.roomView && !inZone) {
            val r = (map.hearRadius * T).toFloat()
            val ccx = (me.fx + 0.5f) * T; val ccy = (me.fy + 0.5f) * T
            fill.color = 0x143CCF74
            canvas.drawCircle(ccx, ccy, r, fill)
            ring.color = 0x733CCF74; ring.strokeWidth = 2f / zoom
            canvas.drawCircle(ccx, ccy, r, ring)
        }
        room.beagle?.let { drawBeagle((it.fx * T).roundToInt(), it.y * T, it.frame, it.flip) }

        val members = room.members.associateBy { it.userId }
        val people = room.actors.values.filter { members.containsKey(it.id) }.sortedBy { it.fy }
        for (a in people) {
            val m = members[a.id] ?: continue
            val x = (a.fx * T).roundToInt(); val y = (a.fy * T).roundToInt() - 2
            val v = if (a.id == room.me) 1.0 else room.volumeFor(a.id)
            if (a.id in speaking && v > 0) {
                ring.color = 0xFF3CCF74.toInt(); ring.strokeWidth = 1f
                canvas.drawOval(RectF(x.toFloat(), y + 12f, x + 16f, y + 18f), ring)
            }
            val t = room.tileAt(a.x, a.y)
            val sitting = (t == 'c' || t == 's') && a.moveT == null
            canvas.save()
            val side = a.dir == RoomStore.Dir.LEFT || a.dir == RoomStore.Dir.RIGHT
            if (side && a.dir == RoomStore.Dir.LEFT) { canvas.translate(x * 2f + 16f, 0f); canvas.scale(-1f, 1f) }
            drawPerson(x, y, a.look, if (side) 2 else if (a.dir == RoomStore.Dir.UP) 1 else 0, a.step, sitting)
            canvas.restore()
        }
        canvas.restore()

        // Text in screen space (crisp at any scale).
        fun sx(bx: Float) = (bx - camX) * zoom
        fun sy(by: Float) = (by - camY) * zoom
        map.zones.forEach { z -> label(z.name, sx(z.x * T + 3f), sy(z.y * T + 2f), zoom, 0xBF120E14, 0xFF3CCF74, center = false) }
        map.labels.forEach { l -> label(l.name, sx(l.x * T + 2f), sy(l.y * T + 3f), zoom, 0xBF120E14, 0xFFF2B24C, center = false) }
        for (a in people) {
            val m = members[a.id] ?: continue
            val x = (a.fx * T).roundToInt(); val y = (a.fy * T).roundToInt() - 2
            val mine = a.id == room.me
            val v = if (mine) 1.0 else room.volumeFor(a.id)
            val mark = RoomStore.statusMark(m, a.id in speaking)
            label(
                "$mark ${m.name}", sx(x + 8f), sy(y - 9f), zoom,
                if (mine) 0xEBF2B24C else 0xC7120E14,
                if (mine) 0xFF1D1820 else if (v > 0 || !m.inRoom) 0xFFF3E9D8 else 0xFF9A8FA0,
                center = true,
            )
        }
        val now = RoomStore.now()
        for (a in people) a.bubble?.let { if (it.until > now) bubble(it.text, sx((a.fx * T).roundToInt() + 8f), sy((a.fy * T).roundToInt() - 12f), zoom) }
        room.beagle?.let { bg -> bg.bubble?.let { if (it.until > now) bubble(it.text, sx((bg.fx * T).roundToInt() + 8f), sy(bg.y * T - 12f), zoom) } }
        // Reactions float up and fade.
        for (a in people) {
            a.reacts.forEachIndexed { i, r ->
                val k = ((now - r.t0) / RoomStore.REACT_MS.toFloat())
                if (k < 0f || k > 1f) return@forEachIndexed
                text.textSize = (if (r.small) 9f else 13f) * zoom
                text.color = 0xFFFFFFFF.toInt()
                text.alpha = ((1 - k * k) * 255).roundToInt()
                c.drawText(r.emoji, sx((a.fx * T).roundToInt() + 1f + i * 7), sy((a.fy * T).roundToInt() - 4f - k * 18 - if (r.small) 8 else 0), text)
            }
        }
        text.alpha = 255
        canvas.restore()
    }

    private fun label(s: String, x: Float, y: Float, zoom: Float, bg: Long, fg: Long, center: Boolean) {
        text.textSize = 7f * zoom
        text.color = fg.toInt()
        val w = text.measureText(s) + 4 * zoom
        val lx = if (center) x - w / 2 else x
        p.color = bg.toInt()
        c.drawRect(lx, y, lx + w, y + 9f * zoom, p)
        c.drawText(s, lx + 2 * zoom, y + 7f * zoom, text)
    }

    private fun bubble(s: String, x: Float, y: Float, zoom: Float) {
        text.textSize = 8f * zoom
        text.color = 0xFF1D1820.toInt()
        val cps = s.codePoints().toArray()
        val rows = (cps.indices step 12).map { String(cps, it, min(12, cps.size - it)) }
        val w = (rows.maxOf { text.measureText(it) } + 8 * zoom)
        val h = rows.size * 9 * zoom + 5 * zoom
        val bx = x - w / 2; val by = y - h - 4 * zoom
        p.color = 0xFF1D1820.toInt(); c.drawRect(bx - zoom, by - zoom, bx + w + zoom, by + h + zoom, p)
        p.color = 0xFFFFFAF0.toInt(); c.drawRect(bx, by, bx + w, by + h, p)
        c.drawRect(x - zoom, by + h, x + 2 * zoom, by + h + 2 * zoom, p)
        c.drawRect(x, by + h + 2 * zoom, x + zoom, by + h + 3 * zoom, p)
        rows.forEachIndexed { i, r -> c.drawText(r, bx + 4 * zoom, by + 3 * zoom + (i * 9 + 7) * zoom, text) }
    }

    // MARK: tiles (16×16, cached in one bitmap per map)

    private fun baseBitmap(room: RoomStore, map: RoomMap): Bitmap {
        base?.let { if (baseFor === map) return it }
        val b = Bitmap.createBitmap(map.w * T, map.h * T, Bitmap.Config.ARGB_8888)
        val saved = if (this::c.isInitialized) c else null
        c = android.graphics.Canvas(b)
        for (y in 0 until map.h) for (x in 0 until map.w) drawTile(room, room.tileAt(x, y), x, y)
        // Zone floor marks: dashed outlines.
        for (z in map.zones) {
            val x0 = z.x * T; val y0 = z.y * T; val x1 = (z.x + z.w) * T - 1; val y1 = (z.y + z.h) * T - 1
            for (i in x0..x1 step 6) { px(0x8C3CCF74, i, y0, min(3, x1 - i + 1), 1); px(0x8C3CCF74, i, y1, min(3, x1 - i + 1), 1) }
            for (i in y0..y1 step 6) { px(0x8C3CCF74, x0, i, 1, min(3, y1 - i + 1)); px(0x8C3CCF74, x1, i, 1, min(3, y1 - i + 1)) }
        }
        saved?.let { c = it }
        base = b
        baseFor = map
        return b
    }

    private fun drawTile(room: RoomStore, t: Char, X: Int, Y: Int) {
        val x = X * T; val y = Y * T
        fun floor() {
            px(0xFF7A5236, x, y, T, T)
            for (i in 0 until 4) {
                px(if (i % 2 == 1) 0xFF845B3C else 0xFF70492F, x, y + i * 4, T, 3)
                px(0xFF5C3B25, x + ((X * 7 + i * 5) % 14), y + i * 4, 1, 3)
            }
        }
        fun stage() {
            px(0xFF5B3F7A, x, y, T, T); px(0xFF6A4B8C, x, y, T, 1); px(0xFF4C3366, x, y + 8, T, 1)
            val below = room.tileAt(X, Y + 1)
            if (below != 'S' && below != 'M') { px(0xFF2B1D3A, x, y + 13, T, 3); px(0xFFF2B24C, x + 3, y + 14, 2, 1); px(0xFFF2B24C, x + 11, y + 14, 2, 1) }
        }
        when (t) {
            '#' -> {
                px(0xFF3B3046, x, y, T, T)
                for (r in 0 until 4) {
                    px(0xFF4A3D57, x, y + r * 4, T, 1)
                    px(0xFF2E2538, x + ((r % 2) * 8 + 3), y + r * 4 + 1, 1, 3)
                    px(0xFF2E2538, x + ((r % 2) * 8 + 11) % 16, y + r * 4 + 1, 1, 3)
                }
            }
            'w' -> {
                px(0xFF3B3046, x, y, T, T); px(0xFF1B2A4A, x + 2, y + 3, 12, 11); px(0xFF26406E, x + 2, y + 3, 12, 4)
                px(0xFFF7E7A1, x + 10, y + 5, 2, 2); px(0xFFD7C6E0, x + 7, y + 3, 1, 11); px(0xFFD7C6E0, x + 2, y + 8, 12, 1)
                px(0xFF5D4C6B, x + 1, y + 14, 14, 1)
            }
            'D' -> {
                px(0xFF2A1C14, x, y, T, T); px(0xFF5A3A22, x + 1, y, 14, T)
                px(0xFFF2B24C, x + if (room.tileAt(X + 1, Y) == 'D') 12 else 3, y + 8, 1, 2)
            }
            'B' -> {
                floor(); px(0xFF4B2F1D, x, y, T, T)
                listOf(0xFFC0504D, 0xFF4F81BD, 0xFF9BBB59, 0xFFF2B24C, 0xFF8064A2, 0xFF4BACC6).forEachIndexed { i, col ->
                    px(col, x + 1 + i * 2 + (if (i > 2) 1 else 0), y + 2, 2, 5)
                    px(col, x + 2 + ((i + 3) % 6) * 2, y + 9, 2, 5)
                }
                px(0xFF2E1C11, x, y + 7, T, 2)
            }
            'S' -> stage()
            'M' -> { stage(); px(0xFFCFCFD6, x + 7, y + 5, 2, 9); px(0xFF55555F, x + 5, y + 14, 6, 1); px(0xFF2B2B33, x + 6, y + 2, 4, 4); px(0xFF8A8A96, x + 7, y + 3, 1, 1) }
            ',' -> {
                floor(); px(0xFF8C2F39, x, y, T, T); px(0xFFA8404A, x + 1, y + 1, T - 2, T - 2)
                if ((X + Y) % 2 == 1) px(0xFFF2B24C, x + 7, y + 7, 2, 2) else { px(0xFFD9A441, x + 3, y + 3, 1, 1); px(0xFFD9A441, x + 12, y + 12, 1, 1) }
            }
            'T' -> {
                floor(); px(0xFFC9925B, x, y, T, T); px(0xFFE0AB73, x, y, T, 2); px(0xFFA4743F, x, y + 14, T, 2)
                val left = room.tileAt(X - 1, Y) != 'T'
                val top = room.tileAt(X, Y - 1) != 'T'
                if (!left && top && room.tileAt(X - 2, Y) != 'T') { px(0xFFF3E9D8, x + 4, y + 5, 7, 5); px(0xFF43384A, x + 5, y + 6, 5, 1); px(0xFF43384A, x + 5, y + 8, 4, 1) }
                if (!top && (X % 3 == 0)) { px(0xFFFFFFFF, x + 5, y + 4, 4, 5); px(0xFF6B3F22, x + 6, y + 5, 2, 2) }
            }
            'c' -> { floor(); px(0xFF3C6E71, x + 3, y + 3, 10, 10); px(0xFF4F8A8D, x + 3, y + 3, 10, 2); px(0xFF2B5052, x + 3, y + 12, 10, 1) }
            'F' -> {
                floor(); px(0xFF2F5D8A, x, y + 2, T, 13); px(0xFF3F73A8, x, y + 2, T, 4); px(0xFF24496D, x, y + 13, T, 2)
                if (room.tileAt(X - 1, Y) != 'F') px(0xFF24496D, x, y + 2, 2, 13)
                if (room.tileAt(X + 1, Y) != 'F') px(0xFF24496D, x + 14, y + 2, 2, 13)
            }
            'V' -> {
                floor(); px(0xFFC43D3D, x + 1, y, 14, T)
                if (room.tileAt(X, Y - 1) != 'V') {
                    px(0xFF2A2A33, x + 3, y + 2, 10, 12)
                    listOf(0xFF3CCF74, 0xFFF2B24C, 0xFF4BACC6, 0xFFF3E9D8).forEachIndexed { i, col -> px(col, x + 4 + (i % 2) * 5, y + 3 + (i / 2) * 5, 3, 4) }
                } else { px(0xFFF3E9D8, x + 3, y + 2, 6, 2); px(0xFF1B1B22, x + 3, y + 8, 10, 4); px(0xFF8E2A2A, x + 1, y + 14, 14, 2) }
            }
            'P' -> {
                floor(); px(0xFF9B5A34, x + 4, y + 10, 8, 6); px(0xFF7D4425, x + 4, y + 10, 8, 1); px(0xFF2F8F4E, x + 3, y + 3, 10, 8)
                px(0xFF3FB065, x + 5, y + 1, 6, 6); px(0xFF24703C, x + 2, y + 7, 3, 3); px(0xFF24703C, x + 11, y + 6, 3, 3)
            }
            'C' -> {
                floor(); px(0xFF5A3D6E, x, y + 2, T, 12); px(0xFF7A5A92, x, y + 2, T, 3); px(0xFF43305A, x, y + 13, T, 1)
                if (X % 2 == 0) { px(0xFF2B2B33, x + 4, y + 6, 8, 5); px(0xFF4BACC6, x + 5, y + 7, 6, 3); px(0xFF55555F, x + 7, y + 11, 2, 2) }
                else { px(0xFFF3E9D8, x + 6, y + 7, 4, 4); px(0xFF6B3F22, x + 7, y + 8, 2, 2) }
            }
            's' -> { floor(); px(0xFF2B5052, x + 4, y + 9, 8, 6); px(0xFF3C6E71, x + 3, y + 7, 10, 3) }
            'b' -> { floor(); px(0xFF6B4A8C, x, y + 3, T, 12); px(0xFF8A67AB, x + 1, y + 5, T - 2, 8) }
            else -> floor()
        }
    }

    // MARK: people and the beagle

    /** 16×16; dir 0 = down, 1 = up, 2 = side; step 0/1/2 (walk frames). */
    private fun drawPerson(x: Int, y: Int, look: RoomStore.Look, dir: Int, step: Int, sitting: Boolean) {
        px(0x47000000, x + 3, y + 14, 10, 2)
        val lift = if (sitting) 2 else 0
        if (!sitting) {
            val a = if (step == 1) -1 else 0; val b = if (step == 2) -1 else 0
            px(look.pants, x + 5, y + 12 + a, 2, 3); px(look.pants, x + 9, y + 12 + b, 2, 3)
            px(0xFF1E1A22, x + 5, y + 15 + a, 2, 1); px(0xFF1E1A22, x + 9, y + 15 + b, 2, 1)
        } else px(look.pants, x + 4, y + 12, 8, 2)
        px(look.shirt, x + 4, y + 8 + lift, 8, 5 - lift)
        px(0x2E000000, x + 4, y + 12, 8, 1)
        val sw = if (step == 1) 1 else if (step == 2) -1 else 0
        if (dir != 2) { px(look.skin, x + 3, y + 9 + lift + sw, 1, 3); px(look.skin, x + 12, y + 9 + lift - sw, 1, 3) }
        else px(look.skin, x + 7 + sw, y + 9 + lift, 2, 3)
        px(look.skin, x + 4, y + 2 + lift, 8, 7)
        px(look.hair, x + 4, y + 1 + lift, 8, 3)
        when (dir) {
            1 -> px(look.hair, x + 4, y + 1 + lift, 8, 6)
            2 -> { px(look.hair, x + 4, y + 1 + lift, 4, 6); px(0xFF1E1A22, x + 10, y + 5 + lift, 1, 2) }
            else -> {
                px(look.hair, x + 4, y + 4 + lift, 1, 2); px(look.hair, x + 11, y + 4 + lift, 1, 2)
                px(0xFF1E1A22, x + 6, y + 5 + lift, 1, 2); px(0xFF1E1A22, x + 9, y + 5 + lift, 1, 2)
                px(0xFFE08A7A, x + 5, y + 7 + lift, 1, 1); px(0xFFE08A7A, x + 10, y + 7 + lift, 1, 1)
            }
        }
    }

    /** The club beagle: tricolour, long ears, white-tipped tail. */
    private fun drawBeagle(x: Int, y: Int, frame: Int, flip: Boolean) {
        c.save()
        if (flip) { c.translate(x * 2f + 16f, 0f); c.scale(-1f, 1f) }
        px(0x40000000, x + 2, y + 14, 12, 2)
        px(0xFFC97A3A, x + 3, y + 7, 9, 5)
        px(0xFF2A1F1A, x + 5, y + 7, 6, 2)
        px(0xFFF6EFE4, x + 4, y + 11, 7, 1)
        val l = frame
        listOf(3 to 12, 5 to 12 - l, 9 to 12, 11 to 12 - (1 - l)).forEach { (lx, ly) -> px(0xFFF6EFE4, x + lx, y + ly, 1, 3) }
        px(0xFFC97A3A, x + 11, y + 3, 4, 5)
        px(0xFFF6EFE4, x + 13, y + 6, 3, 2)
        px(0xFF2A1F1A, x + 15, y + 6, 1, 1)
        px(0xFF2A1F1A, x + 13, y + 4, 1, 1)
        px(0xFF7A4520, x + 10, y + 4, 2, 5)
        px(0xFFC97A3A, x + 1, y + 5 + l, 1, 3); px(0xFFF6EFE4, x, y + 4 + l, 1, 1)
        c.restore()
    }
}
