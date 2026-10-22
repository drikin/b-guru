package fm.backspace.bguru.chat

import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import kotlinx.coroutines.launch

/** One thread: the post and its replies, with a reply bar (text + photos). */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun ThreadScreen(
    id: Long,
    timeline: TimelineStore,
    capabilities: Capabilities?,
    onReconnect: () -> Unit,
    onOpenImage: (List<String>, Int) -> Unit,
) {
    var root by remember(id) { mutableStateOf<Post?>(null) }
    var replies by remember(id) { mutableStateOf<List<Post>>(emptyList()) }
    var failed by remember(id) { mutableStateOf(false) }
    val draft = remember(id) { PostDraft(capabilities?.maxImages ?: 5, capabilities?.maxMediaMb ?: 100) }
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val listState = rememberLazyListState()
    val canMedia = capabilities?.canPostVideo == true
    val pick = rememberPhotoPicker(draft, withVideo = canMedia)
    val context = androidx.compose.ui.platform.LocalContext.current
    val pickAudio = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) scope.launch { draft.attachAudio(context, uri) }
    }
    val canWhisper = PostActions.canWhisper(capabilities, id)
    val camera = rememberCameraCapture { ctx, uri -> draft.add(ctx, listOf(uri)) }
    val canReact = capabilities?.canReactPosts ?: false

    var refreshing by remember(id) { mutableStateOf(false) }

    suspend fun load() {
        if (timeline.demo) {
            root = timeline.posts.firstOrNull { it.id == id }
            replies = listOf(
                Post(100, authorName = "takuto", parentId = id, text = "かわいい！", createdAt = root?.createdAt ?: "", unread = true),
                Post(101, authorName = "ドリキン", isAuthor = true, parentId = id, text = "名前なんでしたっけ", createdAt = root?.createdAt ?: ""),
            )
            return
        }
        try {
            val t = timeline.api.thread(id)
            root = t.post
            replies = t.replies
            failed = false
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            failed = root == null
        }
    }
    LaunchedEffect(id) { load() }
    // Operations done anywhere (menu, dialogs, the toast's undo) show here too.
    var deleted by remember(id) { mutableStateOf(false) }
    androidx.compose.runtime.DisposableEffect(id) {
        val stop = timeline.listen { pid, f ->
            root = root?.let { r -> if (pid == -1L || r.id == pid) f(r).also { if (it == null) deleted = true } else r }
            replies = replies.mapNotNull { r -> if (pid == -1L || r.id == pid) f(r) else r }
        }
        onDispose { stop() }
    }

    // New replies (and an unread root) stay highlighted until each has been on screen for a second.
    fun read(p: Post, isRoot: Boolean) {
        if (isRoot) {
            root = root?.copy(unread = false)
            if (timeline.posts.any { it.id == p.id }) timeline.sawPost(p.id) else timeline.markRead(listOf(p.id))
        } else {
            replies = replies.map { if (it.id == p.id) it.copy(unread = false) else it }
            timeline.sawReply(p.id, root = id)
        }
    }

    fun react(post: Post, emoji: String) = timeline.react(post, emoji)

    fun sendReply(whisper: Boolean = false) {
        if (!draft.canSend) return
        scope.launch {
            draft.send(timeline.api, id, whisper = whisper && canWhisper, demo = timeline.demo)?.let { post ->
                replies = replies + post
                root = root?.copy(replyCount = (root?.replyCount ?: 0) + 1)
                // 「うなる」 does not lift the thread: the list keeps its place.
                if (!whisper) timeline.didPublish(post)
                listState.animateScrollToItem(replies.size)
            }
        }
    }
    val matches = Mention.activeQuery(draft.text)?.let { q -> Mention.candidates(timeline.members, q.second, replies.reversed().mapNotNull { it.authorName }.distinct()) } ?: emptyList()
    LaunchedEffect(Unit) { timeline.loadMembers() }

    Column(Modifier.fillMaxSize().imePadding()) {
        // Pull down to reload the thread (new replies, reactions).
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refreshing = true; load(); refreshing = false } },
            modifier = Modifier.weight(1f).fillMaxWidth(),
        ) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().pointerInput(Unit) { detectTapGestures(onTap = { focus.clearFocus() }) },
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                val r = root
                if (r == null) {
                    item { Text(when { deleted -> "この投稿は削除されました"; failed -> "読み込めませんでした"; else -> "読み込み中…" }, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 40.dp)) }
                } else {
                    item(key = "root") {
                        ReadWhenSeen(listState, "root", active = r.unread == true) { read(r, isRoot = true) }
                        Column(Modifier.widthIn(max = 760.dp).fillMaxWidth()) {
                            PostRow(r, timeline.clubName(r.club), canReact, { react(r, it) }, { onOpenImage(r.images, it) }, showReplyCount = false, memberNames = timeline.memberNames)
                            HorizontalDivider()
                            if (replies.isEmpty()) Text("まだ返信はありません", color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.fillMaxWidth().padding(24.dp))
                        }
                    }
                    items(replies, key = { it.id }) { p ->
                        ReadWhenSeen(listState, p.id, active = p.unread == true) { read(p, isRoot = false) }
                        Column(Modifier.widthIn(max = 760.dp).fillMaxWidth().padding(start = 20.dp)) {
                            PostRow(p, null, canReact, { react(p, it) }, { onOpenImage(p.images, it) }, showReplyCount = false, memberNames = timeline.memberNames)
                            HorizontalDivider()
                        }
                    }
                }
            }
        }
        HorizontalDivider()
        if (capabilities?.canPublish == true) {
            Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
                Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    if (matches.isNotEmpty()) MentionSuggestions(matches) { draft.text = Mention.complete(draft.text, it.name) }
                    DraftImages(draft)
                    DraftMedia(draft)
                    draft.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                    TextField(
                        value = draft.value, onValueChange = { draft.value = it },
                        placeholder = { Text(composerPlaceholder("返信")) }, maxLines = 6,
                        keyboardOptions = ComposerKeyboardOptions, shape = RoundedCornerShape(20.dp),
                        colors = TextFieldDefaults.colors(focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent),
                        modifier = Modifier.fillMaxWidth().composerKeys(draft.value, { draft.value = it }, { sendReply() },
                            mentionOpen = matches.isNotEmpty(), onPickMention = { matches.firstOrNull()?.let { draft.text = Mention.complete(draft.text, it.name) } }),
                    )
                    // Attachments on the left; 「うなる」 (light blue: no lift, no notice) left of 「吠える」 (blue), like the web.
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                        TextButton(onClick = pick, enabled = draft.remaining > 0 || (canMedia && draft.canAttachMedia)) { Text("🖼️") }
                        CameraButton(onClick = camera, enabled = draft.remaining > 0)
                        if (capabilities.canPostAudio) TextButton(onClick = { pickAudio.launch("audio/*") }, enabled = draft.canAttachMedia) { Text("🎵") }
                        androidx.compose.foundation.layout.Spacer(Modifier.weight(1f))
                        if (canWhisper) {
                            androidx.compose.material3.FilledTonalButton(onClick = { sendReply(whisper = true) }, enabled = draft.canSend,
                                colors = androidx.compose.material3.ButtonDefaults.filledTonalButtonColors(containerColor = BarkBlue.copy(alpha = 0.15f), contentColor = BarkBlue),
                                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp)) {
                                Text(if (draft.sendingKind == "whisper") "…" else "うなる")
                            }
                        }
                        androidx.compose.material3.Button(onClick = { sendReply() }, enabled = draft.canSend,
                            colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = BarkBlue),
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp),
                            modifier = Modifier.semantics { contentDescription = "返信を送信（吠える）" }) {
                            Text(if (draft.sendingKind == "post") "…" else "吠える")
                        }
                    }
                }
            }
        } else {
            // No permission yet: say so right where the reply would go.
            Column(Modifier.navigationBarsPadding()) { ReconnectBanner(onReconnect) }
        }
    }
}
