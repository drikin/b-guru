package fm.backspace.bguru.chat

import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Create
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** The timeline: root posts by latest activity, unread marked with the web's
 *  green bar, reactions, tap → thread, ✎ → new post with photos. Same behaviour
 *  as native/shared/TimelineScreen.swift on iPhone / iPad / Mac. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TimelineScreen(
    timeline: TimelineStore,
    capabilities: Capabilities?,
    tabSwitch: (@Composable () -> Unit)?,
    onReconnect: () -> Unit,
    /** False while this page is off screen (phone pager): nothing is marked read then. */
    visible: Boolean = true,
) {
    var threadId by remember { mutableStateOf<Long?>(null) }
    var composing by remember { mutableStateOf(false) }
    var needsReconnect by remember { mutableStateOf(false) }
    var viewing by remember { mutableStateOf<Pair<List<String>, Int>?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) { if (!timeline.hasLoaded) timeline.refresh() }
    // On screen: refresh when the app comes back, and every minute while it stays.
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    androidx.compose.runtime.DisposableEffect(lifecycle) {
        val obs = androidx.lifecycle.LifecycleEventObserver { _, e ->
            when (e) {
                androidx.lifecycle.Lifecycle.Event.ON_START -> { if (timeline.hasLoaded) timeline.refreshAsync(); timeline.startPolling() }
                androidx.lifecycle.Lifecycle.Event.ON_STOP -> timeline.stopPolling()
                else -> Unit
            }
        }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs); timeline.stopPolling() }
    }
    LaunchedEffect(timeline.openThread) {
        timeline.openThread?.let { threadId = it; timeline.openThread = null }
    }
    BackHandler(enabled = threadId != null) { threadId = null }

    fun compose() { if (capabilities?.canPublish == true) composing = true else needsReconnect = true }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { if (tabSwitch != null) tabSwitch() else Text("タイムライン") },
                navigationIcon = {
                    if (threadId != null) IconButton(onClick = { threadId = null }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "タイムラインに戻る") }
                },
                actions = {
                    if (threadId == null) {
                        IconButton(onClick = ::compose) { Icon(Icons.Default.Create, "投稿する") }
                    }
                },
            )
        },
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0),
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            val id = threadId
            if (id != null) {
                ThreadScreen(id, timeline, capabilities, onReconnect, onOpenImage = { imgs, i -> viewing = imgs to i })
            } else {
                Column(Modifier.fillMaxSize()) {
                    if (needsReconnect) ReconnectBanner(onReconnect, onClose = { needsReconnect = false })
                    TimelineList(timeline, capabilities, visible, onOpen = { threadId = it }, onOpenImage = { imgs, i -> viewing = imgs to i })
                }
            }
        }
    }

    if (composing) {
        ComposeDialog(timeline.api, parentId = null, maxImages = capabilities?.maxImages ?: 5,
            onDismiss = { composing = false },
            onPosted = { timeline.didPublish(it); composing = false })
    }
    viewing?.let { (imgs, i) -> ImageViewer(imgs, i) { viewing = null } }
}

@Composable
private fun TimelineList(
    timeline: TimelineStore,
    capabilities: Capabilities?,
    visible: Boolean,
    onOpen: (Long) -> Unit,
    onOpenImage: (List<String>, Int) -> Unit,
) {
    val focus = LocalFocusManager.current
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    val posts = timeline.posts

    // Load more near the end.
    LaunchedEffect(listState) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .distinctUntilChanged()
            .collect { last -> if (last >= timeline.posts.size - 3) timeline.loadMore() }
    }

    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = { scope.launch { refreshing = true; timeline.refresh(); refreshing = false } },
        modifier = Modifier.fillMaxSize(),
    ) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().pointerInput(Unit) { detectTapGestures(onTap = { focus.clearFocus() }) },
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (posts.isEmpty()) {
                item {
                    Text(
                        when {
                            !timeline.hasLoaded -> "読み込み中…"
                            timeline.failed -> "読み込めませんでした。引っ張って再読み込み"
                            else -> "まだ投稿がありません"
                        },
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 40.dp),
                    )
                }
            }
            items(posts, key = { it.id }) { post ->
                LaunchedEffect(post.id, visible) { if (visible) timeline.sawPost(post.id) }
                Column(Modifier.widthIn(max = 760.dp).fillMaxWidth()) {
                    PostRow(
                        post = post,
                        clubName = timeline.clubName(post.club),
                        canReact = capabilities?.canReactPosts ?: false,
                        onReact = { timeline.toggleReaction(post.id, it) },
                        onOpenImage = { onOpenImage(post.images, it) },
                        onClick = { focus.clearFocus(); onOpen(post.id) },
                    )
                    HorizontalDivider()
                }
            }
            if (timeline.loadingMore) item { CircularProgressIndicator(Modifier.padding(16.dp).size(24.dp)) }
        }
    }
}

/** One post (timeline row, thread root and replies). */
@OptIn(ExperimentalFoundationApi::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun PostRow(
    post: Post,
    clubName: String?,
    canReact: Boolean,
    onReact: (String) -> Unit,
    onOpenImage: (Int) -> Unit,
    onClick: (() -> Unit)? = null,
    showReplyCount: Boolean = true,
) {
    val context = LocalContext.current
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier
                .fillMaxWidth()
                // Unread: the same green bar as the web timeline.
                .drawBehind { if (post.unread == true) drawRect(AccentGreen, size = androidx.compose.ui.geometry.Size(3.dp.toPx(), size.height)) }
                .combinedClickable(onClick = { onClick?.invoke() }, onLongClick = { menu = true })
                .padding(horizontal = 14.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Avatar(post.authorAvatar, post.authorName ?: "", 36.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(post.authorName ?: "", style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    if (clubName != null) {
                        Text(clubName, fontSize = 11.sp, color = AccentGreen,
                            modifier = Modifier.background(AccentGreen.copy(alpha = 0.14f), CircleShape).padding(horizontal = 6.dp, vertical = 1.dp))
                    }
                    Spacer(Modifier.weight(1f))
                    Text(relativeTime(post.createdAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                }
                if (post.text.isNotEmpty()) Text(linkified(post.text), fontSize = 16.sp)
                if (post.images.isNotEmpty()) PostImages(post.images, onOpenImage)
                if (post.videoUrl != null || post.audioUrl != null) {
                    Text(if (post.videoUrl != null) "▶︎ 動画（Web で再生）" else "♪ 音声（Web で再生）",
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                val rs = post.reactions.orEmpty()
                if (rs.isNotEmpty() || (showReplyCount && post.replyCount > 0)) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        rs.forEach { r -> ReactionChip(r, enabled = canReact) { onReact(r.emoji) } }
                        if (showReplyCount && post.replyCount > 0) {
                            Text("💬 ${post.replyCount}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(top = 2.dp))
                        }
                    }
                }
            }
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            if (canReact) {
                Row(Modifier.padding(horizontal = 8.dp)) {
                    QUICK.forEach { e -> Text(e, fontSize = 22.sp, modifier = Modifier.clickable { menu = false; onReact(e) }.padding(6.dp)) }
                }
                HorizontalDivider()
            }
            DropdownMenuItem(text = { Text("テキストをコピー") }, onClick = {
                menu = false
                scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("post", post.text))) }
            })
            DropdownMenuItem(text = { Text("Web で開く") }, onClick = {
                menu = false
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${Net.BASE}/#/post/${post.parentId ?: post.id}")))
            })
        }
    }
}

/** 1 image: wide; 2–5: a grid of squares. Tap → full screen. */
@Composable
fun PostImages(images: List<String>, onOpen: (Int) -> Unit) {
    if (images.size == 1) {
        RemoteImage(images[0], Modifier.fillMaxWidth().height(220.dp).clip(RoundedCornerShape(10.dp)).clickable { onOpen(0) }) {
            Box(Modifier.fillMaxWidth().height(220.dp).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceVariant))
        }
        return
    }
    val cols = if (images.size == 2 || images.size == 4) 2 else 3
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        images.withIndex().chunked(cols).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                row.forEach { (i, path) ->
                    val m = Modifier.weight(1f).aspectRatio(1f).clip(RoundedCornerShape(8.dp))
                    RemoteImage(path, m.clickable { onOpen(i) }) { Box(m.background(MaterialTheme.colorScheme.surfaceVariant)) }
                }
                repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

/** Full screen, swipe between images, pinch to zoom. */
@Composable
fun ImageViewer(images: List<String>, start: Int, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            val pager = rememberPagerState(initialPage = start) { images.size }
            HorizontalPager(pager, Modifier.fillMaxSize()) { page ->
                var scale by remember { mutableStateOf(1f) }
                val state = rememberTransformableState { zoom, _, _ -> scale = (scale * zoom).coerceIn(1f, 5f) }
                RemoteImage(images[page], Modifier.fillMaxSize().transformable(state).graphicsLayer(scaleX = scale, scaleY = scale)
                    .pointerInput(Unit) { detectTapGestures(onDoubleTap = { scale = if (scale > 1f) 1f else 2.5f }) },
                    ContentScale.Fit) { CircularProgressIndicator(Modifier.align(Alignment.Center)) }
            }
            IconButton(onClick = onClose, modifier = Modifier.align(Alignment.TopEnd).padding(16.dp)) {
                Icon(Icons.Default.Close, "閉じる", tint = Color.White)
            }
            if (images.size > 1) {
                Text("${pager.currentPage + 1} / ${images.size}", color = Color.White.copy(alpha = 0.8f),
                    modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(16.dp))
            }
        }
    }
}

/** Posting needs the "post" permission, which tokens from before the timeline lack. */
@Composable
fun ReconnectBanner(onReconnect: () -> Unit, onClose: (() -> Unit)? = null) {
    Surface(color = AccentGreen.copy(alpha = 0.10f), shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
        Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("🔑")
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("投稿・返信・リアクションには再接続が必要です", style = MaterialTheme.typography.titleSmall)
                Text("タイムラインに書き込む許可を追加するため、もう一度 B-guru にログインしてアプリを接続してください。",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Button(onClick = onReconnect, colors = ButtonDefaults.buttonColors(containerColor = AccentGreen)) { Text("再接続する") }
            }
            if (onClose != null) IconButton(onClick = onClose) { Icon(Icons.Default.Close, "閉じる") }
        }
    }
}

/** Thumbnails of the attached photos with ✕. */
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
        itemsIndexed(draft.images) { i, bmp ->
            Box {
                Image(bmp.asImageBitmap(), null, Modifier.size(64.dp).clip(RoundedCornerShape(8.dp)), contentScale = ContentScale.Crop)
                Box(Modifier.align(Alignment.TopEnd).size(22.dp).background(Color.Black.copy(alpha = 0.55f), CircleShape).clickable { draft.remove(i) },
                    contentAlignment = Alignment.Center) { Icon(Icons.Default.Close, "画像 ${i + 1} を外す", tint = Color.White, modifier = Modifier.size(14.dp)) }
            }
        }
    }
}

/** The Android Photo Picker (no storage permission needed), up to the draft's remaining slots. */
@Composable
fun rememberPhotoPicker(draft: PostDraft): () -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(5)) { uris ->
        if (BuildConfig.DEBUG) android.util.Log.d("BguruDraft", "picked ${uris.size}")
        if (uris.isNotEmpty()) scope.launch { draft.add(context, uris) }
    }
    return { launcher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
}

/** New post: text + photos. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComposeDialog(api: ApiClient, parentId: Long?, maxImages: Int, onDismiss: () -> Unit, onPosted: (Post) -> Unit) {
    val draft = remember { PostDraft(maxImages) }
    val scope = rememberCoroutineScope()
    val pick = rememberPhotoPicker(draft)
    Dialog(onDismissRequest = { if (!draft.sending && draft.text.isEmpty() && draft.images.isEmpty()) onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().imePadding()) {
                TopAppBar(
                    title = { Text(if (parentId == null) "新しい投稿" else "返信") },
                    navigationIcon = { TextButton(onClick = onDismiss, enabled = !draft.sending) { Text("キャンセル") } },
                    actions = {
                        TextButton(enabled = draft.canSend, onClick = {
                            scope.launch { draft.send(api, parentId)?.let(onPosted) }
                        }) { Text(if (draft.sending) "送信中…" else "投稿") }
                    },
                )
                Column(Modifier.padding(16.dp).weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextField(
                        value = draft.value, onValueChange = { draft.value = it },
                        placeholder = { Text("いまどうしてる？") },
                        modifier = Modifier.fillMaxWidth().weight(1f, fill = false)
                            .enterSends(draft) { if (draft.canSend) scope.launch { draft.send(api, parentId)?.let(onPosted) } },
                        minLines = 5,
                        colors = TextFieldDefaults.colors(focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent),
                    )
                    DraftImages(draft)
                    draft.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onClick = pick, enabled = draft.remaining > 0) { Text("📷 写真") }
                        Text("${draft.images.size}/${draft.maxImages}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

private val MD = DateTimeFormatter.ofPattern("M/d").withZone(ZoneId.systemDefault())

/** 「たった今」「5分前」「3時間前」、それより前は日付。 */
fun relativeTime(iso: String, now: Instant = Instant.now()): String {
    val t = runCatching { Instant.parse(iso) }.getOrNull() ?: return ""
    val sec = Duration.between(t, now).seconds
    return when {
        sec < 60 -> "たった今"
        sec < 3600 -> "${sec / 60}分前"
        sec < 86400 -> "${sec / 3600}時間前"
        else -> MD.format(t)
    }
}

/** The timeline's text boxes use the chat's keys: a hardware keyboard's Enter sends,
 *  ⇧Enter is a newline, and while a Japanese conversion is open Enter only confirms
 *  it. The on-screen keyboard's return key inserts a newline. */
fun Modifier.enterSends(draft: PostDraft, onSend: () -> Unit): Modifier = onPreviewKeyEvent { e ->
    if (e.type != androidx.compose.ui.input.key.KeyEventType.KeyDown) return@onPreviewKeyEvent false
    if (draft.value.composition != null) return@onPreviewKeyEvent false
    if ((e.key == androidx.compose.ui.input.key.Key.Enter || e.key == androidx.compose.ui.input.key.Key.NumPadEnter) && !e.isShiftPressed) {
        onSend(); true
    } else false
}
