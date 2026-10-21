package fm.backspace.bguru.chat

import android.annotation.SuppressLint
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
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject
import okhttp3.Request
import java.io.ByteArrayInputStream
import java.util.concurrent.ConcurrentHashMap

/** ☗ 将棋 UI (docs/shogi-spec.md): the mode switch without the room, the panel above the chat
 *  (lobby / board / result), the board's WebView, the chat's game card and the folded chat line. */

private val ShogiGreen = Color(0xFF16A34A)

// MARK: switch (when the room is off for this member: テキスト｜☗ 将棋)

@Composable
fun ShogiModeSwitch(shogi: ShogiStore) {
    ShogiBackHandler(shogi)
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.Center) {
        SingleChoiceSegmentedButtonRow(Modifier.width(220.dp).height(32.dp)) {
            SegmentedButton(selected = !shogi.open, onClick = { shogi.open = false }, shape = SegmentedButtonDefaults.itemShape(0, 2), icon = {}) {
                Text("テキスト", style = MaterialTheme.typography.labelSmall)
            }
            SegmentedButton(selected = shogi.open, onClick = { shogi.open = true }, shape = SegmentedButtonDefaults.itemShape(1, 2), icon = {}) {
                ShogiSegmentLabel(shogi)
            }
        }
    }
}

/** 「☗ 将棋」 with what waits for me (offers + my turn) or how many games are on. */
@Composable
fun ShogiSegmentLabel(shogi: ShogiStore) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        Text("☗ 将棋", style = MaterialTheme.typography.labelSmall, maxLines = 1)
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

@Composable
fun ShogiPanel(store: ChatStore, visible: Boolean, modifier: Modifier = Modifier) {
    val shogi = store.shogi
    Surface(modifier, color = MaterialTheme.colorScheme.surfaceContainerLow) {
        // Lobby: scrolls. A game: the board takes what is left (passed to it as max_height).
        Column(Modifier.fillMaxSize()) {
            GameTabs(shogi)
            shogi.notice?.let { n ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(n, style = MaterialTheme.typography.bodySmall, color = Color(0xFFE08A00), modifier = Modifier.weight(1f))
                    TextButton(onClick = { shogi.notice = null }, contentPadding = PaddingValues(horizontal = 6.dp)) { Text("✕") }
                }
            }
            val g = shogi.selected
            when {
                shogi.selectedId == null -> Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) { Lobby(store) }
                g == null -> Text("読み込み中…", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                g.status == "open" || g.status == "offered" -> Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) { PendingGame(shogi, g) }
                // A board (and its WebView) per game: switching games starts a fresh page.
                else -> Column(Modifier.weight(1f).fillMaxWidth()) { androidx.compose.runtime.key(g.id) { GameView(store, g, visible) } }
            }
        }
    }
}

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
            val mark = when { sel.isEnded -> "🎞 "; my != null -> ShogiLogic.modeMark(sel.mode) + " "; else -> "👀 " }
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

@Composable
private fun Lobby(store: ChatStore) {
    val shogi = store.shogi
    val live = shogi.liveGame
    val ended = shogi.games.filter { it.status == "ended" }.take(10)
    var inviting by remember { mutableStateOf(false) }

    Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (live != null) {
            // One game at a time, site-wide, first come first served: no new offers while one is up.
            Text(
                "対局は 1 局ずつです。募集中の対局を受けるか、対局中なら観戦してください",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            LiveGameCard(shogi, live)
        } else if (shogi.canPlay) {
            Section("対局を申し込む") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(enabled = !shogi.busy, onClick = { shogi.create("blitz") }, contentPadding = PaddingValues(horizontal = 14.dp)) { Text("⚡ 速い") }
                    FilledTonalButton(enabled = !shogi.busy, onClick = { shogi.create("slow") }, contentPadding = PaddingValues(horizontal = 14.dp)) { Text("🐢 ゆっくり") }
                    if (SHOW_INVITE) OutlinedButton(enabled = !shogi.busy, onClick = { inviting = true }, contentPadding = PaddingValues(horizontal = 12.dp)) { Text("指名…") }
                }
                Text(
                    "⚡ 10 分、使い切ったら 1 手 30 秒　🐢 時間制限なし（72 時間指さないと負け）。先後は振り駒。募集は 15 分で期限切れ。対局はサイト全体で 1 局ずつ（早い者勝ち）。",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            Text("いまは対局がありません。このトークンでは観戦だけできます（指すにはログインし直してください）", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (SHOW_RECENT && ended.isNotEmpty()) Section("最近の結果") {
            for (g in ended) GameRow(ShogiLogic.vsText(g), ShogiLogic.resultText(g)) {
                TextButton(onClick = { shogi.select(g.id) }) { Text("見る") }
            }
        }
        Spacer(Modifier.height(4.dp))
    }
    if (inviting) InviteDialog(store) { inviting = false }
}

/** The one game on the site, big: 受ける / 今はむり / 取り下げる / 指す / 観戦する. */
@Composable
private fun LiveGameCard(shogi: ShogiStore, g: ShogiGame) {
    val me = shogi.me
    val mine = g.creator.userId == me
    val toMe = g.status == "offered" && g.invitee?.userId == me
    val my = shogi.myColorIn(g)
    Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            if (g.isActive) MiniBoard(g.sfen, 72.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    when {
                        g.isActive -> ShogiLogic.vsText(g)
                        toMe -> "${g.creator.name} さんから対局の申し込み"
                        g.status == "offered" && mine -> "${g.invitee?.name ?: "?"} さんに申し込み中"
                        g.status == "offered" -> "${g.creator.name} さんが ${g.invitee?.name ?: "?"} さんに申し込み中"
                        mine -> "募集中（あなた）"
                        else -> "${g.creator.name} さんが募集中"
                    },
                    style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold,
                )
                Text(
                    ShogiLogic.modeLabel(g.mode) + (if (g.isActive) "・${g.ply} 手" + (if (g.spectators > 0) "・👀${g.spectators}" else "") +
                        (if (my != null) (if (g.turn == my) "・あなたの番" else "・相手の番") else "") else "") + (if (g.rematchOf != null) "・再戦" else ""),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    when {
                        g.isActive -> Button(onClick = { shogi.select(g.id) }) { Text(if (my != null) "指す" else "観戦する") }
                        toMe -> {
                            if (shogi.canPlay) Button(enabled = !shogi.busy, onClick = { shogi.accept(g.id) }) { Text("受ける") }
                            if (shogi.canPlay) OutlinedButton(enabled = !shogi.busy, onClick = { shogi.decline(g.id) }) { Text("今はむり") }
                        }
                        mine -> {
                            // Test: accept my own open game and play both sides.
                            if (shogi.selfPlay && shogi.canPlay && g.status == "open") FilledTonalButton(enabled = !shogi.busy, onClick = { shogi.accept(g.id) }) { Text("自分と指す（テスト）") }
                            OutlinedButton(enabled = !shogi.busy, onClick = { shogi.cancel(g.id) }) { Text("取り下げる") }
                        }
                        g.status == "open" -> if (shogi.canPlay) Button(enabled = !shogi.busy, onClick = { shogi.accept(g.id) }) { Text("受ける") }
                        else -> Unit // someone else's offer to someone else: just wait
                    }
                }
            }
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

/** 指名: the member list (the one place to pick an opponent). */
@Composable
private fun InviteDialog(store: ChatStore, onDismiss: () -> Unit) {
    val shogi = store.shogi
    var mode by remember { mutableStateOf("blitz") }
    var q by remember { mutableStateOf("") }
    val people = store.members.filter { it.userId != shogi.me && it.name != "ビーグル" && it.name.contains(q.trim(), ignoreCase = true) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("相手を指名") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    SegmentedButton(selected = mode == "blitz", onClick = { mode = "blitz" }, shape = SegmentedButtonDefaults.itemShape(0, 2), icon = {}) { Text("⚡ 速い") }
                    SegmentedButton(selected = mode == "slow", onClick = { mode = "slow" }, shape = SegmentedButtonDefaults.itemShape(1, 2), icon = {}) { Text("🐢 ゆっくり") }
                }
                OutlinedTextField(q, { q = it }, singleLine = true, placeholder = { Text("名前で探す") }, modifier = Modifier.fillMaxWidth())
                LazyColumn(Modifier.heightIn(max = 300.dp)) {
                    if (people.isEmpty()) item { Text(if (store.members.isEmpty()) "読み込み中…" else "見つかりません", color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    items(people, key = { it.userId }) { m ->
                        Text(
                            m.name,
                            Modifier.fillMaxWidth().clickable { shogi.create(mode, m.userId, inviteeName = m.name); onDismiss() }.padding(vertical = 10.dp),
                            style = MaterialTheme.typography.bodyLarge,
                        )
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("やめる") } },
    )
}

// MARK: an offer / open game on its own (from a notification)

@Composable
private fun PendingGame(shogi: ShogiStore, g: ShogiGame) {
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val toMe = g.invitee?.userId == shogi.me
        val mine = g.creator.userId == shogi.me
        Text(
            when {
                toMe -> "${g.creator.name} さんから対局の申し込み（${ShogiLogic.modeLabel(g.mode)}）"
                mine && g.status == "offered" -> "${g.invitee?.name ?: "?"} さんに申し込み中（${ShogiLogic.modeLabel(g.mode)}）"
                mine -> "募集中（${ShogiLogic.modeLabel(g.mode)}）"
                else -> "${g.creator.name} さんが募集中（${ShogiLogic.modeLabel(g.mode)}）"
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
private fun androidx.compose.foundation.layout.ColumnScope.GameView(store: ChatStore, g: ShogiGame, visible: Boolean) {
    val shogi = store.shogi
    val my = shogi.myColorIn(g)
    val dark = isSystemInDarkTheme()
    var flip by remember(g.id) { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf(false) }
    var confirmResign by remember { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val board = remember(g.id) { BoardHost() }

    // The clock (blitz, in play): once a second.
    LaunchedEffect(g.id, g.isActive, g.mode) {
        while (g.isActive && g.mode == "blitz") { now = System.currentTimeMillis(); delay(1000) }
    }
    // 観戦中の合図 every 30 s (players do not send it), only while the chat is on screen.
    LaunchedEffect(g.id, g.isActive, my, visible) {
        if (!g.isActive || my != null || !visible) return@LaunchedEffect
        while (true) { shogi.watch(g.id); delay(30_000) }
    }

    val orientation = flip ?: my ?: "black"
    val top = if (orientation == "black") "white" else "black"
    val clock = ShogiLogic.clockNow(g, shogi.skew, now)
    val topLabel = ShogiLogic.playerLabel(g, top, clock)
    val bottomLabel = ShogiLogic.playerLabel(g, orientation, clock)
    val canMove = g.isActive && my != null && g.turn == my && shogi.canPlay
    val compact = my == null || !g.isActive

    // Top band: what game, whose turn, ⋯.
    Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            val turnText = when {
                g.isEnded -> ShogiLogic.resultText(g)
                my != null -> if (g.turn == my) "あなたの番" else "相手の番"
                else -> "${if (g.turn == "black") "☗" else "☖"}の番"
            }
            Text(
                "${ShogiLogic.modeLabel(g.mode)}・${g.ply} 手" + (if (g.spectators > 0) "・👀${g.spectators}" else "") + "・$turnText",
                style = MaterialTheme.typography.labelMedium,
                color = if (canMove) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            // (The last move is on the board's own band: no second line here, the board needs the height.)
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

    if (g.isEnded) {
        Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
            Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("終局　${ShogiLogic.resultText(g)}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Bold)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (my != null && shogi.canPlay && g.status == "ended" && g.black != null) {
                        Button(enabled = !shogi.busy, onClick = { shogi.create(g.mode, rematchOf = g.id) }, contentPadding = PaddingValues(horizontal = 12.dp)) { Text("再戦（先後交代）") }
                    }
                    OutlinedButton(onClick = { shogi.select(null) }) { Text("閉じる") }
                }
            }
        }
    }

    val theme = if (dark) "dark" else "light"
    // The board takes this as a whole (it redraws and drops its 「送信中」 move); labels go separately.
    val state = ShogiLogic.stateMessage(
        sfen = g.sfen, myColor = my, canMove = canMove, lastMove = g.lastMove, orientation = orientation,
        confirmMove = shogi.confirmMove, moveHints = shogi.moveHints, compact = compact, theme = theme,
        topLabel = null, bottomLabel = null,
    )
    // The board fits the rest of the panel (the page's body has 6 px of padding above and below).
    // If the board cannot get that small (its smallest squares), the rest scrolls rather than being cut off.
    androidx.compose.foundation.layout.BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
    val room = maxHeight.value.toInt()
    Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.TopCenter) {
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
        onMove = { usi, label -> if (canMove) shogi.move(g.id, usi, label, g.ply) },
        onFlip = { flip = it },
        modifier = Modifier.fillMaxWidth(),
    )
    }
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

// MARK: the board (WebView, bridge_version 1)

/** One board page. Lives while the game is on screen; destroyed with it. */
private class BoardHost {
    @Volatile var web: WebView? = null
    /** The page loaded is our board (the bridge answers only then). */
    @Volatile var allowed = false
    var ready by mutableStateOf(false)
    var heightCss by mutableIntStateOf(0)
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
private object BoardFiles {
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

    /** Fetched by the app (OkHttp, no cookie jar, no Authorization), so the page never carries either. */
    fun fromServer(url: String, rest: String): WebResourceResponse {
        cache[url]?.takeIf { System.currentTimeMillis() - it.at < TTL_MS }?.let { return response(it.mime, it.bytes) }
        return runCatching {
            Net.http.newCall(Request.Builder().url(url).get().build()).execute().use { r ->
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
    onMove: (String, String) -> Unit,
    onFlip: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val moveNow by rememberUpdatedState(onMove)
    val flipNow by rememberUpdatedState(onFlip)
    // The board shrinks by an estimate and can come out a little taller than max_height: ask
    // again for less by what it went over (a few rounds at most, and only while it still shrinks).
    var over by remember(maxHeight) { mutableIntStateOf(0) }
    var lastSize by remember(maxHeight) { mutableIntStateOf(Int.MAX_VALUE) }
    val fitTo = maxHeight - over
    val stateNow by rememberUpdatedState(ShogiLogic.withMaxHeight(state, fitTo))
    val labelsNow by rememberUpdatedState(topLabel to bottomLabel)
    val base = remember { Uri.parse(Net.BASE) }

    host.onMessage = { m ->
        when (m) {
            ShogiLogic.BoardOut.Ready -> {
                host.ready = true
                host.send(withLabels(stateNow, labelsNow))
            }
            is ShogiLogic.BoardOut.Move -> moveNow(m.usi, m.label)
            is ShogiLogic.BoardOut.Haptic -> host.web?.let { haptic(it, m.kind) }
            is ShogiLogic.BoardOut.Flip -> flipNow(m.orientation)
            is ShogiLogic.BoardOut.Size -> {
                host.heightCss = m.height
                val shrank = m.height < lastSize
                lastSize = m.height
                // Only the estimate's small error (the first report comes before max_height applies).
                val by = m.height - maxHeight
                if (by in 1..60 && shrank && over < 120) over += by
            }
            ShogiLogic.BoardOut.Close -> Unit
            is ShogiLogic.BoardOut.Error -> android.util.Log.w("BguruShogi", "board: ${m.message}")
        }
    }

    // State: on every change (and after a refused move); labels (clock) every second, separately.
    LaunchedEffect(state, stateEpoch, fitTo, host.ready) { if (host.ready) host.send(withLabels(stateNow, labelsNow)) }
    LaunchedEffect(topLabel, bottomLabel, host.ready) { if (host.ready) host.send(ShogiLogic.labelsMessage(topLabel, bottomLabel)) }

    val url = remember(boardUrl) {
        Uri.parse(Net.BASE + boardUrl).buildUpon()
            .appendQueryParameter("theme", theme)
            .apply { if (compact) appendQueryParameter("compact", "1") }
            .build().toString()
    }
    val h = host.heightCss
    AndroidView(
        modifier = modifier.height((if (h > 0) h + BOARD_BODY_PADDING else available).dp),
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
                    }

                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                        val u = request.url
                        if (!isBoard(u) || request.method != "GET") return BoardFiles.forbidden()
                        val rest = (u.path ?: "").removePrefix("/shogi-board/")
                        if (rest.isEmpty()) return BoardFiles.forbidden()
                        return if (demo && BuildConfig.DEMO) BoardFiles.fromAssets(ctx.assets, rest)
                        else BoardFiles.fromServer(Uri.parse(Net.BASE + u.path).toString(), rest)
                    }
                }
                addJavascriptInterface(ShogiBridgeJs(host), "ShogiBridge")
                loadUrl(url)
            }
        },
        onRelease = { w ->
            host.allowed = false
            host.ready = false
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

/** The chat's game card (kind "shogi"): the little board (dots only) and 観戦する. Redrawn by
 *  `shogi` events through the store (the message itself is not rewritten move by move). */
@Composable
fun ShogiChatCard(store: ChatStore, m: ChatMessage, modifier: Modifier = Modifier) {
    val shogi = store.shogi
    val id = m.shogiGameId ?: return
    val g = shogi.games.firstOrNull { it.id == id }
    Row(
        modifier
            .border(1.dp, ShogiGreen.copy(alpha = 0.45f), RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerLow, RoundedCornerShape(10.dp))
            .clickable { store.openShogi(id) }
            .padding(8.dp)
            .widthIn(max = 360.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (g != null) MiniBoard(g.sfen)
        Column(Modifier.weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                if (g != null && g.isActive) "${ShogiLogic.vsText(g)}（${ShogiLogic.modeLabel(g.mode)}）${g.ply} 手目" else m.body,
                style = MaterialTheme.typography.bodySmall,
            )
            if (g != null && g.isActive && g.lastMove != null) {
                Text("最後の手 ${g.lastMove.label}" + if (g.spectators > 0) "・👀${g.spectators}" else "",
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            FilledTonalButton(onClick = { store.openShogi(id) }, contentPadding = PaddingValues(horizontal = 12.dp), modifier = Modifier.height(32.dp)) {
                Text(
                    when {
                        g == null || g.isEnded -> "盤で見る"
                        shogi.myColorIn(g) != null -> "盤を開く"
                        else -> "観戦する"
                    },
                    style = MaterialTheme.typography.labelMedium,
                )
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

/** Hidden for now (drikin 2026-10-21「相手を指定と最近の結果は一旦非表示」); the server keeps both. */
private const val SHOW_INVITE = false
private const val SHOW_RECENT = false
