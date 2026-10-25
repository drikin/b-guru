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
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.flow.collectLatest
import androidx.lifecycle.repeatOnLifecycle
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
    var needsReconnect by remember { mutableStateOf(false) }
    var viewing by remember { mutableStateOf<Pair<List<String>, Int>?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) { if (!timeline.hasLoaded) timeline.refresh() }
    androidx.compose.runtime.SideEffect { timeline.capabilities = capabilities }
    // On screen (this page, the app in front): refresh when the app comes back, and every
    // minute while it stays. Off screen (another page, background): no polling.
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    val visibleNow by androidx.compose.runtime.rememberUpdatedState(visible)
    LaunchedEffect(timeline, lifecycle) {
        lifecycle.repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.STARTED) {
            var cameBack = true
            androidx.compose.runtime.snapshotFlow { visibleNow }.collectLatest { v ->
                if (!v) return@collectLatest
                val now = cameBack
                cameBack = false
                timeline.pollWhileOnScreen(now)
            }
        }
    }
    // Kept here, outside the list: coming back from a thread returns to where you were.
    val listState = rememberLazyListState()
    LaunchedEffect(timeline.openThread) {
        timeline.openThread?.let { threadId = it; timeline.openThread = null }
    }
    BackHandler(enabled = threadId != null) { threadId = null }

    fun compose() { if (capabilities?.canPublish == true) timeline.dialog = PostDialog.Compose() else needsReconnect = true }
    var listsMenu by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { if (tabSwitch != null) tabSwitch() else Text("タイムライン") },
                navigationIcon = {
                    if (threadId != null) IconButton(onClick = { threadId = null }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "タイムラインに戻る") }
                },
                actions = {
                    if (threadId == null) {
                        // 📌 ピン留め・🔖 ブックマーク・☆ お気に入りの人 (simple lists in a sheet).
                        val lists = buildList {
                            if (capabilities?.canListPinned == true) add("pinned" to "📌 ピン留め")
                            if (capabilities?.canBookmark == true) add("bm" to "🔖 ブックマーク")
                            if (capabilities?.canFavorite == true) add("fav" to "☆ お気に入りの人の投稿")
                        }
                        if (lists.isNotEmpty()) Box {
                            IconButton(onClick = { listsMenu = true }) { Text("📌", fontSize = 18.sp, modifier = Modifier.semantics { contentDescription = "ピン留め・ブックマーク" }) }
                            DropdownMenu(listsMenu, onDismissRequest = { listsMenu = false }) {
                                lists.forEach { (f, label) ->
                                    DropdownMenuItem(text = { Text(label) }, onClick = { listsMenu = false; timeline.dialog = PostDialog.List(f) })
                                }
                            }
                        }
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
                    TimelineList(timeline, capabilities, visible, listState, onOpen = { threadId = it }, onOpenImage = { imgs, i -> viewing = imgs to i })
                }
            }
            PostToastBar(timeline, Modifier.align(Alignment.BottomCenter).navigationBarsPadding())
        }
    }

    PostDialogHost(timeline, capabilities, onOpenThread = { threadId = it })
    viewing?.let { (imgs, i) -> ImageViewer(imgs, i) { viewing = null } }
}

@Composable
private fun TimelineList(
    timeline: TimelineStore,
    capabilities: Capabilities?,
    visible: Boolean,
    listState: androidx.compose.foundation.lazy.LazyListState,
    onOpen: (Long) -> Unit,
    onOpenImage: (List<String>, Int) -> Unit,
) {
    val focus = LocalFocusManager.current
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    val posts = timeline.posts

    // Load more near the end.
    LaunchedEffect(listState) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .distinctUntilChanged()
            .collect { last -> if (last >= timeline.posts.size - 3) timeline.loadMore() }
    }

    // Reading further down: a way back to the newest, like the chat's (drikin 2026-10-19).
    val atTop by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset < 24 } }
    var newAbove by remember { mutableIntStateOf(0) }
    var prevIds by remember { mutableStateOf<List<Long>>(emptyList()) }
    LaunchedEffect(posts) {
        val old = prevIds
        prevIds = posts.map { it.id }
        val first = old.firstOrNull() ?: return@LaunchedEffect
        val i = posts.indexOfFirst { it.id == first }
        if (!atTop && i > 0) newAbove += posts.take(i).count { !it.isAuthor }
    }
    LaunchedEffect(atTop) { if (atTop) newAbove = 0 }

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
            items(posts, key = { it.id }, contentType = { if (it.images.isEmpty()) "text" else "photos" }) { post ->
                ReadWhenSeen(listState, post.id, active = visible && post.unread == true) { timeline.sawPost(post.id) }
                Column(Modifier.widthIn(max = 760.dp).fillMaxWidth()) {
                    PostRow(
                        post = post,
                        clubName = timeline.clubName(post.club),
                        canReact = capabilities?.canReactPosts ?: false,
                        onReact = { timeline.toggleReaction(post.id, it) },
                        onOpenImage = { onOpenImage(post.images, it) },
                        onClick = { focus.clearFocus(); onOpen(post.id) },
                        memberNames = timeline.memberNames,
                    )
                    HorizontalDivider()
                }
            }
            if (timeline.loadingMore) item { CircularProgressIndicator(Modifier.padding(16.dp).size(24.dp)) }
        }
        if (!atTop) {
            JumpToLatest(newAbove, Modifier.align(Alignment.BottomEnd).navigationBarsPadding().padding(10.dp), arrow = "↑") {
                scope.launch { listState.animateScrollToItem(0) }
            }
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
    /** Members' names, lower-cased: which @mentions are marked (TimelineRules). */
    memberNames: Set<String> = emptySet(),
) {
    val context = LocalContext.current
    // Every "how to show it" decision (fold, reaction order, mentions, link card) in one place.
    val plan = remember(post, memberNames, clubName) { TimelineRules.resolve(post, memberNames) { clubName } }
    var expanded by androidx.compose.runtime.saveable.rememberSaveable(post.id) { mutableStateOf(false) }
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var menu by remember { mutableStateOf(false) }
    var netaUrls by remember { mutableStateOf<List<String>?>(null) }
    // The operations (段階 3) go through the signed-in timeline; what is offered follows capabilities.
    val session = App.session(context)
    val ops = session.timeline
    val caps = session.store?.capabilities
    LaunchedEffect(ops?.demoMenu) { if (ops != null && ops.demoMenu == post.id) { menu = true; ops.demoMenu = null } }
    val pinned = PostActions.isPinned(post)
    // Unread: a light green card with the web's green bar. Read after a second on
    // screen, and the colour fades out — so you can see what you just read.
    val unread by androidx.compose.animation.core.animateFloatAsState(if (post.unread == true) 1f else 0f, androidx.compose.animation.core.tween(600), label = "unread")
    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .drawBehind {
                    if (unread > 0f) {
                        drawRect(AccentGreen.copy(alpha = 0.08f * unread))
                        drawRect(AccentGreen.copy(alpha = unread), size = androidx.compose.ui.geometry.Size(3.dp.toPx(), size.height))
                    }
                }
                .combinedClickable(onClick = { onClick?.invoke() }, onLongClick = { menu = true })
                .padding(horizontal = 14.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Avatar(post.authorAvatar, post.authorName ?: "", 36.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(post.authorName ?: "", style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    // Club label (root posts: callers pass the club's name). 「未設定」 in grey, like the web.
                    if (post.favoriteByMe == true && !post.isAuthor) Text("★", fontSize = 12.sp, color = Color(0xFFF59F00),
                        modifier = Modifier.semantics { contentDescription = "お気に入りの人" })
                    // My own root post: tap the label to change the club (「部活動を選択」), 「＋部活」 when none.
                    val changeClub = ops != null && PostActions.canChangeClub(post, caps)
                    val label = plan.clubLabel ?: if (changeClub) "＋部活" else null
                    if (label != null && post.parentId == null) {
                        val c = if (plan.clubUnset || plan.clubLabel == null) MaterialTheme.colorScheme.outline else AccentGreen
                        Text(label, fontSize = 11.sp, color = c, maxLines = 1,
                            modifier = Modifier.clip(CircleShape).background(c.copy(alpha = 0.14f), CircleShape)
                                .then(if (changeClub) Modifier.clickable { ops?.dialog = PostDialog.Club(post) } else Modifier)
                                .padding(horizontal = 6.dp, vertical = 1.dp))
                    }
                    Spacer(Modifier.weight(1f))
                    if (post.bookmarkedByMe == true) Text("🔖", fontSize = 11.sp, modifier = Modifier.semantics { contentDescription = "ブックマーク済み" })
                    if (pinned) Text("📌", fontSize = 11.sp, modifier = Modifier.semantics { contentDescription = "ピン留め中" })
                    Text(relativeTime(post.createdAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
                }
                if (post.text.isNotEmpty() && !post.isBareLink) {
                    val folded = plan.folded
                    if (folded == null) {
                        PostText(post.text, plan.mentionTokens)
                    } else {
                        // Web: over 500 characters → the first 500, 「続きを読む」; here also 「閉じる」.
                        val bg = androidx.compose.ui.graphics.lerp(MaterialTheme.colorScheme.background, AccentGreen, 0.08f * unread)
                        Box {
                            PostText(if (expanded) post.text else folded, plan.mentionTokens)
                            if (!expanded) {
                                Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(56.dp)
                                    .background(androidx.compose.ui.graphics.Brush.verticalGradient(listOf(bg.copy(alpha = 0f), bg))))
                            }
                        }
                        Text(if (expanded) "閉じる" else "続きを読む", style = MaterialTheme.typography.labelLarge, color = AccentGreen,
                            modifier = Modifier.align(Alignment.CenterHorizontally).clip(CircleShape).clickable { expanded = !expanded }
                                .padding(horizontal = 12.dp, vertical = 6.dp))
                    }
                }
                if (post.images.isNotEmpty()) PostImages(post.images, plan.imageColumns, onOpenImage)
                // Like the web: the link card under the photos too (only the server's one preview).
                plan.linkCard?.let { (card, preview) ->
                    LinkCard(preview, youtube = card.kind == "youtube")
                    // 📺 a YouTube post: watch it with the chat (drikin 2026-10-25).
                    val watch = LocalWatch.current
                    if (card.kind == "youtube" && watch != null) WatchTogetherButton(watch, preview.url, floating = true)
                }
                // An episode of the jukebox (e.g. the daily "N 年前の今日"): play it here.
                val session = if (post.audioUrl != null && post.videoUrl == null) App.session(context) else null
                val jukebox = session?.jukebox?.takeIf { session.store?.capabilities?.jukeboxEnabled == true }
                val episode = jukebox?.episodeForUrl(post.audioUrl)
                if (jukebox != null && episode != null) {
                    val nowPlaying = jukebox.current?.id == episode.id && jukebox.playing
                    Text(if (nowPlaying) "❚❚ ジュークボックスで再生中" else "▶︎ ジュークボックスで聴く",
                        style = MaterialTheme.typography.labelLarge, color = AccentGreen,
                        modifier = Modifier.clip(CircleShape).background(AccentGreen.copy(alpha = 0.12f))
                            .clickable { if (nowPlaying) jukebox.pause() else jukebox.play(episode) }
                            .padding(horizontal = 10.dp, vertical = 5.dp))
                } else {
                    post.audioUrl?.let { PostAudio(it) }
                }
                post.videoUrl?.let { PostVideo(it) }
                post.poll?.let { poll ->
                    PollCard(post, poll, canVote = ops != null && caps?.canVote == true, canEdit = ops != null && caps?.canEditPoll == true && post.isAuthor,
                        onVote = { ops?.vote(post, it) }, onEdit = { ops?.dialog = PostDialog.PollEdit(post) },
                        onVoters = ops?.let { o -> { o.dialog = PostDialog.PollVoters(post) } })
                }
                val rs = plan.reactions
                if (rs.isNotEmpty() || (showReplyCount && post.replyCount > 0)) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        rs.forEach { r -> PostReactionChip(r, plan.reactorsMore[r.emoji], enabled = canReact) { onReact(r.emoji) } }
                        if (showReplyCount && post.replyCount > 0) {
                            Text("💬 ${post.replyCount}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(top = 2.dp))
                            val new = post.unreadReplies ?: 0
                            if (new > 0) {
                                Text("新着 $new", fontSize = 11.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold, color = Color.White,
                                    modifier = Modifier.padding(top = 2.dp).background(AccentGreen, CircleShape).padding(horizontal = 6.dp, vertical = 1.dp)
                                        .semantics { contentDescription = "新しい返信 $new 件" })
                            }
                        }
                    }
                }
            }
        }
        // At most the window less Material's 48 dp margins: on a phone on its side the menu then scrolls
        // instead of being pushed up under the status bar.
        val maxMenu = (androidx.compose.ui.platform.LocalConfiguration.current.screenHeightDp - 112).coerceAtLeast(160).dp
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, modifier = Modifier.heightIn(max = maxMenu)) {
            if (canReact) {
                // The quick row (the web's first six 「よく使う」) and ＋ for the whole picker.
                Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    EmojiSets.QUICK.take(6).forEach { e -> Text(e, fontSize = 22.sp, modifier = Modifier.clickable { menu = false; onReact(e) }.padding(6.dp)) }
                    if (ops != null) Text("＋", fontSize = 20.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.clickable { menu = false; ops.dialog = PostDialog.Picker(post) }.padding(6.dp)
                            .semantics { contentDescription = "ほかのリアクション" })
                }
                HorizontalDivider()
            }
            val urls = remember(post.text, post.urlPreview?.url) { netaCandidates(post.text, post.urlPreview?.url) }
            // The web card's top-right buttons, in the same order (docs/timeline-spec.md §4.2, §10.2).
            PostActions.menu(post, caps, chatCanSend = caps?.canSend == true, hasNetaUrls = urls.isNotEmpty()).forEach { item ->
                if (ops == null && item in OPS_ITEMS) return@forEach
                if (item == PostActions.Item.COPY) HorizontalDivider()
                val red = item == PostActions.Item.DELETE
                val note = PostActions.isNote(item)
                DropdownMenuItem(
                    text = {
                        Text(PostActions.label(item, post, pinned),
                            color = when { red -> MaterialTheme.colorScheme.error; note -> MaterialTheme.colorScheme.onSurfaceVariant; else -> Color.Unspecified },
                            style = if (note) MaterialTheme.typography.bodySmall else MaterialTheme.typography.bodyLarge)
                    },
                    enabled = !note,
                    onClick = {
                        menu = false
                        when (item) {
                            PostActions.Item.BOOKMARK -> ops?.toggleBookmark(post)
                            // 「チャットに引用」: the post's link into the chat composer (MainScreen shows the chat).
                            PostActions.Item.QUOTE -> ChatQuote.pending = ChatQuote.forPost(post)
                            // 「ネタ帳に送る」: only posts that link an article (docs/neta-client-spec.md).
                            PostActions.Item.NETA -> netaUrls = urls
                            PostActions.Item.FAVORITE -> ops?.toggleFavorite(post)
                            PostActions.Item.REACT -> ops?.dialog = PostDialog.Picker(post)
                            PostActions.Item.PIN -> ops?.togglePin(post)
                            PostActions.Item.CLUB -> ops?.dialog = PostDialog.Club(post)
                            PostActions.Item.EDIT_RELOGIN -> {}
                            PostActions.Item.EDIT -> ops?.dialog = PostDialog.Edit(post)
                            PostActions.Item.DELETE -> ops?.dialog = PostDialog.Delete(post)
                            PostActions.Item.COPY -> scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("post", post.text))) }
                            PostActions.Item.WEB -> context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(ChatQuote.permalink(post))))
                        }
                    },
                )
            }
        }
        netaUrls?.let { urls -> NetaDialog(post, urls, onDismiss = { netaUrls = null }) }
    }
}

/** The menu items that need the timeline store (always there when signed in or in the demo). */
private val OPS_ITEMS = setOf(PostActions.Item.BOOKMARK, PostActions.Item.FAVORITE, PostActions.Item.REACT, PostActions.Item.PIN, PostActions.Item.CLUB, PostActions.Item.EDIT, PostActions.Item.DELETE)

/** Full screen, swipe between images, pinch to zoom. */
@Composable
fun ImageViewer(images: List<String>, start: Int, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            val pager = rememberPagerState(initialPage = start) { images.size }
            HorizontalPager(pager, Modifier.fillMaxSize()) { page ->
                var scale by remember { mutableStateOf(1f) }
                val state = rememberTransformableState { zoom, _, _ -> scale = (scale * zoom).coerceIn(1f, 5f) }
                RemoteImage(images[page], maxPx = 2048, modifier = Modifier.fillMaxSize().transformable(state).graphicsLayer(scaleX = scale, scaleY = scale)
                    .pointerInput(Unit) { detectTapGestures(onDoubleTap = { scale = if (scale > 1f) 1f else 2.5f }) },
                    contentScale = ContentScale.Fit) { CircularProgressIndicator(Modifier.align(Alignment.Center)) }
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

/** Calls `onRead` once at least a quarter of the row `key` has stayed on screen for a
 *  second while `active` (same rule as the web). Scrolling past quickly does not read it. */
@Composable
fun ReadWhenSeen(listState: androidx.compose.foundation.lazy.LazyListState, key: Any, active: Boolean, onRead: () -> Unit) {
    val read by androidx.compose.runtime.rememberUpdatedState(onRead)
    LaunchedEffect(key, active) {
        if (!active) return@LaunchedEffect
        snapshotFlow { listState.isShown(key) }
            .distinctUntilChanged()
            .collectLatest { shown -> if (shown) { kotlinx.coroutines.delay(1000); read() } }
    }
}

private fun androidx.compose.foundation.lazy.LazyListState.isShown(key: Any): Boolean {
    val info = layoutInfo
    val item = info.visibleItemsInfo.firstOrNull { it.key == key } ?: return false
    if (item.size <= 0) return false
    val start = maxOf(item.offset, info.viewportStartOffset)
    val end = minOf(item.offset + item.size, info.viewportEndOffset)
    return end - start >= item.size / 4
}

/** A link's page as a card: image, title, a line of description, the site. Opens the
 *  page in the browser (the web shows the same card under a post). */
@Composable
fun LinkCard(preview: UrlPreview, youtube: Boolean = preview.videoId != null) {
    val context = LocalContext.current
    val shape = RoundedCornerShape(12.dp)
    Column(
        Modifier
            .then(if (youtube) Modifier.widthIn(max = 480.dp) else Modifier)
            .fillMaxWidth()
            .clip(shape)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.04f))
            .clickable { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(preview.url))) } }
            .semantics { contentDescription = "リンク：" + (preview.title ?: preview.url) },
    ) {
        preview.proxiedImage?.let { img ->
            // YouTube: the thumbnail at 16:9 (the web: at most 480 wide) with ▶ (52). Others: the
            // picture never cut, its height from its shape, at most 240 (fitted inside beyond that).
            val abs = ApiClient.absolute(img)
            var ratio by remember(abs) { mutableStateOf(ImageCache.ratio(abs)) }
            Box(contentAlignment = Alignment.Center) {
                if (youtube) {
                    val m = Modifier.fillMaxWidth().aspectRatio(16f / 9f)
                    RemoteImage(img, m, maxPx = 900) { Box(m.background(MaterialTheme.colorScheme.surfaceVariant)) }
                } else {
                    androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth()) {
                        val h = minOf(maxWidth.value / (ratio ?: (1.91f)), 240f)
                        Box(Modifier.fillMaxWidth().height(h.dp).background(MaterialTheme.colorScheme.surfaceVariant)) {
                            PostPhoto(img, Modifier.fillMaxSize(), maxPx = 900) { ratio = it }
                        }
                    }
                }
                if (youtube) {
                    Box(Modifier.size(52.dp).background(Color.Black.copy(alpha = 0.7f), CircleShape), contentAlignment = Alignment.Center) {
                        Text("▶", color = Color.White, fontSize = 20.sp)
                    }
                }
            }
        }
        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            preview.title?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            preview.description?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Text(preview.siteName ?: (Uri.parse(preview.url).host ?: preview.url), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.outline, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

private val CUSTOM_EMOJI = Regex("^:([\\w+-]+):$")

/** A reaction under a post: tap toggles yours; long-press shows who reacted (the web's hover
 *  list: up to 12 names, then 「他N人」 — TimelineRules.reactors). */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun PostReactionChip(r: Reaction, more: Int?, enabled: Boolean, onTap: () -> Unit) {
    var who by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(12.dp)
    Box {
        Row(
            Modifier
                .clip(shape)
                .border(1.dp, if (r.mine) AccentGreen else MaterialTheme.colorScheme.outlineVariant, shape)
                .background(if (r.mine) AccentGreen.copy(alpha = 0.10f) else Color.Transparent, shape)
                .combinedClickable(onClick = { if (enabled) onTap() }, onLongClick = { who = true }, onLongClickLabel = "リアクションした人")
                .padding(horizontal = 8.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            ReactionGlyph(r.emoji, 16.dp)
            Text("${r.count}", style = MaterialTheme.typography.labelSmall)
        }
        DropdownMenu(expanded = who, onDismissRequest = { who = false }) {
            val list = TimelineRules.reactors(r, more?.takeIf { r.count == r.reactors.size + it })
            Column(Modifier.widthIn(max = 260.dp).padding(horizontal = 12.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ReactionGlyph(r.emoji, 18.dp)
                    Text("${r.count}人", style = MaterialTheme.typography.labelLarge, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold)
                }
                if (list.names.isNotEmpty()) {
                    Text(androidx.compose.ui.text.buildAnnotatedString {
                        append(list.names.joinToString("、"))
                        if (list.others > 0) {
                            withStyle(androidx.compose.ui.text.SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant)) { append(" 他${list.others}人") }
                        }
                    }, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

@Composable
private fun ReactionGlyph(emoji: String, size: androidx.compose.ui.unit.Dp) {
    val custom = CUSTOM_EMOJI.find(emoji)?.groupValues?.get(1)?.let { EmojiCatalog.urls[it] }
    if (custom != null) RemoteImage(custom, Modifier.size(size), ContentScale.Fit, maxPx = 64) { Text(emoji, fontSize = 12.sp) }
    else Text(emoji, fontSize = (size.value * 0.875f).sp)
}
