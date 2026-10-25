package fm.backspace.bguru.chat

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.AssetManager
import android.graphics.Color as AColor
import android.net.Uri
import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject
import okhttp3.Cache
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayInputStream
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/** ☗ 将棋 UI (docs/shogi-spec.md): the mode switch without the room, the panel above the chat
 *  (lobby / board / result), the board's WebView, the chat's game card and the folded chat line. */

private val ShogiGreen = Color(0xFF16A34A)

// MARK: switch (when the room is off for this member: テキスト｜☗ 将棋)

@Composable
fun ShogiModeSwitch(shogi: ShogiStore, minigame: MinigameStore, offkai: OffkaiStore? = null) {
    // テキスト｜☗｜🎮｜🍻 (each only when on). ☗, 🎮 and 🍻 never open together.
    val withShogi = shogi.enabled
    val withGame = minigame.enabled
    val withOffkai = offkai?.enabled == true
    val offkaiOpen = withOffkai && offkai!!.open
    if (withShogi) ShogiBackHandler(shogi)
    if (withGame) MinigameBackHandler(minigame)
    if (withOffkai) OffkaiBackHandler(offkai!!)
    val n = 1 + (if (withShogi) 1 else 0) + (if (withGame) 1 else 0) + (if (withOffkai) 1 else 0)
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.Center) {
        SingleChoiceSegmentedButtonRow(Modifier.width(when (n) { 4 -> 260.dp; 3 -> 220.dp; else -> 180.dp }).height(32.dp)) {
            SegmentedButton(selected = !shogi.open && !minigame.open && !offkaiOpen, onClick = { shogi.open = false; minigame.open = false; offkai?.open = false }, shape = SegmentedButtonDefaults.itemShape(0, n), icon = {}) {
                Text("テキスト", style = MaterialTheme.typography.labelSmall)
            }
            var i = 1
            if (withShogi) {
                SegmentedButton(selected = shogi.open, onClick = { minigame.open = false; offkai?.open = false; shogi.open = true }, shape = SegmentedButtonDefaults.itemShape(i++, n), icon = {}) {
                    ShogiSegmentLabel(shogi)
                }
            }
            if (withGame) {
                SegmentedButton(selected = minigame.open, onClick = { shogi.open = false; offkai?.open = false; minigame.open = true }, shape = SegmentedButtonDefaults.itemShape(i++, n), icon = {}) {
                    MinigameSegmentLabel()
                }
            }
            if (withOffkai) {
                SegmentedButton(selected = offkaiOpen, onClick = { shogi.open = false; minigame.open = false; offkai!!.open = true }, shape = SegmentedButtonDefaults.itemShape(i, n), icon = {}) {
                    OffkaiSegmentLabel(offkai!!)
                }
            }
        }
    }
}

/** 🎮 only (read out as 「ゲーム」). */
@Composable
fun MinigameSegmentLabel() {
    Text("🎮", style = MaterialTheme.typography.labelLarge, maxLines = 1, modifier = Modifier.semantics { contentDescription = "ゲーム" })
}

/** ☗ only (read out as 「将棋」), with what waits for me (offers + my turn) or how many games are on. */
@Composable
fun ShogiSegmentLabel(shogi: ShogiStore) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp),
        modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = "将棋" }) {
        Text("☗", style = MaterialTheme.typography.labelLarge, maxLines = 1)
        val waiting = shogi.waitingCount
        if (waiting > 0) {
            Box(Modifier.size(15.dp).background(MaterialTheme.colorScheme.error, CircleShape), contentAlignment = Alignment.Center) {
                Text("$waiting", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onError)
            }
        } else if (shogi.liveCount > 0) {
            Text("${shogi.liveCount}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Back: from a board to the lobby, from the lobby to the text view. */
@Composable
fun ShogiBackHandler(shogi: ShogiStore) {
    BackHandler(enabled = shogi.open) { if (shogi.selectedId != null) shogi.select(null) else shogi.open = false }
}

// MARK: panel

/** The shogi screen above the chat. As tall as it needs (one band + the board), never more than
 *  [maxHeight] (the board shrinks itself into it): the chat below keeps most of the screen. */
@Composable
fun ShogiPanel(store: ChatStore, visible: Boolean, maxHeight: androidx.compose.ui.unit.Dp, modifier: Modifier = Modifier, onScreen: Boolean = visible) {
    val shogi = store.shogi
    Surface(modifier, color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Box {
            Column(Modifier.fillMaxWidth()) {
                val g = shogi.selected
                when {
                    shogi.selectedId == null -> {
                        // The lobby has no title row: just its buttons (or the one game's line).
                        Column(Modifier.heightIn(max = (maxHeight - 40.dp).coerceAtLeast(80.dp)).verticalScroll(rememberScrollState())) { Lobby(store) }
                    }
                    g == null -> { GameTabs(shogi); Text("読み込み中…", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    g.status == "open" || g.status == "offered" -> { GameTabs(shogi); PendingGame(shogi, g) }
                    // A board (and its WebView) per game: switching games starts a fresh page.
                    else -> androidx.compose.runtime.key(g.id) { GameView(store, g, visible, onScreen, boardMax = (maxHeight - GAME_BAND).coerceAtLeast(160.dp)) }
                }
            }
            // Notices float over the top and go by themselves (no extra row).
            shogi.notice?.let { n ->
                LaunchedEffect(n) { delay(3000); if (shogi.notice == n) shogi.notice = null }
                Surface(
                    color = MaterialTheme.colorScheme.inverseSurface, shape = RoundedCornerShape(8.dp), shadowElevation = 2.dp,
                    modifier = Modifier.align(Alignment.TopCenter).padding(horizontal = 12.dp, vertical = 2.dp).clickable { shogi.notice = null },
                ) {
                    Text(n, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.inverseOnSurface,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
                }
            }
        }
    }
}

/** The one band above the board. */
private val GAME_BAND = 40.dp

/** One game at a time (site-wide): ロビー and, when a game is on the board, that game. No switching UI. */
@Composable
private fun GameTabs(shogi: ShogiStore) {
    val sel = shogi.selected
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TabChip(if (sel == null) "ロビー" else "‹ ロビー", selected = sel == null) { shogi.select(null) }
        if (sel != null) {
            val my = shogi.myColorIn(sel)
            val mark = when { sel.isEnded -> "🎞 "; my != null -> ""; else -> "👀 " }
            TabChip(mark + ShogiLogic.vsText(sel), selected = true, alert = sel.isActive && my != null && sel.turn == my) {}
        }
    }
}

@Composable
private fun TabChip(text: String, selected: Boolean, alert: Boolean = false, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(50)
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        maxLines = 1,
        color = when { alert -> scheme.error; selected -> scheme.onSecondaryContainer; else -> scheme.onSurface },
        modifier = Modifier
            .background(if (selected) scheme.secondaryContainer else Color.Transparent, shape)
            .border(1.dp, scheme.outlineVariant, shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 5.dp),
    )
}

// MARK: lobby

/** Simple (drikin 2026-10-21「はやい、遅いも要らない」「シンプルなデザインに」): no game → two buttons;
 *  a game on the site (one at a time) → that one line and its button. Time control is always blitz. */
@Composable
private fun Lobby(store: ChatStore) {
    val shogi = store.shogi
    val live = shogi.liveGame
    val ended = shogi.games.filter { it.status == "ended" }.take(10)
    // A tapped button that goes away with the screen change hands focus on to the chat's
    // text field (and up comes the keyboard): drop the focus first.
    val focus = androidx.compose.ui.platform.LocalFocusManager.current

    Column(Modifier.padding(horizontal = 12.dp, vertical = 2.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        when {
            live != null -> LiveGameRow(shogi, live)
            shogi.canPlay -> Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
                Button(enabled = !shogi.busy, onClick = { focus.clearFocus(true); shogi.create("blitz") }) { Text("対局を募集") }
                if (shogi.beagle) FilledTonalButton(enabled = !shogi.busy, onClick = { focus.clearFocus(true); shogi.startBeagle("blitz") }) { Text("🐶 ビーグルと対局") }
            }
            else -> Text("いまは対局がありません", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (SHOW_RECENT && ended.isNotEmpty()) Section("最近の結果") {
            for (g in ended) GameRow(ShogiLogic.vsText(g), ShogiLogic.resultText(g)) {
                TextButton(onClick = { shogi.select(g.id) }) { Text("見る") }
            }
        }
    }
}

/** The one game on the site, in one line: 「対局中 ☗A vs ☖B」 [指す／観戦], 「募集中 A さん」 [受ける] … */
@Composable
private fun LiveGameRow(shogi: ShogiStore, g: ShogiGame) {
    val me = shogi.me
    val mine = g.creator.userId == me
    val toMe = g.status == "offered" && g.invitee?.userId == me
    val my = shogi.myColorIn(g)
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            when {
                g.isActive -> "対局中 ${ShogiLogic.vsText(g)}"
                toMe -> "${g.creator.name} さんから申し込み"
                g.status == "offered" && mine -> "申し込み中 ${g.invitee?.name ?: "?"} さん"
                g.status == "offered" -> "申し込み中 ${g.creator.name} → ${g.invitee?.name ?: "?"}"
                mine -> "募集中（あなた）"
                else -> "募集中 ${g.creator.name} さん"
            },
            style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
        )
        when {
            g.isActive -> Button(onClick = { focus.clearFocus(true); shogi.select(g.id) }, contentPadding = PaddingValues(horizontal = 14.dp)) { Text(if (my != null) "指す" else "観戦") }
            toMe -> if (shogi.canPlay) {
                Button(enabled = !shogi.busy, onClick = { focus.clearFocus(true); shogi.accept(g.id) }, contentPadding = PaddingValues(horizontal = 12.dp)) { Text("受ける") }
                OutlinedButton(enabled = !shogi.busy, onClick = { shogi.decline(g.id) }, contentPadding = PaddingValues(horizontal = 10.dp)) { Text("断る") }
            }
            mine -> {
                // Test: accept my own open game and play both sides.
                if (shogi.selfPlay && shogi.canPlay && g.status == "open") FilledTonalButton(enabled = !shogi.busy, onClick = { focus.clearFocus(true); shogi.accept(g.id) }, contentPadding = PaddingValues(horizontal = 10.dp)) { Text("自分と指す") }
                OutlinedButton(enabled = !shogi.busy, onClick = { shogi.cancel(g.id) }, contentPadding = PaddingValues(horizontal = 10.dp)) { Text("取り下げる") }
            }
            g.status == "open" -> if (shogi.canPlay) Button(enabled = !shogi.busy, onClick = { focus.clearFocus(true); shogi.accept(g.id) }, contentPadding = PaddingValues(horizontal = 14.dp)) { Text("受ける") }
            else -> Unit // someone else's offer to someone else: just wait
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant)
        content()
    }
}

@Composable
private fun GameRow(title: String, sub: String? = null, actions: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (sub != null) Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        actions()
    }
}

// MARK: an offer / open game on its own (from a notification)

@Composable
private fun PendingGame(shogi: ShogiStore, g: ShogiGame) {
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val toMe = g.invitee?.userId == shogi.me
        val mine = g.creator.userId == shogi.me
        Text(
            when {
                toMe -> "${g.creator.name} さんから対局の申し込み"
                mine && g.status == "offered" -> "${g.invitee?.name ?: "?"} さんに申し込み中"
                mine -> "募集中（あなた）"
                else -> "${g.creator.name} さんが募集中"
            },
            style = MaterialTheme.typography.bodyLarge,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if ((toMe || (!mine && g.status == "open")) && shogi.canPlay) Button(enabled = !shogi.busy, onClick = { shogi.accept(g.id) }) { Text("受ける") }
            if (toMe && shogi.canPlay) OutlinedButton(enabled = !shogi.busy, onClick = { shogi.decline(g.id) }) { Text("今はむり") }
            if (mine && shogi.selfPlay && shogi.canPlay && g.status == "open") FilledTonalButton(enabled = !shogi.busy, onClick = { shogi.accept(g.id) }) { Text("自分と指す（テスト）") }
            if (mine) OutlinedButton(enabled = !shogi.busy, onClick = { shogi.cancel(g.id) }) { Text("取り下げる") }
            TextButton(onClick = { shogi.select(null) }) { Text("ロビーへ") }
        }
    }
}

// MARK: a game (play / watch / result)

@Composable
private fun GameView(store: ChatStore, g: ShogiGame, visible: Boolean, onScreen: Boolean, boardMax: androidx.compose.ui.unit.Dp) {
    val shogi = store.shogi
    val my = shogi.myColorIn(g)
    val dark = isSystemInDarkTheme()
    var flip by remember(g.id) { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf(false) }
    var confirmResign by remember { mutableStateOf(false) }
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    val board = remember(g.id) { BoardHost() }

    // 観戦中の合図 every 30 s (players do not send it), only while the chat is on screen.
    LaunchedEffect(g.id, g.isActive, my, visible) {
        if (!g.isActive || my != null || !visible) return@LaunchedEffect
        while (true) { shogi.watch(g.id); delay(30_000) }
    }

    val orientation = flip ?: my ?: "black"
    val top = if (orientation == "black") "white" else "black"
    val canMove = g.isActive && my != null && g.turn == my && shogi.canPlay
    val compact = my == null || !g.isActive

    // The one band: ‹ (lobby), the game in a line (mode, moves, the last move, whose turn), ⋯.
    // (The board's own band — last move, ⇅ — is hidden: hide_band.)
    Row(Modifier.fillMaxWidth().height(GAME_BAND).padding(end = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = { focus.clearFocus(true); shogi.select(null) }, contentPadding = PaddingValues(horizontal = 8.dp),
            modifier = Modifier.height(36.dp).semantics { contentDescription = "ロビーへ" }) { Text("‹", style = MaterialTheme.typography.titleMedium) }
        val turnText = when {
            g.isEnded -> ShogiLogic.resultText(g)
            my != null -> if (g.turn == my) "あなたの番" else if (ShogiLogic.beagleSide(g) == g.turn) "ビーグルが考え中…🐶" else "相手の番"
            else -> "${if (g.turn == "black") "☗" else "☖"}の番"
        }
        Text(
            if (g.isEnded) "終局 $turnText"
            else "${g.ply}手" + (g.lastMove?.label?.takeIf { it.isNotBlank() }?.let { " $it" } ?: "") +
                "・$turnText" + (if (g.spectators > 0) " 👀${g.spectators}" else ""),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = if (g.isEnded || canMove) FontWeight.Bold else null,
            color = if (canMove) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        // Ended: the next step right in this band (no extra row: the board keeps its height).
        if (g.isEnded) {
            val again = my != null && shogi.canPlay && g.status == "ended" && g.black != null
            if (again && ShogiLogic.beagleSide(g) != null) {
                Button(enabled = !shogi.busy, onClick = { focus.clearFocus(true); shogi.startBeagle("blitz", rematchOf = g.id) }, contentPadding = PaddingValues(horizontal = 10.dp), modifier = Modifier.height(32.dp)) {
                    Text("🐶 もう一局", style = MaterialTheme.typography.labelMedium)
                }
            } else if (again) {
                Button(enabled = !shogi.busy, onClick = { focus.clearFocus(true); shogi.create("blitz", rematchOf = g.id) }, contentPadding = PaddingValues(horizontal = 10.dp), modifier = Modifier.height(32.dp)) {
                    Text("再戦", style = MaterialTheme.typography.labelMedium)
                }
            }
            TextButton(onClick = { focus.clearFocus(true); shogi.select(null) }, contentPadding = PaddingValues(horizontal = 8.dp), modifier = Modifier.height(32.dp)) { Text("閉じる", style = MaterialTheme.typography.labelMedium) }
        }
        Box {
            IconButton(onClick = { menu = true }, modifier = Modifier.size(36.dp).semantics { contentDescription = "将棋のメニュー" }) { Text("⋯", style = MaterialTheme.typography.titleLarge) }
            DropdownMenu(menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(text = { Text("盤を反転 ⇅") }, onClick = { menu = false; flip = if (orientation == "black") "white" else "black" })
                if (my != null && g.isActive) {
                    DropdownMenuItem(text = { Text((if (shogi.confirmMove) "✓ " else "　") + "指す前に確認") }, onClick = { shogi.setSettings(confirm = !shogi.confirmMove) })
                    DropdownMenuItem(text = { Text((if (shogi.moveHints) "✓ " else "　") + "駒の動きヒント") }, onClick = { shogi.setSettings(hints = !shogi.moveHints) })
                    if (g.ply < 2) DropdownMenuItem(text = { Text("取り消す（中断）") }, onClick = { menu = false; shogi.cancel(g.id) })
                    DropdownMenuItem(text = { Text("投了する…", color = MaterialTheme.colorScheme.error) }, onClick = { menu = false; confirmResign = true })
                }
                DropdownMenuItem(text = { Text("ロビーへ") }, onClick = { menu = false; shogi.select(null) })
            }
        }
    }

    val theme = if (dark) "dark" else "light"
    // The board takes this as a whole (it redraws and drops its 「送信中」 move); labels go separately.
    val state = ShogiLogic.stateMessage(
        sfen = g.sfen, myColor = my, canMove = canMove, lastMove = g.lastMove, orientation = orientation,
        confirmMove = shogi.confirmMove, moveHints = shogi.moveHints, compact = compact, theme = theme,
        topLabel = null, bottomLabel = null, hideBand = true,
    )
    // The board's size comes from the width; if that is taller than [boardMax] it shrinks itself
    // into max_height (the page's body has 6 px of padding above and below). The WebView is as tall
    // as the board says (its `size`): no blank around the name rows, no scrolling.
    val room = boardMax.value.toInt()
    ClockedBoard(g, shogi.skew, top, orientation, onScreen) { topLabel, bottomLabel ->
        ShogiBoardWeb(
            host = board,
            maxHeight = (room - BOARD_BODY_PADDING).coerceAtLeast(120),
            available = room,
            boardUrl = shogi.boardUrl,
            demo = shogi.demo,
            theme = theme,
            compact = compact,
            state = state,
            stateEpoch = shogi.boardEpoch,
            topLabel = topLabel,
            bottomLabel = bottomLabel,
            // ビーグルの実況: the band under the board (inside max_height: the chat keeps its room).
            commentary = shogi.commentaryFor(g.id),
            onMove = { usi, label -> if (canMove) shogi.move(g.id, usi, label, g.ply) },
            onFlip = { flip = it },
            modifier = Modifier.fillMaxWidth(),
        )
    }

    if (confirmResign) {
        AlertDialog(
            onDismissRequest = { confirmResign = false },
            title = { Text("投了しますか？") },
            text = { Text("${ShogiLogic.vsText(g)}（${g.ply} 手）") },
            confirmButton = { TextButton(onClick = { confirmResign = false; shogi.resign(g.id) }) { Text("投了する", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { confirmResign = false }) { Text("やめる") } },
        )
    }
}

/** The players' labels with the clock (blitz, in play: once a second), for [content]. Its own
 *  scope, so the tick redraws only the board's labels, not the whole game. It ticks only while
 *  the chat is (even partly) on screen and the app is in the foreground; back on screen it
 *  reads the time at once. */
@Composable
private fun ClockedBoard(
    g: ShogiGame, skew: Long, top: String, bottom: String, onScreen: Boolean,
    content: @Composable (topLabel: String, bottomLabel: String) -> Unit,
) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(g.id, g.isActive, g.mode, onScreen) {
        if (!onScreen) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (g.isActive && g.mode == "blitz") { now = System.currentTimeMillis(); delay(1000) }
        }
    }
    val clock = ShogiLogic.clockNow(g, skew, now)
    content(ShogiLogic.playerLabel(g, top, clock), ShogiLogic.playerLabel(g, bottom, clock))
}

// MARK: the board (WebView, bridge_version 1)

/** One board page. Lives while the game is on screen; destroyed with it. */
private class BoardHost {
    @Volatile var web: WebView? = null
    /** The page loaded is our board (the bridge answers only then). */
    @Volatile var allowed = false
    var ready by mutableStateOf(false)
    var heightCss by mutableIntStateOf(0)
    /** This board page draws ビーグルの実況 (`window.shogiBoard.features` has "commentary"). */
    var commentary by mutableStateOf(false)
    var onMessage: (ShogiLogic.BoardOut) -> Unit = {}

    fun send(msg: JsonObject) {
        val w = web ?: return
        if (!ready) return
        w.evaluateJavascript(ShogiLogic.receiveScript(msg), null)
    }
}

/** `ShogiBridge.postMessage(json)` from the page. Called on a WebView thread. */
private class ShogiBridgeJs(private val host: BoardHost) {
    @JavascriptInterface
    fun postMessage(json: String?) {
        if (json == null || !host.allowed) return
        val m = ShogiLogic.parseBoard(json) ?: return
        host.web?.post { if (host.allowed) host.onMessage(m) }
    }
}

/** What the board page may load: our /shogi-board/ files, nothing else (never a cookie or the token). */
internal object BoardFiles {
    private class Cached(val mime: String, val bytes: ByteArray, val at: Long)
    private val cache = ConcurrentHashMap<String, Cached>()
    private const val TTL_MS = 10 * 60_000L

    fun mimeOf(path: String) = when (path.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html"
        "js" -> "text/javascript"
        "ttf" -> "font/ttf"
        "txt" -> "text/plain"
        else -> "application/octet-stream"
    }

    fun forbidden() = WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private fun response(mime: String, bytes: ByteArray) =
        WebResourceResponse(mime, if (mime.startsWith("text/")) "utf-8" else null, 200, "OK", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(bytes))

    /** Served from the APK's demo copy (debug builds: public/shogi-board, see build.gradle.kts). */
    fun fromAssets(assets: AssetManager, rest: String): WebResourceResponse =
        runCatching { assets.open(rest).use { it.readBytes() } }.getOrNull()?.let { response(mimeOf(rest), it) } ?: forbidden()

    /** A disk copy of every file, always asked again (If-None-Match): an update shows at once,
     *  an unchanged file (the 🎮 BGM is 1 MB) comes back as a bodiless 304. The server's own
     *  headers are not kept — board.js / game.js say a year (immutable) under a fixed name. */
    @Volatile private var disk: OkHttpClient? = null
    private fun client(context: Context): OkHttpClient = disk ?: synchronized(this) {
        disk ?: Net.http.newBuilder()
            .cache(Cache(File(context.applicationContext.cacheDir, "board-files"), 8L * 1024 * 1024))
            .addNetworkInterceptor { chain ->
                chain.proceed(chain.request()).newBuilder()
                    .header("Cache-Control", "no-cache").removeHeader("Expires").removeHeader("Pragma").build()
            }
            .build().also { disk = it }
    }

    /** Fetched by the app (OkHttp, no cookie jar, no Authorization), so the page never carries either. */
    fun fromServer(context: Context, url: String, rest: String): WebResourceResponse {
        cache[url]?.takeIf { System.currentTimeMillis() - it.at < TTL_MS }?.let { return response(it.mime, it.bytes) }
        return runCatching {
            client(context).newCall(Request.Builder().url(url).get().build()).execute().use { r ->
                if (!r.isSuccessful) return@use null
                val bytes = r.body.bytes()
                val mime = mimeOf(rest)
                cache[url] = Cached(mime, bytes, System.currentTimeMillis())
                response(mime, bytes)
            }
        }.getOrNull() ?: WebResourceResponse("text/plain", "utf-8", 502, "Bad Gateway", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }
}

@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface", "ClickableViewAccessibility")
@Composable
private fun ShogiBoardWeb(
    host: BoardHost,
    boardUrl: String,
    demo: Boolean,
    theme: String,
    compact: Boolean,
    state: JsonObject,
    stateEpoch: Int,
    maxHeight: Int,
    available: Int,
    topLabel: String,
    bottomLabel: String,
    commentary: ShogiCommentary?,
    onMove: (String, String) -> Unit,
    onFlip: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val moveNow by rememberUpdatedState(onMove)
    val flipNow by rememberUpdatedState(onFlip)
    val stateNow by rememberUpdatedState(ShogiLogic.withMaxHeight(state, maxHeight))
    val labelsNow by rememberUpdatedState(topLabel to bottomLabel)
    val commentaryNow by rememberUpdatedState(commentary)
    val base = remember { Uri.parse(Net.BASE) }

    host.onMessage = { m ->
        when (m) {
            ShogiLogic.BoardOut.Ready -> {
                host.ready = true
                host.send(withLabels(stateNow, labelsNow))
                // A new page (first load, a recreated WebView, rotation): ask what it can do, then give it
                // the newest commentary. An older board has no `features`: it never gets the message.
                host.web?.evaluateJavascript(ShogiLogic.FEATURES_SCRIPT) { r ->
                    host.commentary = host.ready && ShogiLogic.boardHasCommentary(r)
                }
            }
            is ShogiLogic.BoardOut.Move -> moveNow(m.usi, m.label)
            is ShogiLogic.BoardOut.Haptic -> host.web?.let { haptic(it, m.kind) }
            is ShogiLogic.BoardOut.Flip -> flipNow(m.orientation)
            is ShogiLogic.BoardOut.Size -> host.heightCss = m.height
            ShogiLogic.BoardOut.Close -> Unit
            is ShogiLogic.BoardOut.Error -> android.util.Log.w("BguruShogi", "board: ${m.message}")
        }
    }

    // State: on every change (and after a refused move); labels (clock) every second, separately.
    LaunchedEffect(state, stateEpoch, maxHeight, host.ready) { if (host.ready) host.send(withLabels(stateNow, labelsNow)) }
    LaunchedEffect(topLabel, bottomLabel, host.ready) { if (host.ready) host.send(ShogiLogic.labelsMessage(topLabel, bottomLabel)) }
    // ビーグルの実況: its own message (it does not drop the board's 「送信中」 move); text null = no band.
    LaunchedEffect(commentary, host.commentary, host.ready) {
        if (host.ready && host.commentary) host.send(ShogiLogic.commentaryMessage(commentaryNow))
    }

    val url = remember(boardUrl) {
        Uri.parse(Net.BASE + boardUrl).buildUpon()
            .appendQueryParameter("theme", theme)
            .apply { if (compact) appendQueryParameter("compact", "1") }
            .build().toString()
    }
    val h = host.heightCss
    // Debug builds: say in the log whether the whole board is on screen (scripts/orientation-check.sh reads it).
    var shownCss by remember { mutableIntStateOf(-1) }
    if (BuildConfig.DEMO) LaunchedEffect(h, shownCss) {
        if (h > 0 && shownCss >= 0) android.util.Log.i("BguruShogi", "board-visible: ${ShogiLogic.boardVisibility(h + BOARD_BODY_PADDING, shownCss)} need=${h + BOARD_BODY_PADDING} shown=$shownCss")
    }
    val density = androidx.compose.ui.platform.LocalDensity.current.density
    AndroidView(
        // Exactly the board's height (its `size` + the body's padding), within the space it has.
        modifier = modifier.height((if (h > 0) minOf(h + BOARD_BODY_PADDING, available) else available).dp)
            .then(if (BuildConfig.DEMO) Modifier.onGloballyPositioned { c ->
                // What of the page is on screen: its own height, cut by every parent's bounds.
                val b = c.boundsInWindow()
                shownCss = kotlin.math.floor(minOf(c.size.height.toFloat(), b.height) / density + 0.5f).toInt()
            } else Modifier),
        factory = { ctx ->
            WebView(ctx).apply {
                host.web = this
                setBackgroundColor(AColor.TRANSPARENT)
                isVerticalScrollBarEnabled = false
                isHorizontalScrollBarEnabled = false
                overScrollMode = View.OVER_SCROLL_NEVER
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = false
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.javaScriptCanOpenWindowsAutomatically = false
                settings.setSupportMultipleWindows(false)
                settings.setSupportZoom(false)
                settings.builtInZoomControls = false
                settings.setGeolocationEnabled(false)
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                settings.cacheMode = WebSettings.LOAD_NO_CACHE
                CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
                // The board's drags (pieces) must not turn into the pager's page swipe.
                setOnTouchListener { v, e ->
                    if (e.actionMasked == MotionEvent.ACTION_DOWN) v.parent?.requestDisallowInterceptTouchEvent(true)
                    false
                }
                webViewClient = object : WebViewClient() {
                    private fun isBoard(u: Uri?) = u != null && u.scheme == "https" && u.host == base.host &&
                        (u.path ?: "").startsWith("/shogi-board/") && !(u.path ?: "").contains("..")

                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                        !isBoard(request.url) // no leaving the board

                    override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                        host.allowed = isBoard(url?.let(Uri::parse))
                        host.ready = false
                        host.commentary = false
                    }

                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                        val u = request.url
                        if (!isBoard(u) || request.method != "GET") return BoardFiles.forbidden()
                        val rest = (u.path ?: "").removePrefix("/shogi-board/")
                        if (rest.isEmpty()) return BoardFiles.forbidden()
                        return if (demo && BuildConfig.DEMO) BoardFiles.fromAssets(ctx.assets, "shogi-board/$rest")
                        else BoardFiles.fromServer(ctx, Uri.parse(Net.BASE + u.path).toString(), rest)
                    }
                }
                addJavascriptInterface(ShogiBridgeJs(host), "ShogiBridge")
                loadUrl(url)
            }
        },
        onRelease = { w ->
            host.allowed = false
            host.ready = false
            host.commentary = false
            host.web = null
            w.stopLoading()
            w.removeJavascriptInterface("ShogiBridge")
            w.destroy()
        },
    )
    DisposableEffect(Unit) { onDispose { host.onMessage = {} } }
}

private fun withLabels(state: JsonObject, labels: Pair<String, String>): JsonObject =
    JsonObject(state + mapOf("top_label" to kotlinx.serialization.json.JsonPrimitive(labels.first), "bottom_label" to kotlinx.serialization.json.JsonPrimitive(labels.second)))

private fun haptic(v: View, kind: String) {
    val c = when (kind) {
        "select" -> HapticFeedbackConstants.CLOCK_TICK
        "move" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
        else -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
    }
    v.performHapticFeedback(c)
}

// MARK: chat

/** The chat's game card (kind "shogi"), small: one or two lines — 「☗A vs ☖B 対局中 ⚡ 12手 [観戦]」, and
 *  an ended game just its result. Redrawn by `shogi` events through the store. */
@Composable
fun ShogiChatCard(store: ChatStore, m: ChatMessage, modifier: Modifier = Modifier) {
    val shogi = store.shogi
    val id = m.shogiGameId ?: return
    val g = shogi.games.firstOrNull { it.id == id }
    val live = g != null && g.isActive
    Row(
        modifier
            .border(1.dp, ShogiGreen.copy(alpha = 0.45f), RoundedCornerShape(8.dp))
            .clickable { store.openShogi(id) }
            .padding(start = 10.dp, end = 4.dp, top = 2.dp, bottom = 2.dp)
            .widthIn(max = 420.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            when {
                g == null -> m.body
                live -> "${ShogiLogic.vsText(g!!)} 対局中 ${g.ply}手"
                g!!.isEnded -> "☗ ${ShogiLogic.vsText(g)}　${ShogiLogic.resultText(g)}"
                else -> m.body
            },
            style = MaterialTheme.typography.bodySmall,
            maxLines = if (live) 2 else 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false).padding(vertical = 6.dp),
        )
        if (live) {
            TextButton(onClick = { store.openShogi(id) }, contentPadding = PaddingValues(horizontal = 8.dp), modifier = Modifier.height(32.dp)) {
                Text(if (shogi.myColorIn(g!!) != null) "指す" else "観戦", style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

/** 9×9 dots: 先手 dark, 後手 light (no letters at 96 dp). */
@Composable
fun MiniBoard(sfen: String, size: androidx.compose.ui.unit.Dp = 96.dp) {
    val cells = remember(sfen) { ShogiLogic.miniCells(sfen) }
    Canvas(Modifier.size(size).semantics { contentDescription = "盤の様子" }) {
        drawRoundRect(Color(0xFFE9C98A), cornerRadius = androidx.compose.ui.geometry.CornerRadius(4.dp.toPx()))
        val c = this.size.width / 9f
        for (i in 0 until 81) {
            val v = cells[i]
            if (v == 0) continue
            val center = Offset((i % 9) * c + c / 2, (i / 9) * c + c / 2)
            drawCircle(if (v == 1) Color(0xFF2B1D0E) else Color(0xFFFFF8E6), radius = c * 0.36f, center = center)
            if (v == 2) drawCircle(Color(0xFF8A6A36), radius = c * 0.36f, center = center, style = Stroke(0.8.dp.toPx()))
        }
    }
}

/** The board page's body padding (index.html: 6 px above and below). */
private const val BOARD_BODY_PADDING = 12

/** Hidden for now (drikin 2026-10-21「最近の結果は一旦非表示」); the server keeps them. */
private const val SHOW_RECENT = false
