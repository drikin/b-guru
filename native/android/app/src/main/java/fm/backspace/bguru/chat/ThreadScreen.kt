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
    val draft = remember(id) { PostDraft(capabilities?.maxImages ?: 5) }
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val listState = rememberLazyListState()
    val pick = rememberPhotoPicker(draft)
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

    fun react(postId: Long, emoji: String) {
        val inTimeline = timeline.posts.any { it.id == postId }
        timeline.toggleReaction(postId, emoji, inTimeline)
        if (root?.id == postId) root = root?.let { it.copy(reactions = ChatStore.toggled(it.reactions.orEmpty(), emoji)) }
        replies = replies.map { if (it.id == postId) it.copy(reactions = ChatStore.toggled(it.reactions.orEmpty(), emoji)) else it }
        // Replies are not in the timeline list, so the store does not send for them.
        if (!inTimeline && !timeline.demo) scope.launch { runCatching { timeline.api.togglePostReaction(postId, emoji) } }
    }

    fun sendReply() {
        if (!draft.canSend) return
        scope.launch {
            draft.send(timeline.api, id)?.let { post ->
                replies = replies + post
                timeline.didPublish(post)
                listState.animateScrollToItem(replies.size)
            }
        }
    }

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
                    item { Text(if (failed) "読み込めませんでした" else "読み込み中…", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 40.dp)) }
                } else {
                    item(key = "root") {
                        ReadWhenSeen(listState, "root", active = r.unread == true) { read(r, isRoot = true) }
                        Column(Modifier.widthIn(max = 760.dp).fillMaxWidth()) {
                            PostRow(r, timeline.clubName(r.club), canReact, { react(r.id, it) }, { onOpenImage(r.images, it) }, showReplyCount = false)
                            HorizontalDivider()
                            if (replies.isEmpty()) Text("まだ返信はありません", color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.fillMaxWidth().padding(24.dp))
                        }
                    }
                    items(replies, key = { it.id }) { p ->
                        ReadWhenSeen(listState, p.id, active = p.unread == true) { read(p, isRoot = false) }
                        Column(Modifier.widthIn(max = 760.dp).fillMaxWidth().padding(start = 20.dp)) {
                            PostRow(p, null, canReact, { react(p.id, it) }, { onOpenImage(p.images, it) }, showReplyCount = false)
                            HorizontalDivider()
                        }
                    }
                }
            }
        }
        HorizontalDivider()
        if (capabilities?.canPublish == true) {
            Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
                Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp)) {
                    DraftImages(draft)
                    draft.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        TextButton(onClick = pick, enabled = draft.remaining > 0) { Text("📷") }
                        TextField(
                            value = draft.value, onValueChange = { draft.value = it },
                            placeholder = { Text("返信") }, maxLines = 6, shape = RoundedCornerShape(20.dp),
                            colors = TextFieldDefaults.colors(focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent),
                            modifier = Modifier.weight(1f).enterSends(draft, ::sendReply),
                        )
                        IconButton(enabled = draft.canSend, onClick = ::sendReply) {
                            Icon(Icons.AutoMirrored.Filled.Send, "返信を送信", tint = if (draft.canSend) AccentGreen else MaterialTheme.colorScheme.outline)
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
