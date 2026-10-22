package fm.backspace.bguru.chat

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.launch

/** The operation dialog on screen (TimelineStore.dialog): one at a time, over the list or a thread. */
sealed interface PostDialog {
    /** New post. `preset` (demo only): "poll" | "mention" | "media". */
    data class Compose(val preset: String? = null) : PostDialog
    data class Edit(val post: Post) : PostDialog
    data class Delete(val post: Post) : PostDialog
    data class Picker(val post: Post) : PostDialog
    data class PollEdit(val post: Post) : PostDialog
    data class Club(val post: Post) : PostDialog
    /** "pinned" | "bm" | "fav". */
    data class List(val filter: String) : PostDialog
}

/** The Snackbar's message; `undo` = tap it to take the change back (5 seconds). */
class PostToast(val text: String, val undo: (() -> Unit)? = null)

/** Light blue of 「うなる」 and blue of 「吠える」 (the web's Mantine blue). */
val BarkBlue = Color(0xFF228BE6)

/** Draws [TimelineStore.dialog] and the toast. `onOpenThread`: a post in a list was tapped. */
@Composable
fun PostDialogHost(timeline: TimelineStore, capabilities: Capabilities?, onOpenThread: (Long) -> Unit) {
    when (val d = timeline.dialog) {
        null -> {}
        is PostDialog.Compose -> PostEditorDialog(timeline, capabilities, editing = null, preset = d.preset,
            onDismiss = { timeline.dialog = null }, onDone = { timeline.didPublish(it); timeline.dialog = null })
        is PostDialog.Edit -> PostEditorDialog(timeline, capabilities, editing = d.post, preset = null,
            onDismiss = { timeline.dialog = null }, onDone = { timeline.didEdit(it); timeline.dialog = null })
        is PostDialog.Delete -> DeleteDialog(timeline, d.post)
        is PostDialog.Picker -> EmojiPickerSheet(onDismiss = { timeline.dialog = null }) { e -> timeline.dialog = null; timeline.react(d.post, e) }
        is PostDialog.PollEdit -> PollEditDialog(timeline, d.post)
        is PostDialog.Club -> ClubDialog(timeline, d.post)
        is PostDialog.List -> PostListSheet(timeline, d.filter, onOpenThread)
    }
}

/** The toast at the bottom: tap = undo (when it offers one), gone after 5 seconds. */
@Composable
fun PostToastBar(timeline: TimelineStore, modifier: Modifier) {
    val t = timeline.toast ?: return
    LaunchedEffect(t) {
        kotlinx.coroutines.delay(PostActions.TOAST_MS)
        if (timeline.toast === t) timeline.toast = null
    }
    Snackbar(
        modifier = modifier.widthIn(max = 560.dp).padding(12.dp).clickable {
            timeline.toast = null
            t.undo?.invoke()
        }.semantics { contentDescription = t.text },
    ) { Text(t.text) }
}

// MARK: delete

@Composable
private fun DeleteDialog(timeline: TimelineStore, post: Post) {
    var error by remember(post.id) { mutableStateOf<String?>(null) }
    var busy by remember(post.id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = { if (!busy) timeline.dialog = null },
        title = { Text(PostActions.DELETE_TITLE) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(PostActions.DELETE_BODY)
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        dismissButton = { TextButton(onClick = { timeline.dialog = null }, enabled = !busy) { Text("キャンセル") } },
        confirmButton = {
            Button(
                onClick = {
                    busy = true
                    scope.launch {
                        error = timeline.delete(post)
                        busy = false
                        if (error == null) timeline.dialog = null
                    }
                },
                enabled = !busy,
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
            ) { Text(if (busy) "削除中…" else "削除する") }
        },
    )
}

// MARK: club

/** 「部活動を選択」: every club (the current one ✓), then 「ラベルなし」 in red. */
@Composable
private fun ClubDialog(timeline: TimelineStore, post: Post) {
    LaunchedEffect(Unit) { timeline.loadClubs() }
    AlertDialog(
        onDismissRequest = { timeline.dialog = null },
        title = { Text("部活動を選択") },
        text = {
            LazyColumn(Modifier.heightIn(max = 420.dp)) {
                items(timeline.clubs.entries.toList(), key = { it.key }) { (key, name) ->
                    Row(
                        Modifier.fillMaxWidth().clickable { timeline.dialog = null; if (key != post.club) timeline.setClub(post, key) }
                            .padding(vertical = 10.dp, horizontal = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(name, modifier = Modifier.weight(1f))
                        if (key == post.club) Text("✓", color = AccentGreen, fontWeight = FontWeight.Bold)
                    }
                }
                item {
                    HorizontalDivider()
                    Text("ラベルなし", color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.fillMaxWidth().clickable { timeline.dialog = null; if (post.club != null) timeline.setClub(post, null) }
                            .padding(vertical = 10.dp, horizontal = 4.dp))
                }
            }
        },
        confirmButton = { TextButton(onClick = { timeline.dialog = null }) { Text("キャンセル") } },
    )
}


// MARK: poll

/** The poll under a post: 「📊 投票（N票）」, the answers (tap = vote / change), the result bars,
 *  time left; 「回答を編集」 for the author within an hour (PollCard in src/app/page.tsx). */
@Composable
fun PollCard(post: Post, poll: PostPoll, canVote: Boolean, canEdit: Boolean, onVote: (Long) -> Unit, onEdit: () -> Unit) {
    val closed = PollRules.isClosed(poll)
    val shape = RoundedCornerShape(12.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.04f))
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("📊 投票（${poll.totalVotes}票）", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            if (canEdit && poll.editable && !closed) {
                // A pen only, like Mac / iOS (the web's ActionIcon「回答を編集」).
                IconButton(onClick = onEdit, modifier = Modifier.size(28.dp)) {
                    Icon(Icons.Default.Edit, "回答を編集", Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        poll.options.forEach { o ->
            val mine = poll.myVote == o.id
            val s = RoundedCornerShape(8.dp)
            Box(
                Modifier.fillMaxWidth().alpha(if (closed) PollRules.CLOSED_ALPHA else 1f).clip(s)
                    .background(MaterialTheme.colorScheme.surface)
                    .border(if (mine) 2.dp else 1.dp, if (mine) Color(0xFF94D82D) else MaterialTheme.colorScheme.outlineVariant, s)
                    .clickable(enabled = canVote && !closed) { onVote(o.id) }
                    .semantics { contentDescription = "${o.label}：${PollRules.optionState(poll, o.id, closed)}" },
            ) {
                if (poll.totalVotes > 0) {
                    Box(Modifier.matchParentSize()) { Box(Modifier.fillMaxHeight().fillMaxWidth(o.pct / 100f).background(Color(0x2E4ADE80))) }
                }
                Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(o.label, fontWeight = if (mine) FontWeight.Bold else FontWeight.Medium, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    if (mine && !closed) {
                        Text("あなたの投票", fontSize = 10.sp, color = AccentGreen, fontWeight = FontWeight.Bold,
                            modifier = Modifier.background(AccentGreen.copy(alpha = 0.14f), CircleShape).padding(horizontal = 6.dp, vertical = 1.dp))
                    }
                    if (poll.totalVotes > 0) Text("${o.votes}票 (${o.pct}%)", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        Row {
            Text(PollRules.footer(poll, closed), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            Text(if (closed) "終了" else PollRules.timeLeft(poll.endsAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** 「アンケートの回答を編集」: answers only (the question is the post's text, edited with ✏️). */
@Composable
private fun PollEditDialog(timeline: TimelineStore, post: Post) {
    val poll = post.poll ?: return
    var rows by remember(post.id) { mutableStateOf(PollRules.editRows(poll)) }
    var error by remember(post.id) { mutableStateOf<String?>(null) }
    var busy by remember(post.id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = { if (!busy) timeline.dialog = null },
        title = { Text("アンケートの回答を編集") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("回答の編集は投稿後1時間以内のみです。投票が付いた回答は削除できません。", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                rows.forEachIndexed { i, o ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(o.label, { v -> rows = rows.toMutableList().also { it[i] = o.copy(label = v.take(PollRules.LABEL_MAX)) } },
                            placeholder = { Text("回答 ${i + 1}") }, singleLine = true, modifier = Modifier.weight(1f),
                            suffix = if (o.votes > 0) ({ Text("${o.votes}票", style = MaterialTheme.typography.labelSmall) }) else null)
                        IconButton(onClick = { rows = rows.filterIndexed { k, _ -> k != i } }, enabled = PollRules.canRemove(rows, i)) {
                            Icon(Icons.Default.Close, if (o.votes > 0) "投票が付いているため削除できません" else "回答を削除")
                        }
                    }
                }
                TextButton(onClick = { rows = rows + PollRules.EditOption(null, "") }, enabled = PollRules.canAdd(rows.size)) {
                    Text("＋ 回答を追加（${rows.size}/${PollRules.MAX_OPTIONS}）", color = AccentGreen)
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        dismissButton = { TextButton(onClick = { timeline.dialog = null }, enabled = !busy) { Text("キャンセル") } },
        confirmButton = {
            Button(onClick = {
                busy = true
                scope.launch {
                    error = timeline.editPoll(post, rows)
                    busy = false
                    if (error == null) timeline.dialog = null
                }
            }, enabled = !busy && rows.count { it.label.isNotBlank() } >= PollRules.MIN_OPTIONS,
                colors = ButtonDefaults.buttonColors(containerColor = AccentGreen)) { Text("保存する") }
        },
    )
}

/** The poll being written in a new post: answers, 締切 1/6/12/24 時間. */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun PollDraftEditor(draft: PostDraft) {
    val p = draft.poll ?: return
    val shape = RoundedCornerShape(12.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.04f))
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        FlowRow(verticalArrangement = Arrangement.Center, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("アンケート", fontWeight = FontWeight.Bold, modifier = Modifier.align(Alignment.CenterVertically).padding(end = 8.dp))
            Text("締切", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.align(Alignment.CenterVertically))
            PollRules.DURATIONS.forEach { h ->
                FilterChip(selected = p.durationHours == h, onClick = { draft.poll = p.copy(durationHours = h) }, label = { Text("${h}時間") },
                    colors = androidx.compose.material3.FilterChipDefaults.filterChipColors(selectedContainerColor = AccentGreen, selectedLabelColor = Color.White))
            }
        }
        Text("質問は投稿の本文になります。本文に投票の質問を書いてね。", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        p.options.forEachIndexed { i, opt ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(opt, { v -> draft.poll = p.copy(options = p.options.toMutableList().also { it[i] = v.take(PollRules.LABEL_MAX) }) },
                    placeholder = { Text("回答 ${i + 1}") }, singleLine = true, modifier = Modifier.weight(1f))
                IconButton(onClick = { draft.poll = p.copy(options = p.options.filterIndexed { k, _ -> k != i }) }, enabled = p.options.size > PollRules.MIN_OPTIONS) {
                    Icon(Icons.Default.Close, "回答 ${i + 1} を削除")
                }
            }
        }
        TextButton(onClick = { draft.poll = p.copy(options = p.options + "") }, enabled = PollRules.canAdd(p.options.size)) {
            Text("＋ 回答を追加（${p.options.size}/${PollRules.MAX_OPTIONS}）", color = AccentGreen)
        }
        Text("投票は1人1回・締切まで回答を変更できます。", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// MARK: reactions

/** The reaction picker: 「よく使う」 12, then all, then the custom emoji (the web's ReactionBar).
 *  Used by timeline posts and the chat alike. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EmojiPickerSheet(onDismiss: () -> Unit, onPick: (String) -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = false)
    @Suppress("UNUSED_VARIABLE") val v = EmojiCatalog.version // recompose when the custom list arrives
    val custom = EmojiCatalog.urls.entries.toList()
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state) {
        LazyVerticalGrid(GridCells.Adaptive(46.dp), Modifier.fillMaxWidth().padding(horizontal = 12.dp).navigationBarsPadding()) {
            item(span = { GridItemSpan(maxLineSpan) }) { PickerHeader("よく使う") }
            items(EmojiSets.QUICK, key = { "q$it" }) { e -> EmojiCell(e, onPick) }
            item(span = { GridItemSpan(maxLineSpan) }) { PickerHeader("すべて") }
            items(EmojiSets.ALL, key = { "a$it" }) { e -> EmojiCell(e, onPick) }
            if (custom.isNotEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }) { PickerHeader("カスタム絵文字") }
                items(custom, key = { "c${it.key}" }) { (name, url) ->
                    Box(Modifier.size(46.dp).clip(RoundedCornerShape(8.dp)).clickable { onPick(EmojiSets.customRef(name)) }
                        .semantics { contentDescription = ":$name:" }, contentAlignment = Alignment.Center) {
                        RemoteImage(url, Modifier.size(30.dp), ContentScale.Fit, maxPx = 96) { Text(":$name:", fontSize = 9.sp, maxLines = 1) }
                    }
                }
            }
            item(span = { GridItemSpan(maxLineSpan) }) { Spacer(Modifier.height(16.dp)) }
        }
    }
}

@Composable
private fun PickerHeader(text: String) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 10.dp, bottom = 4.dp))
}

@Composable
private fun EmojiCell(e: String, onPick: (String) -> Unit) {
    Box(Modifier.size(46.dp).clip(RoundedCornerShape(8.dp)).clickable { onPick(e) }, contentAlignment = Alignment.Center) {
        Text(e, fontSize = 26.sp)
    }
}

// MARK: lists

/** 📌 ピン留め / 🔖 ブックマーク / ☆ お気に入りの人: a simple list in a sheet; tap = the thread. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PostListSheet(timeline: TimelineStore, filter: String, onOpenThread: (Long) -> Unit) {
    LaunchedEffect(filter) { timeline.loadList(filter) }
    val title = when (filter) { "pinned" -> "📌 ピン留め"; "bm" -> "🔖 ブックマーク"; else -> "☆ お気に入りの人の投稿" }
    val empty = when (filter) {
        "pinned" -> PostActions.PINS_EMPTY
        "bm" -> "ブックマークはありません。投稿を長押しして「ブックマークに保存」で追加できます。"
        else -> "お気に入りの人の投稿はありません。投稿を長押しして「お気に入りに追加」で人を追加できます。"
    }
    val context = LocalContext.current
    ModalBottomSheet(onDismissRequest = { timeline.dialog = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            val list = timeline.listPosts
            when {
                list == null -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally).padding(24.dp))
                list.isEmpty() -> Text(timeline.listFailed ?: empty, color = if (timeline.listFailed != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(16.dp))
                else -> LazyColumn(Modifier.fillMaxWidth()) {
                    items(list, key = { it.id }) { p ->
                        PostRow(p, timeline.clubName(p.club), App.session(context).store?.capabilities?.canReactPosts ?: false,
                            onReact = { timeline.react(p, it) }, onOpenImage = {},
                            onClick = { timeline.dialog = null; onOpenThread(p.parentId ?: p.id) }, memberNames = timeline.memberNames)
                        HorizontalDivider()
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
        }
    }
}

// MARK: the post editor (new post / edit)

/** New post (text, photos or a video, a sound, a poll, a club) or 「投稿を編集」 (text, photos
 *  replaced / reordered, the sound; a video stays — the web's rule). `editing` = the post. */
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun PostEditorDialog(timeline: TimelineStore, caps: Capabilities?, editing: Post?, preset: String?, onDismiss: () -> Unit, onDone: (Post) -> Unit) {
    val draft = remember(editing?.id) {
        PostDraft(caps?.maxImages ?: 5, caps?.maxMediaMb ?: 100).also { d ->
            if (editing != null) d.startEdit(editing)
            when (preset) {
                "poll" -> { d.text = "次の B-guru オフ会はどこがいい？"; d.poll = PollDraft(listOf("東京", "大阪", "オンライン"), 24) }
                "mention" -> d.text = "@ma"
                "media" -> { d.text = "写真と音声のテスト"; d.demoAttach(listOf("${timeline.demoMedia}/parity-wide.jpg", "${timeline.demoMedia}/parity-square.jpg"), "${timeline.demoMedia}/parity-voice.m4a") }
                "club" -> { d.text = "部活を選んで投稿"; d.club = timeline.clubs.keys.firstOrNull() }
            }
        }
    }
    val textOnly = editing != null && caps?.editTextOnly == true
    val isNew = editing == null
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val withVideo = isNew && caps?.canPostVideo == true
    val pick = rememberPhotoPicker(draft, withVideo = withVideo)
    val camera = rememberCameraCapture { ctx, uri -> draft.add(ctx, listOf(uri)) }
    val pickAudio = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) scope.launch { draft.attachAudio(context, uri) }
    }
    LaunchedEffect(Unit) { timeline.loadClubs(); timeline.loadMembers() }
    fun submit() {
        if (!draft.canSend && isNew) return
        scope.launch {
            val r = if (isNew) draft.send(timeline.api, null, demo = timeline.demo) else draft.saveEdit(timeline.api, textOnly, demo = timeline.demo)
            r?.let(onDone)
        }
    }
    val matches = Mention.activeQuery(draft.text)?.let { q -> Mention.candidates(timeline.members, q.second, emptyList()) } ?: emptyList()
    Dialog(onDismissRequest = { if (!draft.sending && (draft.isEmpty || !isNew)) onDismiss() }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        // Edge to edge: the sheet covers the bars too (the app bar keeps clear of the status bar),
        // with the bars' icons dark on the light sheet and light on the dark one.
        val view = androidx.compose.ui.platform.LocalView.current
        val dark = androidx.compose.foundation.isSystemInDarkTheme()
        LaunchedEffect(view, dark) {
            (view.parent as? androidx.compose.ui.window.DialogWindowProvider)?.window?.let { w ->
                androidx.core.view.WindowCompat.getInsetsController(w, view).apply {
                    isAppearanceLightStatusBars = !dark
                    isAppearanceLightNavigationBars = !dark
                }
            }
        }
        Surface(Modifier.fillMaxSize()) {
            // The sheet itself fills the screen (nothing behind shows through the bars); only its content keeps clear of them.
            Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.displayCutout)).imePadding()) {
                TopAppBar(windowInsets = WindowInsets(0),
                    title = { Text(if (isNew) "新しい投稿" else "投稿を編集") },
                    navigationIcon = { TextButton(onClick = onDismiss, enabled = !draft.sending) { Text("キャンセル") } },
                    actions = {
                        TextButton(enabled = !draft.sending && (draft.canSend || !isNew), onClick = ::submit) {
                            Text(when { draft.sending -> "送信中…"; isNew -> "投稿"; else -> "保存する" })
                        }
                    },
                )
                Column(Modifier.padding(horizontal = 16.dp).weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextField(
                        value = draft.value, onValueChange = { draft.value = it },
                        placeholder = { Text(composerPlaceholder(if (isNew) "いまどうしてる？" else "本文")) },
                        keyboardOptions = ComposerKeyboardOptions,
                        modifier = Modifier.fillMaxWidth()
                            .composerKeys(draft.value, { draft.value = it }, onSend = ::submit,
                                mentionOpen = matches.isNotEmpty(), onPickMention = { matches.firstOrNull()?.let { draft.text = Mention.complete(draft.text, it.name) } }),
                        minLines = 5,
                        colors = TextFieldDefaults.colors(focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent),
                    )
                    if (matches.isNotEmpty()) MentionSuggestions(matches) { draft.text = Mention.complete(draft.text, it.name) }
                    if (!textOnly) {
                        DraftImages(draft)
                        DraftMedia(draft)
                        if (isNew) PollDraftEditor(draft)
                    }
                    draft.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                    if (textOnly) Text("この鍵では本文だけ編集できます", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (isNew && caps?.canSelectClub == true) ClubChooser(timeline, draft)
                    Spacer(Modifier.height(8.dp))
                }
                if (!textOnly) {
                    HorizontalDivider()
                    FlowRow(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalArrangement = Arrangement.Center) {
                        TextButton(onClick = pick, enabled = draft.remaining > 0 || (withVideo && draft.canAttachMedia)) { Text(if (withVideo) "🖼️ 写真・動画" else "🖼️ 写真") }
                        CameraButton(onClick = camera, enabled = draft.remaining > 0)
                        if ((isNew && caps?.canPostAudio == true) || (!isNew && editing?.videoUrl == null)) {
                            TextButton(onClick = { pickAudio.launch("audio/*") }, enabled = draft.canAttachMedia) { Text("🎵 音声") }
                        }
                        if (isNew && caps?.canCreatePoll == true) {
                            TextButton(onClick = { draft.poll = if (draft.poll == null) PollDraft() else null }) {
                                Text(if (draft.poll == null) "📊 投票を追加" else "投票を外す", color = if (draft.poll != null) AccentGreen else Color.Unspecified)
                            }
                        }
                        Text("${draft.images.size}/${draft.maxImages}", style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.align(Alignment.CenterVertically).padding(start = 4.dp))
                    }
                }
            }
        }
    }
}

/** 部活：「自動で分類」 or a club chosen by hand (then the AI does not sort it). */
@Composable
private fun ClubChooser(timeline: TimelineStore, draft: PostDraft) {
    var open by remember { mutableStateOf(false) }
    Box {
        val name = draft.club?.let { timeline.clubs[it] }
        Text("部活：" + (name ?: "自動で分類（AI）") + " ▾", style = MaterialTheme.typography.labelLarge,
            color = if (name != null) AccentGreen else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.clip(CircleShape).border(1.dp, MaterialTheme.colorScheme.outlineVariant, CircleShape).clickable { open = true }
                .padding(horizontal = 12.dp, vertical = 6.dp))
        DropdownMenu(open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text("自動で分類（AI）" + if (draft.club == null) "  ✓" else "") }, onClick = { open = false; draft.club = null })
            timeline.clubs.forEach { (key, n) ->
                DropdownMenuItem(text = { Text(n + if (draft.club == key) "  ✓" else "") }, onClick = { open = false; draft.club = key })
            }
        }
    }
}

/** Thumbnails of the attached photos with ✕ (and ◀ to move one earlier). */
@Composable
fun DraftImages(draft: PostDraft) {
    if (draft.loading > 0) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            Text("画像を読み込み中…", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    if (draft.images.isEmpty()) return
    LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 4.dp)) {
        itemsIndexed(draft.images) { i, img ->
            Box {
                val m = Modifier.size(64.dp).clip(RoundedCornerShape(8.dp))
                when (img) {
                    is DraftImage.Local -> Image(img.bitmap.asImageBitmap(), null, m, contentScale = ContentScale.Crop)
                    is DraftImage.Remote -> RemoteImage(img.url, m, ContentScale.Crop, maxPx = 200) { Box(m.background(MaterialTheme.colorScheme.surfaceVariant)) }
                }
                Box(Modifier.align(Alignment.TopEnd).size(22.dp).background(Color.Black.copy(alpha = 0.55f), CircleShape).clickable { draft.remove(i) },
                    contentAlignment = Alignment.Center) { Icon(Icons.Default.Close, "画像 ${i + 1} を外す", tint = Color.White, modifier = Modifier.size(14.dp)) }
                if (i > 0 && draft.images.size > 1) {
                    Box(Modifier.align(Alignment.BottomStart).size(22.dp).background(Color.Black.copy(alpha = 0.55f), CircleShape).clickable { draft.moveEarlier(i) }
                        .semantics { contentDescription = "画像 ${i + 1} を前へ" }, contentAlignment = Alignment.Center) { Text("◀", color = Color.White, fontSize = 10.sp) }
                }
            }
        }
    }
}

/** The attached video / sound as a line with ✕. */
@Composable
fun DraftMedia(draft: PostDraft) {
    @Composable
    fun line(text: String, onRemove: (() -> Unit)?) {
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f))
            .padding(start = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(text, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (onRemove != null) IconButton(onClick = onRemove) { Icon(Icons.Default.Close, "外す") } else Spacer(Modifier.width(12.dp).height(40.dp))
        }
    }
    draft.video?.let { line("🎬 ${it.name}（${MediaRules.sizeText(it.bytes)}）", draft::removeVideo) }
    draft.videoRemote?.let { line("🎬 動画（付け替えはできません）", null) }
    draft.audio?.let { line("🎵 ${it.name}（${MediaRules.sizeText(it.bytes)}）", draft::removeAudio) }
    draft.audioRemote?.let { url -> line("🎵 " + url.substringAfterLast('/').take(40), draft::removeAudio) }
}

/** The Android Photo Picker (no storage permission needed): photos up to the draft's remaining
 *  slots, and with `withVideo` one video too (mp4 / webm / mov, 100 MB). */
@Composable
fun rememberPhotoPicker(draft: PostDraft, withVideo: Boolean = false): () -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(5)) { uris ->
        if (BuildConfig.DEBUG) android.util.Log.d("BguruDraft", "picked ${uris.size}")
        if (uris.isNotEmpty()) scope.launch { draft.add(context, uris) }
    }
    return {
        launcher.launch(PickVisualMediaRequest(if (withVideo && draft.canAttachMedia) ActivityResultContracts.PickVisualMedia.ImageAndVideo else ActivityResultContracts.PickVisualMedia.ImageOnly))
    }
}
