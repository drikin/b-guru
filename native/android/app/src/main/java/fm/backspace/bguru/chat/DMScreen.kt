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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.focus.focusRequester
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Email
import androidx.compose.material3.Badge
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
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

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

/** The ✉️ page (after 💬; the right pane on a wide screen): the list (1 対 1 and 👥 groups), and a conversation /
 *  group opened from it in place (back and ← return to the list). [visible] = this page is the one on screen
 *  (only then is a conversation read, and back belongs to it). [tabSwitch] = the tab switch, in the list's bar.
 *  [members] = the chat's members (the people a group can be made with). */
@Composable
fun DMPage(dm: DMStore, members: List<MentionMember>, visible: Boolean, tabSwitch: (@Composable () -> Unit)?) {
    val route = dm.route ?: DMStore.Route.Inbox
    BackHandler(enabled = visible && dm.stack.any { it != DMStore.Route.Inbox }) { dm.back() }
    // Shown again: the list is fresh (the stream keeps it so while the app is open; this catches up after errors).
    LaunchedEffect(visible) { if (visible && route == DMStore.Route.Inbox) { dm.refreshList(); dm.groups.refreshList() } }
    // Hide what passes the ttl while it stays open (and on screen: back from the
    // background it prunes at once).
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(dm) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { while (true) { dm.prune(); delay(60_000) } }
    }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        when (route) {
            DMStore.Route.Inbox -> DMInbox(dm, tabSwitch, members)
            is DMStore.Route.Conversation -> androidx.compose.runtime.key(route.peer.userId) { DMConversationScreen(dm, route.peer, visible) }
            DMStore.Route.NewGroup -> GDMPickerScreen(dm, members, groupId = null)
            is DMStore.Route.Group -> androidx.compose.runtime.key(route.id) { GDMGroupScreen(dm, route.id, visible) }
            is DMStore.Route.GroupMembers -> androidx.compose.runtime.key(route.id) { GDMMembersScreen(dm, route.id) }
            is DMStore.Route.AddMembers -> androidx.compose.runtime.key(route.id) { GDMPickerScreen(dm, members, groupId = route.id) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DMInbox(dm: DMStore, tabSwitch: (@Composable () -> Unit)?, members: List<MentionMember>) {
    var newDM by rememberSaveable { mutableStateOf(false) }
    if (newDM) NewDMDialog(dm, members, onDismiss = { newDM = false })
    Scaffold(
        topBar = {
            TopAppBar(
                // On its page the bar carries the tab switch (no ←: it is a tab, not a screen over the app).
                title = { if (tabSwitch != null) tabSwitch() else Text("DM", maxLines = 1) },
                navigationIcon = { if (tabSwitch == null) IconButton(onClick = { dm.back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "戻る") } },
                actions = {
                    // ＋ 新規 DM: pick a person by name, then their conversation opens here.
                    if (dm.canSendCap) TextButton(onClick = { newDM = true }, contentPadding = PaddingValues(horizontal = 6.dp)) { Text("＋ 新規 DM", maxLines = 1, softWrap = false) }
                    // 👥 グループ DM (capabilities.gdm): make one.
                    if (dm.groups.enabled && dm.groups.canSendCap) TextButton(onClick = { dm.openNewGroup() }, contentPadding = PaddingValues(horizontal = 6.dp)) { Text("＋ グループ", maxLines = 1, softWrap = false) }
                },
            )
        },
    ) { padding ->
        val items = remember(dm.conversations, dm.groups.groups, dm.groups.enabled) {
            GDMLogic.mergeInbox(dm.conversations, if (dm.groups.enabled) dm.groups.groups else emptyList())
        }
        Column(Modifier.fillMaxSize().padding(padding)) {
            Text(
                "DM は 30 日で消えます。チャットで相手の名前やアイコンをタップすると送れます。",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
            )
            HorizontalDivider()
            if (items.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                    Text(if (dm.listLoaded) "まだ DM はありません" else "読み込み中…",
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 40.dp))
                }
            } else {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                    items(items, key = { it.key }, contentType = { if (it is DMInboxItem.Group) "group" else "one" }) { item ->
                        when (item) {
                            is DMInboxItem.One -> DMConversationRow(item.c) { dm.openConversation(item.c.peer) }
                            is DMInboxItem.Group -> GDMInboxRow(item.s) { dm.openGroup(item.s.group.id) }
                        }
                        HorizontalDivider(Modifier.padding(start = 68.dp))
                    }
                }
            }
        }
    }
}

/** ＋ 新規 DM: one name field. Nothing typed shows my DM partners only; typing finds members (never the whole
 *  list up front). A tap opens that person's conversation on the ✉️ page. */
@Composable
private fun NewDMDialog(dm: DMStore, members: List<MentionMember>, onDismiss: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val peers = remember(dm.conversations) { dm.conversations.map { it.peer } }
    val shown = remember(members, peers, query, dm.groups.myUserId) { DMLogic.newDMCandidates(members, peers, dm.groups.myUserId, query) }
    val focus = remember { androidx.compose.ui.focus.FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("新規 DM") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                androidx.compose.material3.OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text("名前を入れて探す") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().focusRequester(focus),
                )
                LazyColumn(Modifier.fillMaxWidth().heightIn(max = 320.dp)) {
                    if (shown.isEmpty()) {
                        item {
                            Text(
                                when {
                                    query.isBlank() -> "名前を入れて探してください"
                                    members.isEmpty() -> "読み込み中…"
                                    else -> "見つかりません"
                                },
                                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp),
                            )
                        }
                    }
                    items(shown, key = { it.userId }) { m ->
                        Row(
                            Modifier.fillMaxWidth().clickable {
                                onDismiss()
                                dm.openConversation(DMPeer(m.userId, m.name, m.avatar))
                            }.padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Avatar(ApiClient.absolute(m.avatar) ?: m.avatar, m.name, 36.dp)
                            Text(m.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
    )
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
private fun DMConversationScreen(dm: DMStore, peer: DMPeer, visible: Boolean) {
    val context = LocalContext.current
    val listState = rememberLazyListState()
    var draft by rememberSaveable(peer.userId, stateSaver = TextFieldValue.Saver) { mutableStateOf(TextFieldValue("")) }
    // 📷 Photos for the next DM, and the photo open full screen.
    val photos = remember(peer.userId) { ChatAttachments() }
    var viewing by remember { mutableStateOf<Pair<List<String>, Int>?>(null) }
    // ✏️ The message being edited (the chat's editingId), and 「テキストを選択」.
    var editingId by remember(peer.userId) { mutableStateOf<Long?>(null) }
    var selecting by remember { mutableStateOf<DMMessage?>(null) }
    val focus = remember { androidx.compose.ui.focus.FocusRequester() }

    // On screen (resumed, and its page is the one shown) = read: tells the store, and clears this person's notification.
    val onScreen = rememberShown(visible)
    DisposableEffect(onScreen, peer.userId) {
        if (onScreen) { dm.setScreenVisible(peer.userId, true); Push.clearDMNotification(context, peer.userId) }
        onDispose { if (onScreen) dm.setScreenVisible(peer.userId, false) }
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
                    DMBubble(row, canReact = dm.canReact, canEdit = dm.canEdit, editing = editingId == row.message.id,
                        onReact = { dm.toggleReaction(row.message.id, it) },
                        onEdit = {
                            editingId = row.message.id
                            draft = TextFieldValue(row.message.body, TextRange(row.message.body.length))
                            runCatching { focus.requestFocus() }
                        },
                        onSelect = { selecting = row.message },
                        onRetry = { dm.retry(row) }, onDiscard = { dm.discard(row) },
                        onOpenImage = { urls, i -> viewing = urls to i },
                        modifier = Modifier.widthIn(max = 760.dp).fillMaxWidth())
                }
            }
            HorizontalDivider()
            val editingRow = editingId?.let { id -> dm.rows.firstOrNull { it.message.id == id } }
            DMComposer(
                dm = dm,
                draft = draft,
                photos = photos,
                editing = editingRow?.let { it.message.images.isNotEmpty() },
                focus = focus,
                onCancelEdit = { editingId = null; draft = TextFieldValue("") },
                onDraft = { draft = it.limitTo(dm.maxBody) },
                onSend = {
                    val text = draft.text
                    val id = editingId
                    draft = TextFieldValue("")
                    if (id != null) {
                        editingId = null
                        dm.edit(id, text)
                    } else dm.send(text, photos.take()) { body, back ->
                        if (draft.text.isEmpty()) draft = TextFieldValue(body, TextRange(body.length))
                        photos.restore(back)
                    }
                },
            )
        }
    }
    viewing?.let { (urls, at) -> ImageViewer(urls, at) { viewing = null } }
    selecting?.let { m -> SelectTextDialog(if (m.isAuthor) "自分" else shown.displayName, m.body) { selecting = null } }
}

/** The activity is resumed and [visible] (its page is the one on screen). */
@Composable
internal fun rememberShown(visible: Boolean): Boolean {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var resumed by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    DisposableEffect(lifecycle) {
        val obs = LifecycleEventObserver { _, e ->
            when (e) {
                Lifecycle.Event.ON_RESUME -> resumed = true
                Lifecycle.Event.ON_PAUSE -> resumed = false
                else -> Unit
            }
        }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs) }
    }
    return resumed && visible
}

/** At most [max] characters (the cursor stays inside). */
internal fun TextFieldValue.limitTo(max: Int): TextFieldValue = if (text.length <= max) this else TextFieldValue(text.take(max), selection)

/** 📷 A DM's photos (1 対 1 and groups), like the chat's: this device's previews while sending, then the server's. */
@Composable
internal fun DMImages(images: List<String>, local: List<androidx.compose.ui.graphics.ImageBitmap>, onOpen: (List<String>, Int) -> Unit) {
    if (images.isEmpty() && local.isEmpty()) return
    ChatImages(urls = images, local = local, onOpen = if (images.isEmpty()) null else { i -> onOpen(images, i) }, onLongPress = {})
}

@Composable
private fun DMBubble(
    row: DMRow,
    canReact: Boolean,
    canEdit: Boolean,
    editing: Boolean,
    onReact: (String) -> Unit,
    onEdit: () -> Unit,
    onSelect: () -> Unit,
    onRetry: () -> Unit,
    onDiscard: () -> Unit,
    onOpenImage: (List<String>, Int) -> Unit,
    modifier: Modifier,
) {
    val m = row.message
    val mine = m.isAuthor
    val stored = m.id > 0 && row.state == SendState.SENT
    Column(modifier, horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
        Column(
            Modifier.padding(start = if (mine) 48.dp else 0.dp, end = if (mine) 0.dp else 48.dp),
            horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
        ) {
            // The chat's bubble, menu and chips (1 対 1: no 返信 — the other person is already set).
            DMMessageBody(
                body = m.body, images = m.images, localImages = row.localImages, mine = mine, mentionsMe = false, editing = editing,
                reactions = m.reactions, canReact = canReact && stored, canEdit = canEdit && DMLogic.canEdit(row),
                onReact = onReact, onEdit = onEdit, onReply = null, onSelect = onSelect, onOpenImage = onOpenImage,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
                when (row.state) {
                    SendState.FAILED -> {
                        Text("送信できませんでした", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                        Text("再送", style = MaterialTheme.typography.labelMedium, color = AccentGreen, modifier = Modifier.clickable(onClick = onRetry))
                        Text("取り消す", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.clickable(onClick = onDiscard))
                    }
                    SendState.PENDING -> Text("送信中…", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                    SendState.SENT -> {
                        EditedMark(m.edited)
                        Text(remember(m.createdAt) { dmTime(m.createdAt, withDay = true) }, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                    }
                }
            }
        }
    }
}

@Composable
private fun DMComposer(
    dm: DMStore,
    draft: TextFieldValue,
    photos: ChatAttachments,
    /** ✏️ Editing: null = not; else whether the message has photos (then the text may be emptied). */
    editing: Boolean?,
    focus: androidx.compose.ui.focus.FocusRequester,
    onCancelEdit: () -> Unit,
    onDraft: (TextFieldValue) -> Unit,
    onSend: () -> Unit,
) {
    val allowed = dm.canSendCap && dm.canSendHere
    // Photos are hidden while editing: an edit changes the text only (the chat's rule).
    val canAttach = allowed && dm.canSendImages && editing == null
    val paste = rememberPasteImages(photos, dm.maxImages, dm.imageMaxSide, enabled = canAttach)
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 760.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                (dm.error ?: photos.error)?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                if (!allowed) {
                    Text(
                        if (!dm.canSendCap) "このアプリからは DM を送れません（読むだけ）" else "この人にはまだ DM を送れません",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (editing != null) EditingBanner(onCancelEdit)
                if (canAttach) ComposerPhotos(photos)
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (canAttach) PhotoAttachButtons(photos, dm.maxImages, dm.imageMaxSide)
                    PhotoTextField(
                        value = draft,
                        onValueChange = onDraft,
                        onImages = paste,
                        enabled = allowed,
                        placeholder = { Text(if (editing != null) "編集内容" else "DM（30 日で消えます）") },
                        maxLines = 6,
                        modifier = Modifier.weight(1f).focusRequester(focus),
                    )
                    val canSend = allowed && if (editing != null) DMLogic.canSaveEdit(draft.text, editing)
                        else photos.loading == 0 && DMLogic.canSend(draft.text, if (canAttach) photos.photos.size else 0)
                    IconButton(onClick = onSend, enabled = canSend) {
                        Icon(if (editing != null) Icons.Default.Check else Icons.AutoMirrored.Filled.Send, contentDescription = if (editing != null) "保存" else "送信",
                            tint = if (canSend) AccentGreen else MaterialTheme.colorScheme.outline)
                    }
                }
                Row {
                    Text("DM は 30 日で消えます", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline, modifier = Modifier.weight(1f))
                    if (draft.text.length > dm.maxBody * 0.8) Text("${draft.text.length} / ${dm.maxBody}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                }
            }
        }
    }
}

private val DM_HM = DateTimeFormatter.ofPattern("H:mm").withZone(ZoneId.systemDefault())
private val DM_MDHM = DateTimeFormatter.ofPattern("M/d H:mm").withZone(ZoneId.systemDefault())

/** "H:mm" today; "M/d H:mm" for yesterday's (the list), for older ones (DMs last 30 days). */
internal fun dmTime(iso: String, withDay: Boolean): String = runCatching {
    val t = Instant.parse(iso)
    val zone = ZoneId.systemDefault()
    if (!withDay || t.atZone(zone).toLocalDate() == LocalDate.now(zone)) DM_HM.format(t) else DM_MDHM.format(t)
}.getOrDefault("")
