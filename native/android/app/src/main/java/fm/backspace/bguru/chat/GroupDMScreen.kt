package fm.backspace.bguru.chat

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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.flow.distinctUntilChanged

/* 👥 グループ DM の画面（docs/group-dm-spec.md）: 一覧の 1 行・グループ・メンバー・人を選ぶ（作る／追加）。
 * 見た目と言い回しは 1 対 1 の DMScreen に合わせる。 */

@Composable
private fun GroupIcon(size: androidx.compose.ui.unit.Dp) {
    Box(Modifier.size(size).background(MaterialTheme.colorScheme.surfaceVariant, CircleShape), contentAlignment = Alignment.Center) {
        Text("👥", fontSize = (size.value * 0.5).sp)
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
        GroupIcon(40.dp)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("👥 ${s.group.displayTitle}", style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Text(" ${s.group.count}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                if (s.group.muted) Text(" 🔕", style = MaterialTheme.typography.labelSmall)
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

// MARK: the group

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun GDMGroupScreen(dm: DMStore, id: Long) {
    val g = dm.groups
    val context = LocalContext.current
    val listState = rememberLazyListState()
    var draft by rememberSaveable(id) { mutableStateOf("") }

    // On screen (resumed) = read: tells the store, and clears this group's notification.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, id) {
        fun on() { g.setScreenVisible(id, true); Push.clearGDMNotification(context, id) }
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) on()
        val obs = LifecycleEventObserver { _, e ->
            when (e) {
                Lifecycle.Event.ON_RESUME -> on()
                Lifecycle.Event.ON_PAUSE -> g.setScreenVisible(id, false)
                else -> Unit
            }
        }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs); g.setScreenVisible(id, false) }
    }

    LaunchedEffect(g) {
        snapshotFlow { g.rows.lastOrNull()?.key }.distinctUntilChanged().collect {
            val last = g.rows.lastOrNull() ?: return@collect
            if (listState.firstVisibleItemIndex <= 1 || last.message.isAuthor) listState.animateScrollToItem(0)
        }
    }

    val group = g.group(id)
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("👥 ${group?.displayTitle ?: "グループ"}", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (group != null) {
                            Text("${group.count} 人${if (group.muted) "・🔕 通知オフ" else ""}", style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
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
            LazyColumn(
                state = listState,
                reverseLayout = true,
                modifier = Modifier.weight(1f).fillMaxWidth(),
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
                    else GDMBubble(row, showHeader, onRetry = { g.retry(row) }, onDiscard = { g.discard(row) },
                        modifier = Modifier.widthIn(max = 760.dp).fillMaxWidth())
                }
            }
            HorizontalDivider()
            GDMComposer(
                g = g,
                draft = draft,
                onDraft = { draft = it.take(g.maxBody) },
                onSend = {
                    val text = draft
                    draft = ""
                    g.send(text) { body -> if (draft.isEmpty()) draft = body }
                },
            )
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
private fun GDMBubble(row: GRow, showHeader: Boolean, onRetry: () -> Unit, onDiscard: () -> Unit, modifier: Modifier) {
    val m = row.message
    val mine = m.isAuthor
    Row(modifier, horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        if (!mine) {
            Box(Modifier.size(28.dp)) { if (showHeader) Avatar(ApiClient.absolute(m.fromAvatar) ?: m.fromAvatar, m.senderName, 28.dp) }
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
private fun GDMComposer(g: GDMStore, draft: String, onDraft: (String) -> Unit, onSend: () -> Unit) {
    val allowed = g.canSendCap && g.canSendHere
    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(Modifier.widthIn(max = 760.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                g.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                if (!allowed) {
                    Text(
                        if (!g.canSendCap) "このアプリからは DM を送れません（読むだけ）" else "このグループにはまだ送れません",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextField(
                        value = draft,
                        onValueChange = onDraft,
                        enabled = allowed,
                        placeholder = { Text("グループ DM（30 日で消えます）") },
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
                    Text("DM は 30 日で消えます", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline, modifier = Modifier.weight(1f))
                    if (draft.length > g.maxBody * 0.8) Text("${draft.length} / ${g.maxBody}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
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
            // 名前を変える (メンバーなら誰でも。空にするとメンバーの名前で出る)
            item {
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
            // 🔕 通知を切る (自分の分だけ)
            item {
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
            item { HorizontalDivider(Modifier.padding(top = 8.dp)) }
            if (g.canSendCap) {
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
                    "メンバーは誰でも追加できます。外せるのはグループを作った人だけです。途中から入った人は、入る前の発言を見られません。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
                if (g.canSendCap) {
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
            text = { Text("抜けると、このグループの DM は見られなくなります。もう一度入るには、メンバーに追加してもらう必要があります。") },
            confirmButton = { TextButton(onClick = { confirmLeave = false; g.leave(id) }) { Text("抜ける", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { confirmLeave = false }) { Text("やめる") } },
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

    val exclude = remember(group, g.myUserId) { (group?.members?.map { it.userId }.orEmpty() + listOfNotNull(g.myUserId)).toSet() }
    val all = remember(members, dm.conversations) { GDMLogic.candidates(members, dm.conversations.map { it.peer }) }
    val shown = remember(all, exclude, query) { GDMLogic.pickable(all, exclude, query) }
    val already = if (group != null) group.count else 1
    val over = already + picked.size > g.maxMembers

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
                if (groupId == null) {
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it.take(g.maxName) },
                        label = { Text("グループ名（なくても OK）") },
                        singleLine = true,
                        supportingText = { Text("${name.length} / ${g.maxName}・なければメンバーの名前で出ます") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    placeholder = { Text("名前で探す") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                g.actionError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                if (over) Text("1 グループ ${g.maxMembers} 人までです", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            HorizontalDivider()
            LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
                if (shown.isEmpty()) {
                    item {
                        Text(if (members.isEmpty() && dm.conversations.isEmpty()) "読み込み中…" else "選べる人がいません",
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
                    Text(if (picked.isEmpty()) "1 人以上選んでください" else "${picked.size} 人を選択中",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                    Button(
                        onClick = {
                            if (groupId == null) g.create(picked, name) { id -> dm.groupCreated(id) }
                            else g.addMembers(groupId, picked) { dm.back() }
                        },
                        enabled = picked.isNotEmpty() && !over && !g.busy && g.canSendCap,
                    ) { Text(if (g.busy) "…" else if (groupId == null) "作る" else "追加する") }
                }
            }
        }
    }
}
