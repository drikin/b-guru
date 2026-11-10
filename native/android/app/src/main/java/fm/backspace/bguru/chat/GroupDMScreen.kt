package fm.backspace.bguru.chat

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Check
import androidx.compose.ui.focus.focusRequester
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/* 👥 グループ DM の画面（docs/group-dm-spec.md）: 一覧の 1 行・グループ・メンバー・人を選ぶ（作る／追加）。
 * 見た目と言い回しは 1 対 1 の DMScreen に合わせる。 */

/** The group's round photo, or 👥 when it has none or it cannot be read (members only: ImageCache adds the token). */
@Composable
private fun GroupIcon(size: androidx.compose.ui.unit.Dp, group: GDMGroup?) {
    val m = Modifier.size(size).clip(CircleShape)
    val px = with(androidx.compose.ui.platform.LocalDensity.current) { size.roundToPx() }
    RemoteImage(GDMLogic.photoUrl(group), m, maxPx = px) {
        Box(m.background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
            Text("👥", fontSize = (size.value * 0.5).sp)
        }
    }
}

/** A group in the DM list: 👥, the title, the last line and the unread count. */
@Composable
internal fun GDMInboxRow(s: GroupSummary, onClick: () -> Unit) {
    val unread = s.unreadCount > 0
    val time = s.lastMessage?.createdAt ?: s.group.createdAt
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        GroupIcon(40.dp, s.group)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("${GDMLogic.mark(s.group)} ${s.group.displayTitle}", style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Text(" ${s.group.count}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                if (s.group.muted) Text(" 🔕", style = MaterialTheme.typography.labelSmall)
                // 🌐 made in the last 72 hours (public DMs I am not in).
                if (s.isNew) {
                    Spacer(Modifier.size(6.dp))
                    Badge(containerColor = AccentGreen, contentColor = Color.White) { Text("新しい") }
                }
                Spacer(Modifier.weight(1f).size(0.dp))
                Text(remember(time) { dmTime(time, withDay = true) }, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    GDMLogic.preview(s.lastMessage),
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (unread) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                )
                if (unread) {
                    Spacer(Modifier.size(8.dp))
                    Badge(containerColor = AccentGreen, contentColor = Color.White) { Text(if (s.unreadCount > 99) "99+" else "${s.unreadCount}") }
                }
            }
        }
    }
}

/** 「🌐 パブリック DM」「🗄 アーカイブ」 in the DM list ([onClick] = folds / unfolds). */
@Composable
internal fun GDMSectionHeader(text: String, onClick: (() -> Unit)? = null) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

// MARK: the group

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun GDMGroupScreen(dm: DMStore, id: Long, visible: Boolean) {
    val g = dm.groups
    val context = LocalContext.current
    val listState = rememberLazyListState()
    var draft by rememberSaveable(id, stateSaver = TextFieldValue.Saver) { mutableStateOf(TextFieldValue("")) }
    // 📷 Photos for the next message, and the photo open full screen.
    val photos = remember(id) { ChatAttachments() }
    var viewing by remember { mutableStateOf<Pair<List<String>, Int>?>(null) }
    // ✏️ The message being edited (the chat's editingId), and 「テキストを選択」.
    var editingId by remember(id) { mutableStateOf<Long?>(null) }
    var selecting by remember { mutableStateOf<GMessage?>(null) }
    val focus = remember { androidx.compose.ui.focus.FocusRequester() }
    fun setDraft(text: String) { draft = TextFieldValue(text, TextRange(text.length)) }

    // On screen (resumed, and its page is the one shown) = read: tells the store, and clears this group's notification.
    val shown = rememberShown(visible)
    DisposableEffect(shown, id) {
        if (shown) {
            g.setScreenVisible(id, true); Push.clearGDMNotification(context, id)
            // 🌐 Not joined: no stream events come, so coming back reads it again.
            if (g.threadLoaded && g.group(id)?.isMember == false) g.refreshThread()
        }
        onDispose { if (shown) g.setScreenVisible(id, false) }
    }

    LaunchedEffect(g) {
        snapshotFlow { g.rows.lastOrNull()?.key }.distinctUntilChanged().collect {
            val last = g.rows.lastOrNull() ?: return@collect
            if (listState.firstVisibleItemIndex <= 1 || last.message.isAuthor) listState.animateScrollToItem(0)
        }
    }

    val group = g.group(id)
    val myName = GDMLogic.me(group)?.name
    val mode = GDMLogic.composerMode(group)
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                        modifier = Modifier.clickable { dm.openGroupMembers(id) }) {
                        GroupIcon(34.dp, group)
                        Column {
                            Text(group?.displayTitle ?: "グループ", maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (group != null) {
                                Text("${if (group.isPublic) "🌐 " else ""}${group.count} 人${if (group.archived) "・🗄 アーカイブ" else ""}${if (group.muted) "・🔕 通知オフ" else ""}", style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                },
                navigationIcon = { IconButton(onClick = { dm.back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "戻る") } },
                actions = { TextButton(onClick = { dm.openGroupMembers(id) }) { Text("メンバー") } },
            )
        },
        contentWindowInsets = WindowInsets(0),
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
          // Pull to read it again (a 🌐 public DM I am not in gets no stream events).
          PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refreshing = true; g.refreshThread()?.join(); refreshing = false } },
            modifier = Modifier.weight(1f).fillMaxWidth(),
          ) {
            LazyColumn(
                state = listState,
                reverseLayout = true,
                modifier = Modifier.fillMaxSize(),
                horizontalAlignment = Alignment.CenterHorizontally,
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.Bottom),
            ) {
                val rows = g.rows
                val reversed = rows.asReversed()
                if (reversed.isEmpty()) {
                    item {
                        Text(if (g.threadLoaded) "このグループの DM はまだありません" else "読み込み中…",
                            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 40.dp))
                    }
                }
                items(reversed.size, key = { reversed[it].key }, contentType = { i ->
                    val m = reversed[i].message
                    if (m.isSystem) "system" else if (m.isAuthor) "mine" else "theirs"
                }) { i ->
                    val row = reversed[i]
                    // The name / avatar only on the first of a run from the same person.
                    val prev = reversed.getOrNull(i + 1)?.message
                    val showHeader = prev == null || prev.isSystem || prev.fromId != row.message.fromId
                    if (row.message.isSystem) GDMSystemLine(row.message, Modifier.widthIn(max = 760.dp).fillMaxWidth())
                    else GDMBubble(row, showHeader, myName = myName, canReact = g.canReact, canEdit = g.canEdit,
                        editing = editingId == row.message.id,
                        onReact = { g.toggleReaction(row.message.id, it) },
                        onEdit = { editingId = row.message.id; setDraft(row.message.body); runCatching { focus.requestFocus() } },
                        // ↩️ the chat's 返信: 「@名前 」 at the start of the draft (an edit in progress is dropped).
                        onReply = {
                            val t = Mention.token(row.message.senderName)
                            val current = if (editingId != null) "" else draft.text
                            editingId = null
                            if (!current.startsWith(t)) setDraft(t + current.trim()) else setDraft(current)
                            runCatching { focus.requestFocus() }
                        },
                        onSelect = { selecting = row.message },
                        onRetry = { g.retry(row) }, onDiscard = { g.discard(row) },
                        onOpenImage = { urls, i -> viewing = urls to i },
                        modifier = Modifier.widthIn(max = 760.dp).fillMaxWidth())
                }
            }
          }
            HorizontalDivider()
            if (mode != GDMComposerMode.NORMAL) {
                GDMReadOnlyBar(g, id, mode)
                return@Column
            }
            val editingRow = editingId?.let { eid -> g.rows.firstOrNull { it.message.id == eid } }
            GDMComposer(
                g = g,
                draft = draft,
                photos = photos,
                editing = editingRow?.let { it.message.images.isNotEmpty() },
                focus = focus,
                onCancelEdit = { editingId = null; draft = TextFieldValue("") },
                onDraft = { draft = it.limitTo(g.maxBody) },
                onSend = {
                    val text = draft.text
                    val eid = editingId
                    draft = TextFieldValue("")
                    if (eid != null) {
                        editingId = null
                        g.edit(eid, text)
                    } else g.send(text, photos.take()) { body, back ->
                        if (draft.text.isEmpty()) draft = TextFieldValue(body, TextRange(body.length))
                        photos.restore(back)
                    }
                },
            )
        }
    }
    viewing?.let { (urls, at) -> ImageViewer(urls, at) { viewing = null } }
    selecting?.let { m -> SelectTextDialog(if (m.isAuthor) "自分" else m.senderName, m.body) { selecting = null } }
}

/** In place of the composer: 「参加する」 (🌐 not joined) or 「アーカイブされています（読むだけ）」. */
@Composable
private fun GDMReadOnlyBar(g: GDMStore, id: Long, mode: GDMComposerMode) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 10.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            (g.actionError ?: g.error)?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            when (mode) {
                GDMComposerMode.ARCHIVED -> Text("🗄 アーカイブされています（読むだけ）", style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                GDMComposerMode.JOIN -> if (g.canSendCap && g.publicEnabled) {
                    Button(onClick = { g.join(id) }, enabled = !g.busy) { Text(if (g.busy) "…" else "参加する") }
                    Text("🌐 パブリック DM です。参加すると書き込めて、通知も届きます", style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                } else {
                    Text("このアプリからは参加できません（読むだけ）", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                GDMComposerMode.NORMAL -> {}
            }
        }
    }
}

/** 「A さんが B さんを追加しました」: centred, small. */
@Composable
private fun GDMSystemLine(m: GMessage, modifier: Modifier) {
    Column(modifier.padding(vertical = 2.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            m.body,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f), RoundedCornerShape(10.dp))
                .padding(horizontal = 10.dp, vertical = 3.dp),
        )
    }
}

@Composable
private fun GDMBubble(
    row: GRow,
    showHeader: Boolean,
    myName: String?,
    canReact: Boolean,
    canEdit: Boolean,
    editing: Boolean,
    onReact: (String) -> Unit,
    onEdit: () -> Unit,
    onReply: () -> Unit,
    onSelect: () -> Unit,
    onRetry: () -> Unit,
    onDiscard: () -> Unit,
    onOpenImage: (List<String>, Int) -> Unit,
    modifier: Modifier,
) {
    val m = row.message
    val mine = m.isAuthor
    Row(modifier, horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        if (!mine) {
            Box(Modifier.size(28.dp)) {
                if (showHeader) {
                    if (m.isBeagle) {
                        Box(
                            Modifier.size(28.dp).background(Color(0x40FFC107), CircleShape).semantics { contentDescription = "ビーグル" },
                            contentAlignment = Alignment.Center,
                        ) { Text("🐶", fontSize = 15.sp) }
                    } else {
                        Avatar(ApiClient.absolute(m.fromAvatar) ?: m.fromAvatar, m.senderName, 28.dp)
                    }
                }
            }
            Spacer(Modifier.size(6.dp))
        }
        Column(
            Modifier.weight(1f, fill = false).padding(start = if (mine) 48.dp else 0.dp, end = if (mine) 0.dp else 40.dp),
            horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
        ) {
            if (!mine && showHeader) {
                Text(m.senderName, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(bottom = 2.dp))
            }
            // The chat's bubble, menu and chips; @me is marked like the chat's mention.
            val mentionsMe = remember(m.body, myName) { !mine && GDMLogic.mentionsMe(m.body, myName) }
            DMMessageBody(
                body = m.body, images = m.images, localImages = row.localImages, mine = mine, mentionsMe = mentionsMe, editing = editing,
                reactions = m.reactions, canReact = canReact && GDMLogic.canReact(row), canEdit = canEdit && GDMLogic.canEdit(row),
                onReact = onReact, onEdit = onEdit, onReply = if (GDMLogic.canReply(row)) onReply else null,
                onSelect = onSelect, onOpenImage = onOpenImage,
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
private fun GDMComposer(
    g: GDMStore,
    draft: TextFieldValue,
    photos: ChatAttachments,
    /** ✏️ Editing: null = not; else whether the message has photos (then the text may be emptied). */
    editing: Boolean?,
    focus: androidx.compose.ui.focus.FocusRequester,
    onCancelEdit: () -> Unit,
    onDraft: (TextFieldValue) -> Unit,
    onSend: () -> Unit,
) {
    val allowed = g.canSendCap && g.canSendHere
    // Photos are hidden while editing: an edit changes the text only (the chat's rule).
    val canAttach = allowed && g.canSendImages && editing == null
    val paste = rememberPasteImages(photos, g.maxImages, g.imageMaxSide, enabled = canAttach)
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 760.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                (g.error ?: photos.error)?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                if (!allowed) {
                    Text(
                        if (!g.canSendCap) "このアプリからは DM を送れません（読むだけ）" else "このグループにはまだ送れません",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (editing != null) EditingBanner(onCancelEdit)
                if (canAttach) ComposerPhotos(photos)
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (canAttach) PhotoAttachButtons(photos, g.maxImages, g.imageMaxSide)
                    PhotoTextField(
                        value = draft,
                        onValueChange = onDraft,
                        onImages = paste,
                        enabled = allowed,
                        placeholder = { Text(when {
                            editing != null -> "編集内容"
                            g.openId?.let { g.group(it) }?.beagle == true -> "@ビーグル で質問・要約（30 日で消えます）"
                            else -> "グループ DM（30 日で消えます）"
                        }) },
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
                    if (draft.text.length > g.maxBody * 0.8) Text("${draft.text.length} / ${g.maxBody}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                }
            }
        }
    }
}

// MARK: members

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun GDMMembersScreen(dm: DMStore, id: Long) {
    val g = dm.groups
    val group = g.group(id)
    var name by rememberSaveable(id) { mutableStateOf(group?.name.orEmpty()) }
    var confirmRemove by remember { mutableStateOf<GMember?>(null) }
    var confirmLeave by remember { mutableStateOf(false) }
    var confirmArchive by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var preparingPhoto by remember { mutableStateOf(false) }
    // 写真を選ぶ → 端末で長辺 1024px の JPEG に縮めて（EXIF は落ちる）送る。
    val pickPhoto = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        preparingPhoto = true
        g.actionError = null
        scope.launch {
            val jpeg = try {
                ChatAttachments.jpeg(context, uri, GDMLogic.PHOTO_SIDE, GDMLogic.PHOTO_QUALITY)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            } finally {
                preparingPhoto = false
            }
            if (jpeg == null) g.actionError = "写真を読み込めませんでした" else g.setPhoto(id, jpeg)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("メンバー${group?.let { "（${it.count} 人）" } ?: ""}", maxLines = 1) },
                navigationIcon = { IconButton(onClick = { dm.back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "戻る") } },
            )
        },
    ) { padding ->
        if (group == null) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.TopCenter) {
                Text("読み込み中…", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 40.dp))
            }
            return@Scaffold
        }
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(bottom = 32.dp)) {
            g.actionError?.let { e ->
                item { Text(e, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
            }
            // 🗄 / 🌐 not joined: name, photo, 🐶 and ＋ メンバー cannot be changed.
            val editable = GDMLogic.canChangeSettings(group)
            if (group.archived) {
                item {
                    Text("🗄 アーカイブされています（読むだけ）", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                }
            }
            // 👥 グループの写真 (メンバーなら誰でも。capabilities gdm.photo のときだけ操作を出す)
            item {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    GroupIcon(56.dp, group)
                    Column(Modifier.weight(1f)) {
                        Text("グループの写真", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (g.canSetPhoto && editable) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                TextButton(
                                    onClick = { pickPhoto.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                                    enabled = !g.busy && !preparingPhoto,
                                ) { Text(if (preparingPhoto) "準備中…" else GDMLogic.photoButtonLabel(group)) }
                                if (GDMLogic.photoUrl(group) != null) {
                                    TextButton(onClick = { g.removePhoto(id) }, enabled = !g.busy && !preparingPhoto) {
                                        Text("外す", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                }
                            }
                        } else if (GDMLogic.photoUrl(group) == null) {
                            Text("なし", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.outline)
                        }
                    }
                }
            }
            // 名前を変える (メンバーなら誰でも。空にするとメンバーの名前で出る)
            if (editable) item {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("グループ名", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(
                            value = name,
                            onValueChange = { name = it.take(g.maxName) },
                            placeholder = { Text("なし（メンバーの名前で出ます）") },
                            singleLine = true,
                            enabled = g.canSendCap,
                            supportingText = { Text("${name.length} / ${g.maxName}") },
                            modifier = Modifier.weight(1f),
                        )
                        val changed = GDMLogic.cleanName(name, g.maxName) != (group.name?.trim() ?: "")
                        TextButton(onClick = { g.rename(id, name) }, enabled = changed && !g.busy && g.canSendCap) { Text("保存") }
                    }
                }
            }
            // 🔕 通知を切る (自分の分だけ。アーカイブされていても切れる)
            if (group.isMember) item {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("🔕 通知を切る", style = MaterialTheme.typography.bodyLarge)
                        Text("このグループの DM が届いても通知しません", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Switch(checked = group.muted, onCheckedChange = { g.setMuted(id, it) }, enabled = !g.busy && g.canSendCap)
                }
            }
            if (g.canSetBeagle && editable) {
                item {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text("🐶 ビーグルを呼べるようにする", style = MaterialTheme.typography.bodyLarge)
                            Text(
                                "@ビーグル で質問・要約できます。答えはメンバー全員に見えます。入る前の流れも、新しく入った人に要約で伝えます。切り替えるとグループに知らせます。",
                                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Switch(checked = group.beagle, onCheckedChange = { g.setBeagle(id, it) }, enabled = !g.busy)
                    }
                }
            }
            // 🗄 アーカイブする（確認つき）／戻す: a member of a 🌐 public DM (capabilities gdm.archive).
            if (g.archiveEnabled && g.canSendCap && GDMLogic.canArchive(group)) {
                item {
                    TextButton(
                        onClick = { if (group.archived) g.setArchived(id, false) else confirmArchive = true },
                        enabled = !g.busy,
                        modifier = Modifier.padding(horizontal = 8.dp),
                    ) { Text(if (group.archived) "アーカイブから戻す" else "🗄 アーカイブする") }
                }
            }
            item { HorizontalDivider(Modifier.padding(top = 8.dp)) }
            if (g.canSendCap && editable) {
                item {
                    Row(
                        Modifier.fillMaxWidth().clickable(enabled = !g.busy) { dm.openAddMembers(id) }.padding(horizontal = 16.dp, vertical = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) { Text("＋ メンバーを追加", color = AccentGreen, style = MaterialTheme.typography.bodyLarge) }
                    HorizontalDivider(Modifier.padding(start = 16.dp))
                }
            }
            items(group.members, key = { it.userId }) { m ->
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Avatar(ApiClient.absolute(m.avatar) ?: m.avatar, m.displayName, 36.dp)
                    Column(Modifier.weight(1f)) {
                        Text(m.displayName + if (m.isMe) "（あなた）" else "", style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (m.isCreator) Text("作った人", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (GDMLogic.canRemove(group, m) && g.canSendCap) {
                        TextButton(onClick = { confirmRemove = m }, enabled = !g.busy) { Text("外す", color = MaterialTheme.colorScheme.error) }
                    }
                }
            }
            item {
                HorizontalDivider()
                Text(
                    if (group.isPublic) "🌐 パブリック DM は誰でも読めて、誰でも参加・退出できます。途中から入っても、前の発言を読めます。"
                    else "メンバーは誰でも追加できます。外せるのはグループを作った人だけです。途中から入った人は、入る前の発言を見られません。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
                // 🌐 Not joined yet: join from here too.
                if (g.canSendCap && g.publicEnabled && GDMLogic.composerMode(group) == GDMComposerMode.JOIN) {
                    TextButton(onClick = { g.join(id) }, enabled = !g.busy, modifier = Modifier.padding(horizontal = 8.dp)) {
                        Text("参加する", color = AccentGreen)
                    }
                }
                if (g.canSendCap && group.isMember) {
                    TextButton(onClick = { confirmLeave = true }, enabled = !g.busy, modifier = Modifier.padding(horizontal = 8.dp)) {
                        Text("グループから抜ける", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
    }

    confirmRemove?.let { m ->
        AlertDialog(
            onDismissRequest = { confirmRemove = null },
            title = { Text("${m.displayName}さんを外しますか？") },
            text = { Text("外された人は、このグループを見られなくなります。") },
            confirmButton = { TextButton(onClick = { confirmRemove = null; g.removeMember(id, m.userId) }) { Text("外す", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { confirmRemove = null }) { Text("やめる") } },
        )
    }
    if (confirmLeave) {
        AlertDialog(
            onDismissRequest = { confirmLeave = false },
            title = { Text("グループから抜けますか？") },
            text = {
                Text(
                    if (group?.isPublic == true) "抜けると、このグループの通知は届かなくなります。パブリック DM なので、誰でもいつでも参加し直せます。"
                    else "抜けると、このグループの DM は見られなくなります。もう一度入るには、メンバーに追加してもらう必要があります。"
                )
            },
            confirmButton = { TextButton(onClick = { confirmLeave = false; g.leave(id) }) { Text("抜ける", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { confirmLeave = false }) { Text("やめる") } },
        )
    }

    if (confirmArchive) {
        AlertDialog(
            onDismissRequest = { confirmArchive = false },
            title = { Text("アーカイブしますか？") },
            text = { Text("みんなの一覧から消えて「🗄 アーカイブ」に移り、読むだけになります（書き込み・参加はできません）。参加者なら誰でもアーカイブから戻せます。") },
            confirmButton = { TextButton(onClick = { confirmArchive = false; g.setArchived(id, true) }) { Text("アーカイブする") } },
            dismissButton = { TextButton(onClick = { confirmArchive = false }) { Text("やめる") } },
        )
    }
}

// MARK: pick people (make a group / add to one)

/** [groupId] null = make a new group (with an optional name); else add people to that group. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun GDMPickerScreen(dm: DMStore, members: List<MentionMember>, groupId: Long?) {
    val g = dm.groups
    val group = groupId?.let(g::group)
    var query by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var picked by rememberSaveable { mutableStateOf(listOf<String>()) }
    // 🌐 プライベート／パブリック (only when making one, and the server has public DMs).
    var makePublic by rememberSaveable { mutableStateOf(false) }
    val isPublic = groupId == null && makePublic && g.publicEnabled

    val exclude = remember(group, g.myUserId) { (group?.members?.map { it.userId }.orEmpty() + listOfNotNull(g.myUserId)).toSet() }
    val all = remember(members, dm.conversations) { GDMLogic.candidates(members, dm.conversations.map { it.peer }) }
    val peerIds = remember(dm.conversations) { dm.conversations.map { it.peer.userId }.toSet() }
    val shown = remember(all, exclude, query, picked, peerIds) { GDMLogic.pickerList(all, peerIds, picked, exclude, query) }
    val already = if (group != null) group.count else 1
    val limit = if (isPublic || group?.isPublic == true) g.publicMaxMembers else g.maxMembers
    val over = already + picked.size > limit

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (groupId == null) "グループを作る" else "メンバーを追加", maxLines = 1) },
                navigationIcon = { IconButton(onClick = { dm.back() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "戻る") } },
            )
        },
        contentWindowInsets = WindowInsets(0),
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (groupId == null && g.publicEnabled) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        androidx.compose.material3.FilterChip(selected = !makePublic, onClick = { makePublic = false }, label = { Text("プライベート") })
                        androidx.compose.material3.FilterChip(selected = makePublic, onClick = { makePublic = true }, label = { Text("🌐 パブリック") })
                    }
                    Text(
                        if (makePublic) "誰の DM 一覧にも出て、誰でも読めて、自由に参加・退出できます。名前が必要です。メンバーは選ばなくても作れます。あとから変えられません。"
                        else "選んだメンバーだけが見られます。あとから変えられません。",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (groupId == null) {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it.take(g.maxName) },
                        label = { Text(if (isPublic) "グループ名（必須）" else "グループ名（なくても OK）") },
                        singleLine = true,
                        supportingText = { Text(if (isPublic) "${name.length} / ${g.maxName}" else "${name.length} / ${g.maxName}・なければメンバーの名前で出ます") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text("名前を入れて探す") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                g.actionError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                if (over) Text("1 グループ $limit 人までです", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            HorizontalDivider()
            LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
                if (shown.isEmpty()) {
                    item {
                        Text(if (query.isBlank()) "名前を入れて探してください" else if (members.isEmpty()) "読み込み中…" else "見つかりません",
                            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
                    }
                }
                items(shown, key = { it.userId }) { m ->
                    val on = m.userId in picked
                    Row(
                        Modifier.fillMaxWidth().clickable { picked = if (on) picked - m.userId else picked + m.userId }.padding(horizontal = 16.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Avatar(ApiClient.absolute(m.avatar) ?: m.avatar, m.name, 36.dp)
                        Text(m.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        Checkbox(checked = on, onCheckedChange = { picked = if (it) picked + m.userId else picked - m.userId })
                    }
                }
            }
            HorizontalDivider()
            Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
                Row(
                    Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(when {
                            picked.isNotEmpty() -> "${picked.size} 人を選択中"
                            isPublic -> if (GDMLogic.cleanName(name, g.maxName).isEmpty()) "名前を入れてください" else "メンバーは選ばなくても作れます"
                            else -> "1 人以上選んでください"
                        },
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                    Button(
                        onClick = {
                            if (groupId == null) g.create(picked, name, public = isPublic) { id -> dm.groupCreated(id) }
                            else g.addMembers(groupId, picked) { dm.back() }
                        },
                        enabled = (if (groupId == null) GDMLogic.canCreate(isPublic, name, picked.size, g.maxName) else picked.isNotEmpty()) && !over && !g.busy && g.canSendCap,
                    ) { Text(if (g.busy) "…" else if (groupId == null) "作る" else "追加する") }
                }
            }
        }
    }
}
