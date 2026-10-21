package fm.backspace.bguru.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/** Phone: timeline and chat (and the jukebox, when the server turns it on) as pages —
 *  swipe left/right or use the switch at the top (like the iPhone app). Tablet / wide
 *  window: the timeline beside the chat (or the jukebox). The jukebox's mini player
 *  is not shown under the timeline and the chat (drikin 2026-10-20). */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun MainScreen(store: ChatStore, timeline: TimelineStore, jukebox: JukeboxStore?, onSignOut: () -> Unit) {
    val wide = LocalConfiguration.current.screenWidthDp >= 840
    val jb = jukebox?.takeIf { store.capabilities?.jukeboxEnabled == true }

    @Composable
    fun Segments(labels: List<String>, selected: Int, onSelect: (Int) -> Unit) {
        // Marks, not words now: segments sized to them, two or three (drikin 2026-10-20).
        if (labels.size >= 2) { CompactSegments(labels, selected, onSelect); return }
        SingleChoiceSegmentedButtonRow(Modifier.width(250.dp)) {
            labels.forEachIndexed { i, label ->
                SegmentedButton(selected = selected == i, onClick = { onSelect(i) },
                    shape = SegmentedButtonDefaults.itemShape(i, labels.size), icon = {}) {
                    Text(label, maxLines = 1, softWrap = false, style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }

    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) {
            if (wide) {
                var right by remember { mutableStateOf(0) } // 0 = chat, 1 = jukebox
                LaunchedEffect(jb?.showTab) { if (jb?.showTab == true) { right = 1; jb.showTab = false; jb.revealTick++ } }
                // 「チャットに引用」: show the chat (it takes the quote into its draft).
                LaunchedEffect(ChatQuote.pending) { if (ChatQuote.pending != null) right = 0 }
                // ☗ 将棋 from a notification / the chat card: show the chat (the shogi panel is above it).
                LaunchedEffect(store.shogi.revealTick) { if (store.shogi.revealTick > 0) right = 0 }
                Row(Modifier.fillMaxSize()) {
                    Row(Modifier.width(420.dp).fillMaxHeight()) {
                        TimelineScreen(timeline, store.capabilities, tabSwitch = null, onReconnect = onSignOut)
                    }
                    VerticalDivider()
                    val switch: (@Composable () -> Unit)? = if (jb == null) null else {
                        { Segments(listOf(if (store.unreadCount > 0) "💬•" else "💬", "📻"), right) { right = it } }
                    }
                    if (jb != null && right == 1) JukeboxScreen(jb, store.capabilities, switch, onOpenThread = { timeline.openThread = it })
                    else PostLinksInApp(timeline) { ChatScreen(store, onSignOut = onSignOut, tabSwitch = switch) }
                }
            } else {
                Pages(store, timeline, jb, onSignOut) { labels, selected, onSelect -> Segments(labels, selected, onSelect) }
            }
        }
        // No mini player under the timeline and the chat (drikin 2026-10-20): the jukebox
        // tab and the playback notification play and pause.
    }
}

@Composable
private fun Pages(
    store: ChatStore,
    timeline: TimelineStore,
    jb: JukeboxStore?,
    onSignOut: () -> Unit,
    segments: @Composable (List<String>, Int, (Int) -> Unit) -> Unit,
) {
    val count = if (jb != null) 3 else 2
    val pager = rememberPagerState(initialPage = 1) { count } // 0 = timeline, 1 = chat, 2 = jukebox
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    // Switching pages hides the keyboard.
    LaunchedEffect(pager.currentPage) { focus.clearFocus() }
    // A "reply to your post" notification: show the timeline (it opens the thread).
    // (Launched in `scope`: the timeline clears openThread at once, which would cancel a
    // scroll running inside this effect.)
    LaunchedEffect(timeline.openThread) { if (timeline.openThread != null) scope.launch { pager.animateScrollToPage(0) } }
    // 「チャットに引用」 from a post's menu: show the chat (it takes the quote, then clears it).
    LaunchedEffect(ChatQuote.pending) { if (ChatQuote.pending != null) scope.launch { pager.animateScrollToPage(1) } }
    // ☗ 将棋 from a notification: show the chat (the shogi panel opens above it).
    LaunchedEffect(store.shogi.revealTick) { if (store.shogi.revealTick > 0) scope.launch { pager.animateScrollToPage(1) } }
    // The playback notification / the mini player: show the jukebox.
    LaunchedEffect(jb?.showTab, count) { if (jb?.showTab == true && count == 3) { pager.animateScrollToPage(2); jb.showTab = false; jb.revealTick++ } }

    // 📰 タイムライン ・ 💬 チャット ・ 📻 プレイヤー — the same order and marks in every app (drikin 2026-10-20).
    val chatLabel = if (store.unreadCount > 0) "💬•" else "💬"
    val labels = if (jb != null) listOf("📰", chatLabel, "📻") else listOf("📰", chatLabel)
    val switch: @Composable () -> Unit = {
        segments(labels, pager.currentPage) { i -> scope.launch { pager.animateScrollToPage(i) } }
    }
    // The neighbours stay composed from the start: deferring them saved ~30 ms of the first
    // frame but added one 150–220 ms frame right after launch (measured 2026-10-20).
    HorizontalPager(pager, Modifier.fillMaxSize(), beyondViewportPageCount = 1) { page ->
        when (page) {
            0 -> TimelineScreen(timeline, store.capabilities, tabSwitch = switch, onReconnect = onSignOut, visible = pager.currentPage == 0)
            1 -> PostLinksInApp(timeline) { ChatScreen(store, onSignOut = onSignOut, tabSwitch = switch, visible = pager.currentPage == 1) }
            else -> if (jb != null) JukeboxScreen(jb, store.capabilities, switch, visible = { pager.currentPage == 2 },
                onOpenThread = { timeline.openThread = it })
        }
    }
}

/** A tapped link to a B-guru post (`https://bsm.backspace.fm/#/post/<id>`) opens that
 *  thread in the app (the timeline shows it); every other link goes to the browser. */
@Composable
private fun PostLinksInApp(timeline: TimelineStore, content: @Composable () -> Unit) {
    val default = LocalUriHandler.current
    val handler = remember(default, timeline) {
        object : UriHandler {
            override fun openUri(uri: String) {
                val id = postIdFromUrl(uri)
                if (id != null) timeline.openThread = id else default.openUri(uri)
            }
        }
    }
    CompositionLocalProvider(LocalUriHandler provides handler, content = content)
}

/** Three tabs in the top bar: segments sized to their words (equal widths would cut
 *  「ジュークボックス」 on a phone), drawn like the two-tab SegmentedButton row. */
@Composable
private fun CompactSegments(labels: List<String>, selected: Int, onSelect: (Int) -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val shape = androidx.compose.foundation.shape.RoundedCornerShape(50)
    Row(
        Modifier.height(40.dp).clip(shape).border(1.dp, scheme.outline, shape),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
    ) {
        labels.forEachIndexed { i, label ->
            if (i > 0) Box(Modifier.width(1.dp).fillMaxHeight().background(scheme.outline))
            Box(
                Modifier.fillMaxHeight()
                    .background(if (i == selected) scheme.secondaryContainer else androidx.compose.ui.graphics.Color.Transparent)
                    .selectable(selected = i == selected, role = androidx.compose.ui.semantics.Role.Tab) { onSelect(i) }
                    .padding(horizontal = 9.dp),
                contentAlignment = androidx.compose.ui.Alignment.Center,
            ) {
                Text(label, maxLines = 1, softWrap = false, style = MaterialTheme.typography.labelMedium,
                    color = if (i == selected) scheme.onSecondaryContainer else scheme.onSurface)
            }
        }
    }
}
