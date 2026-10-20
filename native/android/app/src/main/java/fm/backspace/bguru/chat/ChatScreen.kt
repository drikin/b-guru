package fm.backspace.bguru.chat

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

internal val QUICK = listOf("❤️", "👍", "😂", "🎉", "🙏", "👀")
internal val MORE = listOf("😮", "😢", "🔥", "💯", "👏", "🤔")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(store: ChatStore, onSignOut: () -> Unit, tabSwitch: (@Composable () -> Unit)? = null, visible: Boolean = true) {
    val context = LocalContext.current
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val d = remember { Draft() }
    val photos = remember { ChatAttachments() }
    var viewing by remember { mutableStateOf<Pair<List<String>, Int>?>(null) }
    var editingId by remember { mutableStateOf<Long?>(null) }
    val focus = remember { FocusRequester() }
    var refreshing by remember { mutableStateOf(false) }
    var selecting by remember { mutableStateOf<ChatMessage?>(null) }
    // What was just sent, to swallow a late echo of it (voice input finalising after Send).
    var justSent by remember { mutableStateOf<Pair<String, Long>?>(null) }

    // The page itself may be off screen (phone pager): only then is it "visible" for read marking.
    val visibleNow by androidx.compose.runtime.rememberUpdatedState(visible)
    LaunchedEffect(visible) {
        if (lifecycleIsResumed(context)) store.isVisible = visible
        if (visible) Push.clearChatNotifications(context)
    }
    // Foreground ↔ background: read marking and a quick reconnect.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, store) {
        val obs = LifecycleEventObserver { _, e ->
            when (e) {
                Lifecycle.Event.ON_START -> store.start()
                Lifecycle.Event.ON_RESUME -> { store.isVisible = visibleNow; if (visibleNow) Push.clearChatNotifications(context) }
                Lifecycle.Event.ON_PAUSE -> store.isVisible = false
                Lifecycle.Event.ON_STOP -> store.pause()
                else -> Unit
            }
        }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs) }
    }

    val rows = store.rows
    // Newest at the bottom; the list is laid out bottom-up (reverseLayout), so
    // index 0 is the newest message and "scroll to bottom" is scroll to 0.
    val reversed = remember(rows) { rows.asReversed() }

    // Where the list scrolls (drikin 2026-10-19, from member feedback): it follows new
    // messages only while at the bottom (or after sending); reading further up it stays
    // put and a "↓ 新着 N" button appears. Coming on screen with unread messages, it
    // opens at the first one, at the top of the view (or the bottom when they all fit).
    val atBottom by remember {
        derivedStateOf { listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset < 24 }
    }
    var newBelow by remember { mutableIntStateOf(0) }
    var prevLastKey by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(rows.lastOrNull()?.key) {
        val last = rows.lastOrNull() ?: return@LaunchedEffect
        val before = prevLastKey
        prevLastKey = last.key
        // First list: a bottom-up list already starts at the bottom (or opens at the unread line).
        if (before == null || store.scrollTarget != null) return@LaunchedEffect
        // The list keeps the item that was at the bottom in place, so the new one is below it.
        val first = listState.layoutInfo.visibleItemsInfo.firstOrNull()
        val wasAtBottom = first == null || atBottom ||
            (first.key == before && listState.firstVisibleItemScrollOffset < 24)
        val mineSending = last.message.isAuthor && last.message.id < 0
        if (wasAtBottom || mineSending) listState.animateScrollToItem(0)
        else if (!last.message.isAuthor && !last.message.isNotice) newBelow += 1
    }
    LaunchedEffect(store.openSeq) {
        if (store.openSeq == 0) return@LaunchedEffect
        val id = store.unreadMarkerId ?: return@LaunchedEffect
        val i = reversed.indexOfFirst { it.message.id == id }
        if (i < 0) return@LaunchedEffect
        val unread = rows.count { it.message.id >= id && !it.message.isAuthor && !it.message.isNotice }
        // Bottom-up list: scrollToItem puts it at the bottom edge; then bring it up to the top.
        listState.scrollToItem(i)
        val info = listState.layoutInfo
        val item = info.visibleItemsInfo.firstOrNull { it.index == i }
        if (item != null) {
            val room = info.viewportEndOffset - info.viewportStartOffset - info.beforeContentPadding - info.afterContentPadding - item.size
            if (room > 0) listState.scrollBy(-room.toFloat())
        }
        newBelow = if (atBottom) 0 else unread
    }
    LaunchedEffect(atBottom) { if (atBottom) newBelow = 0 }
    LaunchedEffect(store.scrollTarget, rows.size) {
        val target = store.scrollTarget ?: return@LaunchedEffect
        val i = reversed.indexOfFirst { it.message.id == target }
        if (i >= 0) {
            listState.animateScrollToItem(i)
            store.scrollTarget = null
        }
    }

    fun submit() {
        val text = d.text
        val id = editingId
        // Editing changes the text only; a new message may be photos alone.
        if (id != null) {
            if (text.isBlank()) return
        } else if (photos.loading > 0 || (text.isBlank() && photos.photos.isEmpty())) return
        d.text = ""
        justSent = text to System.currentTimeMillis()
        if (id != null) {
            editingId = null
            store.edit(id, text)
        } else {
            store.send(text, photos.take()) { body, p ->
                if (d.text.isEmpty()) d.text = body
                photos.restore(p)
            }
        }
        runCatching { focus.requestFocus() }
    }

    fun beginEdit(m: ChatMessage) {
        editingId = m.id
        d.text = m.visibleBody
        runCatching { focus.requestFocus() }
    }

    fun replyTo(name: String) {
        val t = Mention.token(name)
        if (!d.text.startsWith(t)) d.text = t + d.text.trim()
        editingId = null
        runCatching { focus.requestFocus() }
    }

    // 「チャットに引用」 from a post's menu: once the chat is on screen, add the quote after
    // the draft (an edit in progress is dropped) and focus the composer, cursor at the end.
    val canSend = store.capabilities?.canSend == true
    LaunchedEffect(ChatQuote.pending, visible, canSend) {
        val quote = ChatQuote.pending ?: return@LaunchedEffect
        if (!visible || !canSend) return@LaunchedEffect
        ChatQuote.pending = null
        if (editingId != null) { editingId = null; d.text = "" }
        d.text = appendQuote(d.text, quote)
        // After the page switch, which hides the keyboard (MainScreen clears the focus).
        // In `scope`: clearing `pending` restarts (cancels) this effect.
        scope.launch { kotlinx.coroutines.delay(300); runCatching { focus.requestFocus() } }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { if (tabSwitch != null) tabSwitch() else Text("B-guru チャット", maxLines = 1) },
                navigationIcon = { StatusBadge(store) },
                actions = { ChatMenu(onSignOut) },
            )
        },
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0),
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            // The club room, when on for this member: テキスト｜ルーム, and in the text view its
            // banner in place of the voice bar. Otherwise the voice bar exactly as before.
            if (store.room.enabled) {
                RoomModeSwitch(store.room, store.voice)
            } else {
                VoiceBar(store.voice)
            }
            store.update?.let { u ->
                // Downloads need the member's B-guru login, so the browser (where they
                // are signed in) fetches the APK; Android then offers to install it.
                Surface(
                    color = AccentGreen.copy(alpha = 0.12f),
                    modifier = Modifier.fillMaxWidth().clickable {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${Net.BASE}/api/download/android")))
                    },
                ) {
                    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                        Text("新しい版 ${u.version} があります（タップしてダウンロード）", style = MaterialTheme.typography.labelLarge, color = AccentGreen)
                        if (u.notes.isNotBlank()) Text(u.notes, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            // Everything below the bars: the messages and the composer (beside or under the room).
            val chatPane: @Composable (Modifier) -> Unit = { paneModifier ->
                Column(paneModifier) {
                    PullToRefreshBox(
                        isRefreshing = refreshing,
                        onRefresh = { scope.launch { refreshing = true; store.reload(); refreshing = false } },
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                    ) {
                        LazyColumn(
                            state = listState,
                            reverseLayout = true,
                            modifier = Modifier.fillMaxSize(),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.Bottom),
                        ) {
                            if (rows.isEmpty()) {
                                item {
                                    Text(
                                        if (store.hasLoaded) "今日はまだ静かだわん" else "読み込み中…",
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.padding(top = 40.dp),
                                    )
                                }
                            }
                            itemsIndexed(reversed, key = { _, r -> r.key }, contentType = { _, r ->
                                val photo = r.message.images.isNotEmpty() || r.localImages.isNotEmpty()
                                (if (r.message.isAuthor) "mine" else "theirs") + if (photo) "-photo" else ""
                            }) { i, row ->
                                val prev = reversed.getOrNull(i + 1)?.message
                                val caps = store.capabilities
                                val bubble = @Composable {
                                MessageRow(
                                    row = row,
                                    showHeader = prev == null || prev.authorId != row.message.authorId || prev.isAuthor != row.message.isAuthor,
                                    canReact = caps?.canReact ?: false,
                                    canEdit = caps?.canEdit ?: false,
                                    highlighted = store.highlightId == row.message.id,
                                    editing = editingId == row.message.id,
                                    onReact = { store.toggleReaction(row.message.id, it) },
                                    onEdit = { beginEdit(row.message) },
                                    onReply = row.message.authorName?.let { n -> { replyTo(n) } },
                                    onRetry = { store.retry(row) },
                                    onDiscard = { store.discard(row) },
                                    onSelect = { selecting = row.message },
                                    onOpenImage = { urls, at -> viewing = urls to at },
                                    modifier = Modifier.widthIn(max = 760.dp).fillMaxWidth(),
                                )
                                }
                                // One child per item: a reversed list would put a second one below.
                                if (store.unreadMarkerId == row.message.id) {
                                    Column(Modifier.widthIn(max = 760.dp).fillMaxWidth()) { UnreadDivider(); bubble() }
                                } else bubble()
                            }
                        }
                        if (!atBottom) {
                            JumpToLatest(newBelow, Modifier.align(Alignment.BottomEnd).padding(10.dp)) {
                                scope.launch { listState.animateScrollToItem(0) }
                            }
                        }
                    }
                    HorizontalDivider()
                    Composer(
                        store = store,
                        field = d.value,
                        onField = { v ->
                            val s = justSent
                            val t = v.text.trim()
                            val echo = s != null && d.text.isEmpty() && System.currentTimeMillis() - s.second < 2000 &&
                                t.length >= 2 && s.first.contains(t)
                            val limit = store.capabilities?.maxBody ?: 1000
                            when {
                                echo -> d.text = ""
                                v.text.length > limit -> d.text = v.text.take(limit)
                                else -> d.value = v
                            }
                        },
                        editing = editingId != null,
                        photos = photos,
                        focus = focus,
                        onSubmit = ::submit,
                        onCancelEdit = { editingId = null; d.text = "" },
                        onEditLast = {
                            val m = store.lastOwnMessage
                            if (d.text.isEmpty() && editingId == null && m != null && store.capabilities?.canEdit == true) { beginEdit(m); true } else false
                        },
                        onPickMention = { m -> d.text = Mention.complete(d.text, m.name); runCatching { focus.requestFocus() } },
                    )
                }
            }
            val room = store.room
            if (room.enabled && room.roomView) {
                androidx.compose.foundation.layout.BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                    if (maxWidth >= 700.dp && maxWidth > maxHeight) {
                        Row(Modifier.fillMaxSize()) {
                            RoomPanel(room, store.voice, Modifier.weight(1f).fillMaxSize())
                            chatPane(Modifier.width(400.dp).fillMaxSize())
                        }
                    } else {
                        Column(Modifier.fillMaxSize()) {
                            RoomPanel(room, store.voice, Modifier.weight(1f).fillMaxWidth())
                            chatPane(Modifier.weight(1f).fillMaxWidth())
                        }
                    }
                }
            } else {
                chatPane(Modifier.weight(1f).fillMaxWidth())
            }
        }
    }

    selecting?.let { m ->
        AlertDialog(
            onDismissRequest = { selecting = null },
            title = { Text(m.authorName ?: "メッセージ") },
            text = { SelectionContainer { Text(m.visibleBody) } },
            confirmButton = {
                val clipboard = LocalClipboard.current
                TextButton(onClick = {
                    scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("message", m.visibleBody))) }
                    selecting = null
                }) { Text("すべてコピー") }
            },
            dismissButton = { TextButton(onClick = { selecting = null }) { Text("閉じる") } },
        )
    }
    viewing?.let { (urls, at) -> ImageViewer(urls, at) { viewing = null } }
}

@Composable
private fun StatusBadge(store: ChatStore) {
    Box(Modifier.padding(start = 16.dp)) {
        when {
            store.connection == ChatStore.Connection.OFFLINE -> Text("オフライン", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            store.connection == ChatStore.Connection.CONNECTING -> Text("接続中…", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            store.onlineCount > 0 -> Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(6.dp).background(Color(0xFF22C55E), CircleShape))
                Text(" ${store.onlineCount}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun ChatMenu(onSignOut: () -> Unit) {
    val context = LocalContext.current
    var open by remember { mutableStateOf(false) }
    var notifyAll by remember { mutableStateOf(Push.notifyMode(context) == "all") }
    var quiet by remember { mutableStateOf(Push.quietHours(context)) }
    IconButton(onClick = { open = true }) { Icon(Icons.Default.MoreVert, contentDescription = "メニュー") }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        DropdownMenuItem(
            text = { Text("通知: 新着すべて") },
            leadingIcon = { if (notifyAll) Icon(Icons.Default.Check, null) else Spacer(Modifier.size(24.dp)) },
            onClick = { notifyAll = true; Push.setSettings(context, "all", quiet) },
        )
        DropdownMenuItem(
            text = { Text("通知: メンションだけ") },
            leadingIcon = { if (!notifyAll) Icon(Icons.Default.Check, null) else Spacer(Modifier.size(24.dp)) },
            onClick = { notifyAll = false; Push.setSettings(context, "mentions", quiet) },
        )
        DropdownMenuItem(
            text = { Text("静かな時間（0:00〜7:00）") },
            leadingIcon = { if (quiet) Icon(Icons.Default.Check, null) else Spacer(Modifier.size(24.dp)) },
            onClick = { quiet = !quiet; Push.setSettings(context, if (notifyAll) "all" else "mentions", quiet) },
        )
        HorizontalDivider()
        DropdownMenuItem(text = { Text("B-guru をブラウザで開く") }, onClick = {
            open = false
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(Net.BASE)))
        })
        DropdownMenuItem(text = { Text("ログアウト", color = MaterialTheme.colorScheme.error) }, onClick = { open = false; onSignOut() })
    }
}

@Composable
private fun Composer(
    store: ChatStore,
    field: TextFieldValue,
    onField: (TextFieldValue) -> Unit,
    editing: Boolean,
    photos: ChatAttachments,
    focus: FocusRequester,
    onSubmit: () -> Unit,
    onCancelEdit: () -> Unit,
    onEditLast: () -> Boolean,
    onPickMention: (MentionMember) -> Unit,
) {
    val draft = field.text
    val caps = store.capabilities
    val maxPhotos = caps?.maxChatImages ?: 4
    // Photos are hidden while editing: an edit changes the text only.
    val canAttach = !editing && caps?.canSendImages == true
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // The system Photo Picker (no storage permission). Its limit is fixed per launcher,
    // so extra picks beyond the remaining slots are dropped in add().
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(maxPhotos.coerceAtLeast(2))) { uris ->
        if (uris.isNotEmpty()) scope.launch { photos.add(context, uris, maxPhotos, caps?.chatImageMaxSide ?: 1280) }
    }
    val matches = if (editing) emptyList() else Mention.activeQuery(draft)?.let { q ->
        Mention.candidates(store.members, q.second, store.recentAuthors)
    } ?: emptyList()
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 760.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (matches.isNotEmpty()) MentionSuggestions(matches, onPickMention)
                if (editing) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("メッセージを編集中", style = MaterialTheme.typography.labelMedium, color = AccentGreen, modifier = Modifier.weight(1f))
                        TextButton(onClick = onCancelEdit) { Text("キャンセル") }
                    }
                }
                (store.sendError ?: photos.error)?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                if (canAttach) ComposerPhotos(photos)
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (canAttach) {
                        IconButton(
                            onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                            enabled = photos.remaining(maxPhotos) > 0,
                        ) { Text("📷", fontSize = 20.sp, modifier = Modifier.alpha(if (photos.remaining(maxPhotos) > 0) 1f else 0.4f)) }
                    }
                    run {
                        // Setting the value from outside (clear after send) restarts the
                        // IME input, so leftover voice / IME composition does not survive.
                        TextField(
                            value = field,
                            onValueChange = onField,
                            placeholder = { Text(composerPlaceholder(if (editing) "編集内容" else "メッセージ")) },
                            maxLines = 6,
                            keyboardOptions = ComposerKeyboardOptions,
                            shape = RoundedCornerShape(20.dp),
                            colors = TextFieldDefaults.colors(
                                focusedIndicatorColor = Color.Transparent,
                                unfocusedIndicatorColor = Color.Transparent,
                            ),
                            modifier = Modifier
                                .weight(1f)
                                .focusRequester(focus)
                                // docs/composer-keys.md: hardware Enter sends (saves while editing),
                                // ⇧Enter newline, ↑ edits the last message; on-screen return is a newline.
                                .composerKeys(
                                    value = field,
                                    onValueChange = onField,
                                    onSend = onSubmit,
                                    mentionOpen = matches.isNotEmpty(),
                                    onPickMention = { matches.firstOrNull()?.let(onPickMention) },
                                    editing = editing,
                                    onCancel = onCancelEdit,
                                    onUp = onEditLast,
                                ),
                        )
                    }
                    val hasContent = draft.isNotBlank() || (canAttach && photos.photos.isNotEmpty())
                    val canSend = hasContent && (editing || photos.loading == 0) && (caps?.canSend ?: true)
                    IconButton(onClick = onSubmit, enabled = canSend) {
                        Icon(
                            if (editing) Icons.Default.Check else Icons.AutoMirrored.Filled.Send,
                            contentDescription = if (editing) "保存" else "送信",
                            tint = if (canSend) AccentGreen else MaterialTheme.colorScheme.outline,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MentionSuggestions(members: List<MentionMember>, onPick: (MentionMember) -> Unit) {
    Surface(shape = RoundedCornerShape(10.dp), tonalElevation = 3.dp, shadowElevation = 2.dp) {
        Column {
            members.forEachIndexed { i, m ->
                Row(
                    Modifier.fillMaxWidth().clickable { onPick(m) }.padding(horizontal = 10.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Avatar(m.avatar, m.name, 24.dp)
                    Text(m.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (i < members.size - 1) HorizontalDivider()
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun MessageRow(
    row: ChatRow,
    showHeader: Boolean,
    canReact: Boolean,
    canEdit: Boolean,
    highlighted: Boolean,
    editing: Boolean,
    onReact: (String) -> Unit,
    onEdit: () -> Unit,
    onReply: (() -> Unit)?,
    onRetry: () -> Unit,
    onDiscard: () -> Unit,
    onSelect: () -> Unit,
    onOpenImage: (List<String>, Int) -> Unit,
    modifier: Modifier,
) {
    val m = row.message
    if (m.isNotice) {
        // A quiet note from B-guru: one small grey line.
        Text(
            m.body,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            modifier = modifier.padding(vertical = 1.dp),
        )
        return
    }
    val mine = m.isAuthor
    val stored = m.id > 0 && row.state == SendState.SENT
    var menu by remember { mutableStateOf(false) }
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val bg by animateColorAsState(if (highlighted) AccentGreen.copy(alpha = 0.16f) else Color.Transparent, label = "highlight")

    Row(
        modifier.background(bg, RoundedCornerShape(10.dp)).padding(vertical = if (highlighted) 2.dp else 0.dp),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
        verticalAlignment = Alignment.Top,
    ) {
        if (!mine) {
            Box(Modifier.size(28.dp)) { if (showHeader) Avatar(m.avatar, m.authorName ?: "") }
            Spacer(Modifier.size(6.dp))
        }
        Column(
            Modifier.weight(1f, fill = false).padding(start = if (mine) 40.dp else 0.dp, end = if (mine) 0.dp else 40.dp),
            horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
        ) {
            if (showHeader || row.state == SendState.FAILED) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (!mine) Text(m.authorName ?: "", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (row.state == SendState.FAILED) {
                        Text("送信できませんでした", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
                        Text("再送", style = MaterialTheme.typography.labelMedium, color = AccentGreen, modifier = Modifier.clickable(onClick = onRetry))
                        Text("取り消す", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.clickable(onClick = onDiscard))
                    }
                    if (m.edited) Text("編集済み", style = MaterialTheme.typography.labelSmall, color = AccentGreen)
                    Text(remember(m.createdAt) { time(m.createdAt) }, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                }
            }
            Box {
                val body = m.visibleBody
                Column(horizontalAlignment = if (mine) Alignment.End else Alignment.Start, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (m.images.isNotEmpty() || row.localImages.isNotEmpty()) {
                        ChatImages(
                            urls = m.images,
                            local = row.localImages,
                            // Previews of a message still sending have no URL to open yet.
                            onOpen = if (m.images.isEmpty()) null else { i -> onOpenImage(m.images, i) },
                            onLongPress = { menu = true },
                        )
                    }
                    // A photo-only message has no text bubble.
                    if (body.isNotEmpty()) {
                        // Parsed once per message, not on every frame of a scroll.
                        val emojiOnly = remember(body) { isEmojiOnly(body) }
                        val text = remember(body) { linkified(body) }
                        val bubble = when {
                            emojiOnly -> Color.Transparent
                            mine -> AccentGreen.copy(alpha = 0.14f)
                            m.mentionsMe -> Color(0xFFFACC15).copy(alpha = 0.22f)
                            else -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f)
                        }
                        Text(
                            text,
                            fontSize = if (emojiOnly) 34.sp else 16.sp,
                            modifier = Modifier
                                .background(bubble, RoundedCornerShape(12.dp))
                                .then(if (editing) Modifier.border(1.5.dp, AccentGreen, RoundedCornerShape(12.dp)) else Modifier)
                                .combinedClickable(
                                    onClick = {},
                                    onDoubleClick = { if (canReact && stored) onReact("❤️") },
                                    onLongClick = { menu = true },
                                )
                                .padding(horizontal = if (emojiOnly) 4.dp else 10.dp, vertical = if (emojiOnly) 0.dp else 6.dp),
                        )
                    }
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    if (canReact && stored) {
                        Row(Modifier.padding(horizontal = 8.dp)) {
                            (QUICK + MORE).take(6).forEach { e ->
                                Text(e, fontSize = 22.sp, modifier = Modifier.clickable { menu = false; onReact(e) }.padding(6.dp))
                            }
                        }
                        Row(Modifier.padding(horizontal = 8.dp)) {
                            MORE.forEach { e ->
                                Text(e, fontSize = 22.sp, modifier = Modifier.clickable { menu = false; onReact(e) }.padding(6.dp))
                            }
                        }
                        HorizontalDivider()
                    }
                    if (onReply != null && !mine && stored) {
                        DropdownMenuItem(text = { Text("返信（@メンション）") }, onClick = { menu = false; onReply() })
                    }
                    if (mine && canEdit && stored) {
                        DropdownMenuItem(text = { Text("編集") }, onClick = { menu = false; onEdit() })
                    }
                    if (body.isNotEmpty()) {
                        DropdownMenuItem(text = { Text("テキストをコピー") }, onClick = {
                            menu = false
                            scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("message", body))) }
                        })
                        DropdownMenuItem(text = { Text("テキストを選択") }, onClick = { menu = false; onSelect() })
                    }
                }
            }
            val rs = m.reactions.orEmpty()
            if (rs.isNotEmpty()) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 2.dp)) {
                    rs.forEach { r -> ReactionChip(r, enabled = canReact && stored) { onReact(r.emoji) } }
                }
            }
        }
    }
    if (row.state == SendState.PENDING) Unit
}

/** Photos in a bubble: one at up to 220 dp wide, 2–4 as small squares in two columns.
 *  `local` (this device's previews) wins over `urls` so a just-sent message never flashes. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChatImages(urls: List<String>, local: List<ImageBitmap>, onOpen: ((Int) -> Unit)?, onLongPress: () -> Unit) {
    val count = if (local.isNotEmpty()) local.size else urls.size
    if (count == 1) {
        // Remote sizes are unknown until loaded, so those use a 4:3 crop; previews keep their shape.
        val aspect = local.firstOrNull()?.let { (it.width.toFloat() / it.height).coerceIn(0.75f, 1.8f) } ?: (4f / 3f)
        ChatImageCell(urls.firstOrNull(), local.firstOrNull(), Modifier.width(220.dp).aspectRatio(aspect), 720, onOpen?.let { { it(0) } }, onLongPress)
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        (0 until count).chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                pair.forEach { i ->
                    ChatImageCell(urls.getOrNull(i), local.getOrNull(i), Modifier.size(108.dp), 400, onOpen?.let { { it(i) } }, onLongPress)
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChatImageCell(url: String?, local: ImageBitmap?, size: Modifier, maxPx: Int, onTap: (() -> Unit)?, onLongPress: () -> Unit) {
    val m = size.clip(RoundedCornerShape(10.dp)).combinedClickable(onClick = { onTap?.invoke() }, onLongClick = onLongPress)
    if (local != null) Image(local, contentDescription = "写真", modifier = m, contentScale = ContentScale.Crop)
    else RemoteImage(url, m, maxPx = maxPx) { Box(m.background(MaterialTheme.colorScheme.surfaceVariant)) }
}

/** Attached photos above the text field, each with ✕, and a spinner while decoding. */
@Composable
private fun ComposerPhotos(photos: ChatAttachments) {
    if (photos.photos.isEmpty() && photos.loading == 0) return
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        photos.photos.forEachIndexed { i, p ->
            Box {
                Image(p.preview, null, Modifier.size(56.dp).clip(RoundedCornerShape(8.dp)), contentScale = ContentScale.Crop)
                Box(
                    Modifier.align(Alignment.TopEnd).size(22.dp).background(Color.Black.copy(alpha = 0.55f), CircleShape).clickable { photos.remove(i) },
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Default.Close, "画像 ${i + 1} を外す", tint = Color.White, modifier = Modifier.size(14.dp)) }
            }
        }
        repeat(photos.loading) {
            Box(Modifier.size(56.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            }
        }
    }
}

@Composable
internal fun ReactionChip(r: Reaction, enabled: Boolean, onTap: () -> Unit) {
    val border = if (r.mine) AccentGreen else MaterialTheme.colorScheme.outlineVariant
    Row(
        Modifier
            .border(1.dp, border, RoundedCornerShape(12.dp))
            .background(if (r.mine) AccentGreen.copy(alpha = 0.10f) else Color.Transparent, RoundedCornerShape(12.dp))
            .clickable(enabled = enabled, onClick = onTap)
            .padding(horizontal = 8.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        val custom = CUSTOM_EMOJI_RE.find(r.emoji)?.groupValues?.get(1)?.let { EmojiCatalog.urls[it] }
        if (custom != null) RemoteImage(custom, Modifier.size(16.dp), androidx.compose.ui.layout.ContentScale.Fit, maxPx = 64) { Text(r.emoji, fontSize = 12.sp) }
        else Text(r.emoji, fontSize = 14.sp)
        Text("${r.count}", style = MaterialTheme.typography.labelSmall)
    }
}

private val HM = DateTimeFormatter.ofPattern("H:mm").withZone(ZoneId.systemDefault())

private fun time(iso: String): String = runCatching { HM.format(Instant.parse(iso)) }.getOrDefault("")

private fun isEmojiOnly(s: String): Boolean {
    val t = s.trim()
    if (t.isEmpty() || t.codePointCount(0, t.length) > 6) return false
    return t.codePoints().allMatch { cp ->
        Character.getType(cp) == Character.OTHER_SYMBOL.toInt() || cp == 0x200D || cp == 0xFE0F || cp in 0x1F3FB..0x1F3FF
    }
}

private val CUSTOM_EMOJI_RE = Regex("^:([\\w+-]+):$")
private val URL_RE = Regex("""https?://[^\s<>"]+""")
private val MENTION_RE = Regex("""@\[[^\]]+]|@[^\s@\[\]]+""")

/** Links are tappable; @mentions are green (same as the web). */
internal fun linkified(s: String): AnnotatedString = buildAnnotatedString {
    append(s)
    MENTION_RE.findAll(s).forEach { addStyle(SpanStyle(color = AccentGreen), it.range.first, it.range.last + 1) }
    URL_RE.findAll(s).forEach {
        val url = it.value.trimEnd('.', ',', ')', '」', '。')
        addLink(
            LinkAnnotation.Url(url, TextLinkStyles(SpanStyle(color = AccentGreen, textDecoration = TextDecoration.Underline))),
            it.range.first, it.range.first + url.length,
        )
    }
}

/** The composer text. Setting `text` from code (clear, reply, mention, edit)
 *  puts the cursor at the end, so what you type next lands after it. */
private class Draft {
    var value by mutableStateOf(TextFieldValue(""))
    var text: String
        get() = value.text
        set(v) { value = TextFieldValue(v, TextRange(v.length)) }
}

private fun lifecycleIsResumed(context: android.content.Context): Boolean =
    (context as? androidx.lifecycle.LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) ?: true

/** "ここから未読" — drawn above the first message that was unread on opening. */
@Composable
private fun UnreadDivider() {
    val green = Color(0xFF16A34A)
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = green.copy(alpha = 0.5f))
        Text("ここから未読", style = MaterialTheme.typography.labelSmall, color = green, modifier = Modifier.padding(horizontal = 8.dp))
        HorizontalDivider(Modifier.weight(1f), color = green.copy(alpha = 0.5f))
    }
}

/** Back to the newest: "↓ 最新へ" / "↓ 新着 N" in the chat, "↑ …" in the timeline. */
@Composable
internal fun JumpToLatest(count: Int, modifier: Modifier, arrow: String = "↓", onClick: () -> Unit) {
    val fresh = count > 0
    androidx.compose.material3.Surface(
        onClick = onClick,
        shape = androidx.compose.foundation.shape.CircleShape,
        color = if (fresh) Color(0xFF16A34A) else MaterialTheme.colorScheme.surfaceContainerHigh,
        contentColor = if (fresh) Color.White else MaterialTheme.colorScheme.onSurface,
        shadowElevation = 3.dp,
        modifier = modifier,
    ) {
        Text(
            if (fresh) "$arrow 新着 $count" else "$arrow 最新へ",
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }
}
