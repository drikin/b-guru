package fm.backspace.bguru.chat

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Email
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** ✉️ in the chat's top bar: opens the DM list; the badge is the unread total. */
@Composable
fun DMHeaderButton(dm: DMStore) {
    if (!dm.enabled) return
    IconButton(onClick = { dm.openList() }) {
        BadgedBox(badge = {
            if (dm.unreadTotal > 0) Badge(containerColor = Color(0xFFDC2626), contentColor = Color.White) {
                Text(if (dm.unreadTotal > 99) "99+" else "${dm.unreadTotal}")
            }
        }) {
            Icon(Icons.Default.Email, contentDescription = if (dm.unreadTotal > 0) "DM（未読 ${dm.unreadTotal}）" else "DM")
        }
    }
}

/** A member's avatar / name in the chat: tap or long-press offers 「DM を送る」. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun DMOffer(onDM: (() -> Unit)?, content: @Composable () -> Unit) {
    if (onDM == null) { content(); return }
    var menu by remember { mutableStateOf(false) }
    Box(Modifier.combinedClickable(onClick = { menu = true }, onLongClick = { menu = true })) {
        content()
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text("DM を送る") }, leadingIcon = { Icon(Icons.Default.Email, null) },
                onClick = { menu = false; onDM() })
        }
    }
}

/** The DM screens over the whole app (list → conversation). Nothing when no DM is open. */
@Composable
fun DMOverlay(dm: DMStore) {
    val route = dm.route ?: return
    BackHandler { dm.back() }
    // Hide what passes the 24 hours while it stays open.
    LaunchedEffect(dm) { while (true) { delay(60_000); dm.prune() } }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        when (route) {
            DMStore.Route.Inbox -> DMInbox(dm)
            is DMStore.Route.Conversation -> androidx.compose.runtime.key(route.peer.userId) { DMConversationScreen(dm, route.peer) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DMInbox(dm: DMStore) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("DM", maxLines = 1) },
                navigationIcon = { IconButton(onClick = { dm.back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "戻る") } },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            Text(
                "DM は 24 時間で消えます。チャットで相手の名前やアイコンをタップすると送れます。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
            )
            HorizontalDivider()
            if (dm.conversations.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                    Text(if (dm.listLoaded) "まだ DM はありません" else "読み込み中…",
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 40.dp))
                }
            } else {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                    items(dm.conversations, key = { it.peer.userId }) { c ->
                        DMConversationRow(c) { dm.openConversation(c.peer) }
                        HorizontalDivider(Modifier.padding(start = 68.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun DMConversationRow(c: DMConversation, onClick: () -> Unit) {
    val unread = c.unreadCount > 0
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(ApiClient.absolute(c.peer.avatar) ?: c.peer.avatar, c.peer.displayName, 40.dp)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(c.peer.displayName, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(remember(c.lastMessage.createdAt) { dmTime(c.lastMessage.createdAt, withDay = true) },
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    DMLogic.preview(c.lastMessage),
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (unread) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                if (unread) {
                    Spacer(Modifier.size(8.dp))
                    Badge(containerColor = AccentGreen, contentColor = Color.White) { Text(if (c.unreadCount > 99) "99+" else "${c.unreadCount}") }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DMConversationScreen(dm: DMStore, peer: DMPeer) {
    val context = LocalContext.current
    val listState = rememberLazyListState()
    var draft by rememberSaveable(peer.userId) { mutableStateOf("") }

    // On screen (resumed) = read: tells the store, and clears this person's notification.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, peer.userId) {
        fun on() { dm.setScreenVisible(peer.userId, true); Push.clearDMNotification(context, peer.userId) }
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) on()
        val obs = LifecycleEventObserver { _, e ->
            when (e) {
                Lifecycle.Event.ON_RESUME -> on()
                Lifecycle.Event.ON_PAUSE -> dm.setScreenVisible(peer.userId, false)
                else -> Unit
            }
        }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs); dm.setScreenVisible(peer.userId, false) }
    }

    // Newest at the bottom (reverseLayout: index 0 is the newest). Follow new bubbles while at the
    // bottom, and always after sending.
    LaunchedEffect(dm) {
        snapshotFlow { dm.rows.lastOrNull()?.key }.distinctUntilChanged().collect {
            val last = dm.rows.lastOrNull() ?: return@collect
            if (listState.firstVisibleItemIndex <= 1 || last.message.isAuthor) listState.animateScrollToItem(0)
        }
    }

    val shown = dm.openPeer ?: peer
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Avatar(ApiClient.absolute(shown.avatar) ?: shown.avatar, shown.displayName, 32.dp)
                        Text(shown.displayName, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                },
                navigationIcon = { IconButton(onClick = { dm.back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "戻る") } },
            )
        },
        contentWindowInsets = WindowInsets(0),
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            LazyColumn(
                state = listState,
                reverseLayout = true,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.Bottom),
            ) {
                val reversed = dm.rows.asReversed()
                if (reversed.isEmpty()) {
                    item {
                        Text(if (dm.threadLoaded) "${shown.displayName}さんとの DM はまだありません" else "読み込み中…",
                            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 40.dp))
                    }
                }
                items(reversed, key = { it.key }, contentType = { if (it.message.isAuthor) "mine" else "theirs" }) { row ->
                    DMBubble(row, onRetry = { dm.retry(row) }, onDiscard = { dm.discard(row) },
                        modifier = Modifier.widthIn(max = 760.dp).fillMaxWidth())
                }
            }
            HorizontalDivider()
            DMComposer(
                dm = dm,
                draft = draft,
                onDraft = { draft = it.take(dm.maxBody) },
                onSend = {
                    val text = draft
                    draft = ""
                    dm.send(text) { body -> if (draft.isEmpty()) draft = body }
                },
            )
        }
    }
}

@Composable
private fun DMBubble(row: DMRow, onRetry: () -> Unit, onDiscard: () -> Unit, modifier: Modifier) {
    val m = row.message
    val mine = m.isAuthor
    Column(modifier, horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
        Column(
            Modifier.padding(start = if (mine) 48.dp else 0.dp, end = if (mine) 0.dp else 48.dp),
            horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
        ) {
            Text(
                remember(m.body) { linkified(m.body) },
                fontSize = 16.sp,
                modifier = Modifier
                    .background(if (mine) AccentGreen.copy(alpha = 0.14f) else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f), RoundedCornerShape(12.dp))
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
                when (row.state) {
                    SendState.FAILED -> {
                        Text("送信できませんでした", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                        Text("再送", style = MaterialTheme.typography.labelMedium, color = AccentGreen, modifier = Modifier.clickable(onClick = onRetry))
                        Text("取り消す", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.clickable(onClick = onDiscard))
                    }
                    SendState.PENDING -> Text("送信中…", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                    SendState.SENT -> Text(remember(m.createdAt) { dmTime(m.createdAt, withDay = true) }, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                }
            }
        }
    }
}

@Composable
private fun DMComposer(dm: DMStore, draft: String, onDraft: (String) -> Unit, onSend: () -> Unit) {
    val allowed = dm.canSendCap && dm.canSendHere
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 760.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                dm.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                if (!allowed) {
                    Text(
                        if (!dm.canSendCap) "このアプリからは DM を送れません（読むだけ）" else "この人にはまだ DM を送れません",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextField(
                        value = draft,
                        onValueChange = onDraft,
                        enabled = allowed,
                        placeholder = { Text("DM（24 時間で消えます）") },
                        maxLines = 6,
                        shape = RoundedCornerShape(20.dp),
                        colors = TextFieldDefaults.colors(focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent),
                        modifier = Modifier.weight(1f),
                    )
                    val canSend = allowed && draft.isNotBlank()
                    IconButton(onClick = onSend, enabled = canSend) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "送信", tint = if (canSend) AccentGreen else MaterialTheme.colorScheme.outline)
                    }
                }
                Row {
                    Text("DM は 24 時間で消えます", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline, modifier = Modifier.weight(1f))
                    if (draft.length > dm.maxBody * 0.8) Text("${draft.length} / ${dm.maxBody}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                }
            }
        }
    }
}

private val DM_HM = DateTimeFormatter.ofPattern("H:mm").withZone(ZoneId.systemDefault())
private val DM_MDHM = DateTimeFormatter.ofPattern("M/d H:mm").withZone(ZoneId.systemDefault())

/** "H:mm" today; "M/d H:mm" for yesterday's (the list), since DMs last 24 hours. */
private fun dmTime(iso: String, withDay: Boolean): String = runCatching {
    val t = Instant.parse(iso)
    val zone = ZoneId.systemDefault()
    if (!withDay || t.atZone(zone).toLocalDate() == LocalDate.now(zone)) DM_HM.format(t) else DM_MDHM.format(t)
}.getOrDefault("")
