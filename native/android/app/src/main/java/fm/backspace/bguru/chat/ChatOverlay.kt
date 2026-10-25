package fm.backspace.bguru.chat

import android.content.Context
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/*
 * チャットの上に機能を重ねる形 — the UI (docs/chat-overlay-spec.md). The registry ([overlayActivities]) says
 * which features are on for this member and how each reads (icon, label, ● live, its chip); the switch row,
 * the small windows, the chips and the expanded card only draw it. The state is OverlayState
 * (ChatOverlayState.kt); the bridge functions below keep it and the feature stores' own `open` in step.
 */

private val LiveOrange = Color(0xFFEA580C)
private val SwitchOnGreen = Color(0xFF15803D)
private val WatchDark = Color(0xFF0F1411)
private val WatchFg = Color(0xFFE6ECE8)
private val OffkaiBorder = Color(0xFFF3D3B6)
private val OffkaiText = Color(0xFF9A3412)

/** One feature as the overlay draws it. `sticky`: it plays sound even when switched off (kept as a chip). */
class OverlayActivity(
    val id: ActivityId,
    val icon: String,
    val label: String,
    val isLive: Boolean,
    val liveText: String,
    val sticky: Boolean,
    /** 🏠 only: people in the room's voice (the switch reads 🏠🎧n). */
    val count: Int = 0,
)

/** The features on for this member, in the order of the switches (🏠 ・ ☗ ・ 🎮 ・ 📺 ・ 🍻). */
fun ChatStore.overlayActivities(): List<OverlayActivity> = buildList {
    if (room.enabled) {
        val inVoice = room.members.count { it.inRoom && it.listening }
        val talking = (voice.phase == VoiceStore.Phase.CONNECTED && voice.members.any { it.speaking }) ||
            room.members.any { it.inRoom && it.mic && !it.away }
        val text = (if (room.roomView) "🏠 部室にいます" else "🏠 部室") + if (inVoice > 0) " 🎧$inVoice" else ""
        add(OverlayActivity(ActivityId.ROOM, "🏠", "部室", talking, text, sticky = room.roomView, count = inVoice))
    }
    if (shogi.enabled) {
        val g = shogi.liveGame?.takeIf { it.isActive }
        add(OverlayActivity(ActivityId.SHOGI, "☗", "将棋", g != null, if (g != null) "☗ ${g.ply} 手" else "☗ 将棋", sticky = false))
    }
    if (minigame.enabled) add(OverlayActivity(ActivityId.GAME, "🎮", "ゲーム", false, "🎮 ゲーム", sticky = false))
    if (watch.enabled) {
        val on = watch.title != null
        add(OverlayActivity(ActivityId.WATCH, "📺", "みんなで見る", on, if (on) "📺 再生中" else "📺 みんなで見る", sticky = watch.open))
    }
    if (offkai.enabled) {
        val sp = offkai.current?.speaker?.takeIf { it.connected }
        val text = when {
            !offkai.running -> "🍻 オフ会"
            sp != null -> "🍻 ${sp.name ?: "だれか"} 話し中"
            else -> "🍻 開催中"
        } + if (offkai.listening) " · 🔊" else ""
        add(OverlayActivity(ActivityId.OFFKAI, "🍻", "オフ会", offkai.running, text, sticky = offkai.listening))
    }
}

// MARK: bridge (the switch ⇄ each store's own open / show / close)

/** The switch. 🎮 opens expanded. */
fun ChatStore.overlayToggle(id: ActivityId, ctx: Context?) {
    if (overlay.isShown(id)) overlayHide(id) else overlayShow(id, ctx, expand = id == ActivityId.GAME)
}

/** Switched on (and expanded when asked): the store opens what it shows. The overlay first, so the store's
 *  `open` turning true is not taken for an outside open (which would expand it). */
fun ChatStore.overlayShow(id: ActivityId, ctx: Context?, expand: Boolean = false) {
    overlay.show(id, expand)
    when (id) {
        ActivityId.SHOGI -> {
            shogi.open = true
            // Expanding with a game on: its board straight away (the mock's 「☗ A vs ☖ B · 6 手」).
            if (expand && shogi.selectedId == null) shogi.liveGame?.takeIf { it.isActive }?.let { shogi.select(it.id) }
        }
        ActivityId.GAME -> minigame.open = true
        ActivityId.OFFKAI -> if (!offkai.open) { offkai.open = true; offkai.refresh() }
        ActivityId.WATCH -> ctx?.let { watch.show(it) }
        ActivityId.ROOM -> Unit
    }
}

/** Switched off: the window goes, a sound goes on (📺 playing, 🍻 listening, 🏠 in the voice stay as chips). */
fun ChatStore.overlayHide(id: ActivityId) {
    overlay.hide(id)
    when (id) {
        ActivityId.SHOGI -> shogi.open = false
        ActivityId.GAME -> minigame.open = false
        ActivityId.OFFKAI -> offkai.open = false
        // No video on: nothing to keep playing, the player goes.
        ActivityId.WATCH -> if (watch.title == null) watch.close()
        ActivityId.ROOM -> Unit
    }
}

/** 📺's player is in a window right now (otherwise it is kept, out of sight, so the sound goes on). */
val ChatStore.watchInWindow: Boolean get() = overlay.expandedNow == ActivityId.WATCH || ActivityId.WATCH in overlay.minis

/** Keeps the overlay and the stores in step (outside opens, features turned off, 📺's layout). */
@Composable
fun ChatOverlaySync(store: ChatStore) {
    val o = store.overlay
    LaunchedEffect(store) {
        snapshotFlow {
            listOf(
                store.shogi.enabled && store.shogi.open,
                store.minigame.enabled && store.minigame.open,
                store.offkai.enabled && store.offkai.open,
                store.watch.open,
            )
        }.collect { v ->
            o.storeOpened(ActivityId.SHOGI, v[0])
            o.storeOpened(ActivityId.GAME, v[1])
            o.storeOpened(ActivityId.OFFKAI, v[2])
            o.storeOpened(ActivityId.WATCH, v[3])
        }
    }
    // A feature turned off for this member: its window goes.
    val available by remember(store) { derivedStateOf { store.overlayActivities().map { it.id }.toSet() } }
    LaunchedEffect(available) { o.shown.filter { it !in available }.forEach(o::hide) }
    // 📺: the page's full layout when expanded, its compact one in the small window.
    val watchExpanded = o.expandedNow == ActivityId.WATCH
    LaunchedEffect(watchExpanded, store.watch.open) {
        if (store.watch.open) store.watch.switchTo(if (watchExpanded) WatchStore.Mode.DOCKED else WatchStore.Mode.FLOATING)
    }
}

// MARK: the second row — switches (or, while typing, the chips)

@Composable
fun OverlaySwitchRow(store: ChatStore, onChipWhileTyping: () -> Unit) {
    val o = store.overlay
    val ctx = LocalContext.current
    val activities = store.overlayActivities()
    val sticky = activities.filter { it.sticky }.map { it.id }.toSet()
    val chips = if (o.typing || o.expandedNow == null) o.chips(sticky) else emptyList()
    val typingChips = o.typing && chips.isNotEmpty()
    Column(Modifier.fillMaxWidth()) {
        // Never wider than the screen: the row scrolls sideways when it does not fit (narrowest phone, big text).
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(if (typingChips) 6.dp else 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (!typingChips) activities.forEach { a ->
                OverlaySwitch(a, on = o.isShown(a.id)) { store.overlayToggle(a.id, ctx) }
            }
            chips.forEach { id ->
                val a = activities.firstOrNull { it.id == id } ?: return@forEach
                OverlayChip(a) {
                    if (o.typing) onChipWhileTyping()
                    store.overlayShow(id, ctx, expand = true)
                }
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        if (store.room.enabled && !store.room.roomView) store.room.notice?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 12.dp))
        }
    }
}

/** One switch: a pill, green when on, an orange ● while live. */
@Composable
private fun OverlaySwitch(a: OverlayActivity, on: Boolean, onToggle: () -> Unit) {
    val shape = RoundedCornerShape(50)
    val scheme = MaterialTheme.colorScheme
    Box(
        Modifier.height(36.dp)
            .then(if (a.id == ActivityId.ROOM) Modifier else Modifier.width(44.dp))
            .background(if (on) AccentGreen.copy(alpha = 0.16f) else scheme.surface, shape)
            .border(1.dp, if (on) SwitchOnGreen else scheme.outlineVariant, shape)
            .toggleable(value = on, role = Role.Switch, onValueChange = { onToggle() })
            .semantics { contentDescription = a.label + (if (a.isLive) "（${a.liveText.drop(2).trim()}）" else "") }
            .padding(horizontal = if (a.id == ActivityId.ROOM) 12.dp else 0.dp),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(a.icon, fontSize = 15.sp, maxLines = 1)
            if (a.id == ActivityId.ROOM && a.count > 0) Text("🎧${a.count}", fontSize = 13.sp, color = scheme.onSurfaceVariant, maxLines = 1)
        }
        if (a.isLive) Box(Modifier.align(Alignment.TopEnd).offset(x = if (a.id == ActivityId.ROOM) 6.dp else (-6).dp, y = 4.dp).size(8.dp).background(LiveOrange, CircleShape))
    }
}

/** A round chip (「📺 再生中」「🍻 mazzo 話し中 · 🔊」): tap to expand it. */
@Composable
private fun OverlayChip(a: OverlayActivity, onClick: () -> Unit) {
    val shape = RoundedCornerShape(50)
    val (bg, fg, border) = when (a.id) {
        ActivityId.WATCH -> Triple(WatchDark, WatchFg, null)
        ActivityId.OFFKAI -> Triple(LiveOrange.copy(alpha = 0.10f), if (MaterialTheme.colorScheme.background.luminance() < 0.5f) Color(0xFFFDBA74) else OffkaiText, OffkaiBorder)
        else -> Triple(MaterialTheme.colorScheme.surface, MaterialTheme.colorScheme.onSurfaceVariant, MaterialTheme.colorScheme.outlineVariant)
    }
    Box(
        Modifier.height(28.dp).background(bg, shape)
            .then(if (border != null) Modifier.border(1.dp, border, shape) else Modifier)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 10.dp),
        contentAlignment = Alignment.Center,
    ) { Text(a.liveText, fontSize = 12.sp, color = fg, maxLines = 1) }
}

private fun Color.luminance(): Float = 0.2126f * red + 0.7152f * green + 0.0722f * blue

// MARK: the layer over the messages

/** 📺 kept playing, out of sight, under the messages (drawn first in the message area). */
@Composable
fun BoxScope.WatchHiddenHost(store: ChatStore) {
    if (store.watch.open && !store.watchInWindow) {
        WatchPlayerHost(store.watch, Modifier.align(Alignment.TopStart).width(MINI_WATCH_WIDTH).height(MINI_WATCH_PLAYER).alpha(0f))
    }
}

/** The small windows, or the expanded card with its chips, over the message list (drawn last). */
@Composable
fun BoxScope.ChatOverlayLayer(store: ChatStore, visible: Boolean, onScreen: Boolean) {
    val o = store.overlay
    val activities = store.overlayActivities()
    BoxWithConstraints(Modifier.matchParentSize()) {
        val areaW = maxWidth
        val areaH = maxHeight
        val exp = o.expandedNow
        if (exp != null) {
            val a = activities.firstOrNull { it.id == exp }
            if (a != null) ExpandedCard(store, a, activities, areaH, visible, onScreen)
        } else {
            o.minis.forEach { id ->
                val a = activities.firstOrNull { it.id == id } ?: return@forEach
                key(id) { MiniWindow(store, a, areaW, areaH) }
            }
        }
    }
}

private val MINI_WIDTH = 176.dp
private val MINI_WATCH_WIDTH = 208.dp
/** 16:9 of the width + the page's own bar in its compact layout (44 dp). */
private val MINI_WATCH_PLAYER = MINI_WATCH_WIDTH * 9f / 16f + 44.dp

/** Where a small window starts when it was never moved: 📺 ☗ 🎮 down the left, 🍻 🏠 down the right. */
private fun defaultPosition(id: ActivityId, w: Float, areaW: Float): Pair<Float, Float> {
    val right = areaW - w - 10f
    return when (id) {
        ActivityId.WATCH -> 10f to 10f
        ActivityId.OFFKAI -> right to 10f
        ActivityId.ROOM -> right to 150f
        ActivityId.SHOGI -> 10f to 210f
        ActivityId.GAME -> right to 290f
    }
}

@Composable
private fun MiniWindow(store: ChatStore, a: OverlayActivity, areaW: Dp, areaH: Dp) {
    val o = store.overlay
    val ctx = LocalContext.current
    val density = LocalDensity.current
    val id = a.id
    val w = if (id == ActivityId.WATCH) MINI_WATCH_WIDTH else MINI_WIDTH
    var size by remember { mutableStateOf(w.value to 120f) } // dp, measured below
    var pos by remember { mutableStateOf(o.position(id) ?: defaultPosition(id, w.value, areaW.value)) }
    val shown = OverlayState.clamp(pos.first, pos.second, size.first, size.second, areaW.value, areaH.value)
    val expand = { store.overlayShow(id, ctx, expand = true) }
    val dark = id == ActivityId.WATCH
    Surface(
        shape = RoundedCornerShape(14.dp),
        shadowElevation = 8.dp,
        color = if (dark) WatchDark else MaterialTheme.colorScheme.surface,
        border = if (id == ActivityId.OFFKAI) BorderStroke(1.dp, OffkaiBorder) else BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = if (dark) 0f else 0.6f)),
        modifier = Modifier
            .offset { IntOffset(shown.first.dp.roundToPx(), shown.second.dp.roundToPx()) }
            .width(w)
            .onSizeChanged { s -> with(density) { size = s.width.toDp().value to s.height.toDp().value } }
            .pointerInput(id) {
                detectDragGestures(
                    onDragStart = { pos = shown },
                    onDrag = { change, amount ->
                        change.consume()
                        val p = pos
                        pos = OverlayState.clamp(p.first + amount.x / density.density, p.second + amount.y / density.density,
                            size.first, size.second, areaW.value, areaH.value)
                    },
                    onDragEnd = { o.moveTo(id, pos.first, pos.second) },
                )
            },
    ) {
        when (id) {
            ActivityId.WATCH -> WatchMini(store, expand)
            ActivityId.OFFKAI -> OffkaiMini(store.offkai, expand)
            ActivityId.SHOGI -> ShogiMini(store.shogi, expand)
            ActivityId.ROOM -> RoomMini(store.room, store.voice, expand)
            ActivityId.GAME -> GameMini(expand)
        }
    }
}

/** A small window's title with ⤢ (the whole title expands it). */
@Composable
private fun MiniHeader(title: String, onExpand: () -> Unit, color: Color = Color.Unspecified) {
    Row(
        Modifier.fillMaxWidth().clickable(onClickLabel = "広げる", onClick = onExpand),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Text("⤢", fontSize = 15.sp, color = if (color == Color.Unspecified) MaterialTheme.colorScheme.outline else color.copy(alpha = 0.7f),
            modifier = Modifier.padding(start = 6.dp).semantics { contentDescription = "広げる" })
    }
}

@Composable
private fun MiniLine(text: String) {
    Text(text, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
}

@Composable
private fun WatchMini(store: ChatStore, onExpand: () -> Unit) {
    Column {
        WatchPlayerHost(store.watch, Modifier.fillMaxWidth().height(MINI_WATCH_PLAYER))
        Box(Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
            MiniHeader("📺 ${store.watch.title ?: "みんなで見る"}", onExpand, color = WatchFg)
        }
    }
}

@Composable
private fun OffkaiMini(offkai: OffkaiStore, onExpand: () -> Unit) {
    val e = offkai.current
    Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        MiniHeader("🍻 ${e?.let(OffkaiLogic::title) ?: "オフ会"}", onExpand)
        if (offkai.running && e != null) {
            val sp = e.speaker?.takeIf { it.connected }
            MiniLine((if (sp != null) "🎙 ${sp.name ?: "だれか"} 話し中" else "開催中") + " · 🎧${offkai.listeners}")
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                val pad = PaddingValues(horizontal = 8.dp)
                when (offkai.phase) {
                    OffkaiStore.Phase.IDLE -> Button(onClick = { offkai.listen() }, contentPadding = pad,
                        colors = ButtonDefaults.buttonColors(containerColor = LiveOrange, contentColor = Color.White),
                        modifier = Modifier.weight(1f).height(30.dp)) { Text("🔊 聞く", fontSize = 12.sp, fontWeight = FontWeight.Bold) }
                    OffkaiStore.Phase.CONNECTING -> OutlinedButton(onClick = { offkai.stopListening() }, contentPadding = pad,
                        modifier = Modifier.weight(1f).height(30.dp)) { Text("接続中…", fontSize = 12.sp) }
                    else -> OutlinedButton(onClick = { offkai.stopListening() }, contentPadding = pad,
                        modifier = Modifier.weight(1f).height(30.dp)) { Text("🔇 止める", fontSize = 12.sp) }
                }
                if (offkai.canControl) PhotoButton(offkai, compact = true)
            }
        } else {
            MiniLine("いまは開催していません（⤢ で始める・アルバム）")
        }
        offkai.notice?.let { Text(it, fontSize = 11.sp, color = MaterialTheme.colorScheme.error, maxLines = 2, overflow = TextOverflow.Ellipsis) }
    }
}

@Composable
private fun ShogiMini(shogi: ShogiStore, onExpand: () -> Unit) {
    val g = shogi.liveGame
    Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        MiniHeader("☗ 将棋", onExpand)
        if (g == null) {
            MiniLine("いま対局はありません（⤢ で始める）")
        } else {
            Row(Modifier.clickable(onClick = onExpand), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                MiniBoard(g.sfen, 56.dp)
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(ShogiLogic.vsText(g), fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    val mine = shogi.myColorIn(g)
                    MiniLine(when {
                        g.isActive && mine != null -> "対局中 ${g.ply} 手・" + if (mine == g.turn) "あなたの番" else "相手の番"
                        g.isActive -> "対局中 ${g.ply} 手・観戦"
                        g.status == "offered" -> "申し込み中"
                        else -> "相手を待っています"
                    })
                }
            }
        }
    }
}

@Composable
private fun RoomMini(room: RoomStore, voice: VoiceStore, onExpand: () -> Unit) {
    val actions = rememberRoomActions(room, voice)
    val people = room.members.filter { it.inRoom && it.listening && !it.away }
    Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        MiniHeader(if (room.roomView) "🏠 部室にいます" else "🏠 部室", onExpand)
        if (people.isEmpty()) MiniLine("いま話している人はいません")
        else Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            people.take(5).forEach { m ->
                val speaking = voice.members.firstOrNull { it.userId == m.userId }?.speaking == true
                Box(
                    Modifier.size(28.dp).then(if (speaking) Modifier.border(2.dp, AccentGreen, CircleShape) else Modifier),
                    contentAlignment = Alignment.Center,
                ) { Avatar(m.avatar, m.name, 24.dp) }
            }
            if (people.size > 5) MiniLine("+${people.size - 5}")
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            val pad = PaddingValues(horizontal = 8.dp)
            if (!room.roomView) {
                Button(onClick = actions.enter, contentPadding = pad, modifier = Modifier.weight(1f).height(30.dp)) { Text("入る", fontSize = 12.sp) }
            } else {
                OutlinedButton(onClick = { room.toText() }, contentPadding = pad, modifier = Modifier.weight(1f).height(30.dp)) { Text("出る", fontSize = 12.sp) }
                val micEnabled = room.listening && voice.phase == VoiceStore.Phase.CONNECTED && !room.micBusy && !voice.micBusy
                OutlinedButton(onClick = actions.toggleMic, enabled = micEnabled, contentPadding = PaddingValues(0.dp),
                    modifier = Modifier.height(30.dp).width(44.dp).semantics { contentDescription = if (voice.micOn) "マイクを切る" else "マイクを入れる" }) {
                    Text(if (voice.micOn) "🎙" else "🔇", fontSize = 13.sp)
                }
            }
        }
        room.notice?.let { Text(it, fontSize = 11.sp, color = MaterialTheme.colorScheme.error, maxLines = 2, overflow = TextOverflow.Ellipsis) }
    }
}

@Composable
private fun GameMini(onExpand: () -> Unit) {
    Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        MiniHeader("🎮 散財ダッシュ", onExpand)
        MiniLine("今日のベストとランキングは広げて")
        Button(onClick = onExpand, contentPadding = PaddingValues(horizontal = 8.dp), modifier = Modifier.fillMaxWidth().height(30.dp)) {
            Text("▶ 遊ぶ", fontSize = 12.sp)
        }
    }
}

// MARK: expanded

@Composable
private fun ExpandedCard(store: ChatStore, a: OverlayActivity, activities: List<OverlayActivity>, areaH: Dp, visible: Boolean, onScreen: Boolean) {
    val o = store.overlay
    val ctx = LocalContext.current
    // About half the screen (spec: iPhone ~50 %), leaving at least a few lines of the chat under it.
    val screenH = LocalConfiguration.current.screenHeightDp.dp
    val h = (screenH * 0.5f).coerceAtMost(areaH - 64.dp).coerceAtLeast(minOf(areaH, 220.dp))
    val sticky = activities.filter { it.sticky }.map { it.id }.toSet()
    val chips = o.chips(sticky).mapNotNull { id -> activities.firstOrNull { it.id == id } }
    Surface(Modifier.fillMaxWidth().height(h), color = MaterialTheme.colorScheme.surface, shadowElevation = 10.dp) {
        Column {
            Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 8.dp, top = 4.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(expandedTitle(store, a), fontSize = 14.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (a.id == ActivityId.WATCH) TextButton(onClick = { store.watch.close(); o.hide(ActivityId.WATCH) }, contentPadding = PaddingValues(horizontal = 8.dp)) {
                    Text("■ 止める", fontSize = 12.sp)
                }
                OutlinedButton(onClick = { o.collapse() }, contentPadding = PaddingValues(horizontal = 10.dp), modifier = Modifier.height(30.dp)
                    .semantics { contentDescription = "小さくする" }) { Text("⤡ 小さく", fontSize = 12.sp) }
            }
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                val ch = maxHeight
                when (a.id) {
                    ActivityId.SHOGI -> ShogiPanel(store, visible, ch, Modifier.fillMaxWidth().heightIn(max = ch), onScreen = onScreen)
                    ActivityId.GAME -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                        MinigamePanel(store, active = visible && !o.typing, maxHeight = ch, modifier = Modifier.fillMaxWidth())
                    }
                    ActivityId.OFFKAI -> OffkaiPanel(store.offkai, Modifier.fillMaxSize())
                    ActivityId.WATCH -> WatchPlayerHost(store.watch, Modifier.fillMaxSize())
                    ActivityId.ROOM -> if (store.room.roomView) RoomPanel(store.room, store.voice, onScreen, Modifier.fillMaxSize())
                        else Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Surface(shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), modifier = Modifier.width(240.dp)) {
                                RoomMini(store.room, store.voice) {}
                            }
                        }
                }
            }
            if (chips.isNotEmpty()) {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End),
                ) {
                    chips.forEach { c -> OverlayChip(c) { store.overlayShow(c.id, ctx, expand = true) } }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        }
    }
}

private fun expandedTitle(store: ChatStore, a: OverlayActivity): String = when (a.id) {
    ActivityId.SHOGI -> store.shogi.liveGame?.takeIf { it.isActive }?.let { g ->
        val who = store.shogi.myColorIn(g)?.let { if (it == g.turn) "あなたの番" else "相手の番" } ?: "観戦中"
        "${ShogiLogic.vsText(g)} · ${g.ply} 手 · $who"
    } ?: "☗ 将棋"
    ActivityId.WATCH -> "📺 ${store.watch.title ?: "みんなで見る"}"
    ActivityId.OFFKAI -> store.offkai.current?.takeIf { store.offkai.running }?.let { "🍻 ${OffkaiLogic.title(it)}" } ?: "🍻 オフ会"
    ActivityId.ROOM -> a.liveText
    ActivityId.GAME -> "🎮 散財ダッシュ"
}

