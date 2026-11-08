package fm.backspace.bguru.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.sp
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
import androidx.compose.runtime.derivedStateOf
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
import kotlin.math.abs

/** The tabs in order: 📰 💬 ✉️ 📻 (✉️ right after 💬 — 「アプリ版の DM を素直にチャットの右のタブに移動」
 *  drikin 2026-11-08; ✉️ only with DM on, 📻 only with the jukebox on). Unit-tested: MainTabsTest. */
enum class MainTab { TIMELINE, CHAT, DM, JUKEBOX }

object MainTabs {
    /** Phone pages, in order. */
    fun pages(dm: Boolean, jukebox: Boolean): List<MainTab> =
        listOfNotNull(MainTab.TIMELINE, MainTab.CHAT, MainTab.DM.takeIf { dm }, MainTab.JUKEBOX.takeIf { jukebox })

    /** Wide screen: the right side's switch (the timeline is always on the left). */
    fun right(dm: Boolean, jukebox: Boolean): List<MainTab> = pages(dm, jukebox).drop(1)

    /** The page of [tab], or -1 when that tab is not there. */
    fun pageOf(tab: MainTab, dm: Boolean, jukebox: Boolean): Int = pages(dm, jukebox).indexOf(tab)
}

/** Phone: timeline and chat (and the jukebox, when the server turns it on) as pages —
 *  swipe left/right or use the switch at the top (like the iPhone app). Tablet / wide
 *  window: the timeline beside the chat (or the jukebox). The jukebox's mini player
 *  is not shown under the timeline and the chat (drikin 2026-10-20). */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun MainScreen(store: ChatStore, timeline: TimelineStore, jukebox: JukeboxStore?, onSignOut: () -> Unit) {
    val wide = LocalConfiguration.current.screenWidthDp >= 840
    val jb = jukebox?.takeIf { store.capabilities?.jukeboxEnabled == true }

    // ✉️ DM is a tab right after 💬 (drikin 2026-11-08): the list and the conversations live on that page.
    val dm = store.dm.takeIf { it.enabled }

    @Composable
    fun Segments(labels: List<String>, selected: Int, onSelect: (Int) -> Unit, badges: Map<Int, Int> = emptyMap()) {
        // Marks, not words now: segments sized to them, two or three (drikin 2026-10-20).
        if (labels.size >= 2) { CompactSegments(labels, selected, onSelect, badges); return }
        SingleChoiceSegmentedButtonRow(Modifier.width(250.dp)) {
            labels.forEachIndexed { i, label ->
                SegmentedButton(selected = selected == i, onClick = { onSelect(i) },
                    shape = SegmentedButtonDefaults.itemShape(i, labels.size), icon = {},
                    colors = SegmentedButtonDefaults.colors(activeContainerColor = AccentGreen.copy(alpha = 0.18f), activeContentColor = AccentGreen)) {
                    Text(label, maxLines = 1, softWrap = false, style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }

    CompositionLocalProvider(LocalWatch provides store.watch.takeIf { it.enabled }) {
    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f)) {
            if (wide) {
                var right by remember { mutableStateOf(MainTab.CHAT) } // 💬, ✉️ or 📻
                LaunchedEffect(jb?.showTab) { if (jb?.showTab == true) { right = MainTab.JUKEBOX; jb.showTab = false; jb.revealTick++ } }
                // ✉️ from a notification / a name in the chat: the DM pane.
                LaunchedEffect(dm?.showPage) { if (dm?.showPage == true) { right = MainTab.DM; dm.showPage = false } }
                // 「チャットに引用」: show the chat (it takes the quote into its draft).
                LaunchedEffect(ChatQuote.pending) { if (ChatQuote.pending != null) right = MainTab.CHAT }
                // ☗ 将棋 from a notification / the chat card: show the chat (the shogi panel is above it).
                LaunchedEffect(store.shogi.revealTick) { if (store.shogi.revealTick > 0) right = MainTab.CHAT }
                // 🍻 オフ会 from a notification: show the chat (the panel is above it).
                LaunchedEffect(store.offkai.revealTick) { if (store.offkai.revealTick > 0) right = MainTab.CHAT }
                // 🎧 音声をこの端末で続ける (voice_handoff): show the chat (the feature is on it).
                LaunchedEffect(store.chatRevealTick) { if (store.chatRevealTick > 0) right = MainTab.CHAT }
                // 📺 「みんなで見る」 over the chat (chat_overlay): the player is a window of the chat, so show the chat.
                LaunchedEffect(store.watch.revealTick) { if (store.watch.revealTick > 0 && store.chatOverlay) right = MainTab.CHAT }
                val rightTabs = MainTabs.right(dm != null, jb != null)
                // A tab that went away (DM / the jukebox turned off): back to the chat.
                if (right !in rightTabs) right = MainTab.CHAT
                androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxSize()) {
                // A phone on its side with ☗ / 🎮 open: the board / game takes the timeline's place, beside the chat
                // (ChatScreen puts it there at the full height; above the chat it would be cut off).
                val panelBeside = right == MainTab.CHAT && store.panelOpen && SidePanelLayout.beside(maxWidth, maxHeight)
                Row(Modifier.fillMaxSize()) {
                    if (!panelBeside) {
                        Row(Modifier.width(420.dp).fillMaxHeight()) {
                            TimelineScreen(timeline, store.capabilities, tabSwitch = null, onReconnect = onSignOut)
                        }
                        VerticalDivider()
                    }
                    val labels = rightTabs.map { tabLabel(it, store) }
                    val badges = rightTabs.indexOf(MainTab.DM).takeIf { it >= 0 }?.let { mapOf(it to (dm?.badgeTotal ?: 0)) } ?: emptyMap()
                    val switch: (@Composable () -> Unit)? = if (rightTabs.size < 2) null else {
                        { Segments(labels, rightTabs.indexOf(right), { right = rightTabs[it] }, badges) }
                    }
                    when {
                        jb != null && right == MainTab.JUKEBOX -> JukeboxScreen(jb, store.capabilities, switch, onOpenThread = { timeline.openThread = it })
                        dm != null && right == MainTab.DM -> PostLinksInApp(timeline) { DMPage(dm, store.members, visible = true, tabSwitch = switch) }
                        else -> PostLinksInApp(timeline) { ChatScreen(store, onSignOut = onSignOut, tabSwitch = switch) }
                    }
                }
                }
            } else {
                Pages(store, timeline, jb, dm, onSignOut) { labels, selected, onSelect, badges -> Segments(labels, selected, onSelect, badges) }
            }
        }
        // No mini player under the timeline and the chat (drikin 2026-10-20): the jukebox
        // tab and the playback notification play and pause.
    }
    // 📺 floating over every page (a 「みんなで見る」 on the timeline opens it here).
    // (Over the chat — docs/chat-overlay-spec.md — the player is one of the chat's windows instead.)
    if (!store.chatOverlay && store.watch.open && store.watch.mode == WatchStore.Mode.FLOATING) WatchFloating(store.watch)
    }
}

@Composable
private fun Pages(
    store: ChatStore,
    timeline: TimelineStore,
    jb: JukeboxStore?,
    dm: DMStore?,
    onSignOut: () -> Unit,
    segments: @Composable (List<String>, Int, (Int) -> Unit, Map<Int, Int>) -> Unit,
) {
    val tabs = MainTabs.pages(dm != null, jb != null)
    val dmPage = tabs.indexOf(MainTab.DM)
    val jbPage = tabs.indexOf(MainTab.JUKEBOX)
    val pager = rememberPagerState(initialPage = 1) { tabs.size } // 📰 💬 (✉️) (📻)
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
    // Demo (`--es demo_tab`): start on that page.
    LaunchedEffect(store.demoPage, tabs) {
        store.demoPage?.let { t -> tabs.indexOf(t).takeIf { it >= 0 }?.let { pager.scrollToPage(it) }; store.demoPage = null }
    }
    // ✉️ from a notification / a name in the chat / the demo: the DM page (the conversation opens there).
    LaunchedEffect(dm?.showPage, dmPage) { if (dm?.showPage == true && dmPage >= 0) { dm.showPage = false; scope.launch { pager.animateScrollToPage(dmPage) } } }
    // ☗ 将棋 from a notification: show the chat (the shogi panel opens above it).
    LaunchedEffect(store.shogi.revealTick) { if (store.shogi.revealTick > 0) scope.launch { pager.animateScrollToPage(1) } }
    // 🍻 オフ会 from a notification: show the chat (the panel opens above it).
    LaunchedEffect(store.offkai.revealTick) { if (store.offkai.revealTick > 0) scope.launch { pager.animateScrollToPage(1) } }
    // 🎧 音声をこの端末で続ける (voice_handoff): the chat page (the feature is on it).
    LaunchedEffect(store.chatRevealTick) { if (store.chatRevealTick > 0) scope.launch { pager.animateScrollToPage(1) } }
    // 📺 「みんなで見る」 on the timeline over the chat (chat_overlay): the chat page, where the player is expanded
    // (the old form floats it over every page instead).
    LaunchedEffect(store.watch.revealTick) { if (store.watch.revealTick > 0 && store.chatOverlay) scope.launch { pager.animateScrollToPage(1) } }
    // The playback notification / the mini player: show the jukebox.
    LaunchedEffect(jb?.showTab, jbPage) { if (jb?.showTab == true && jbPage >= 0) { pager.animateScrollToPage(jbPage); jb.showTab = false; jb.revealTick++ } }

    // 📰 タイムライン ・ 💬 チャット ・ ✉️ DM ・ 📻 プレイヤー — the same order and marks in every app (drikin 2026-10-20, ✉️ 2026-11-08).
    val labels = tabs.map { tabLabel(it, store) }
    val badges = if (dmPage >= 0) mapOf(dmPage to (dm?.badgeTotal ?: 0)) else emptyMap()
    val switch: @Composable () -> Unit = {
        segments(labels, pager.currentPage, { i -> scope.launch { pager.animateScrollToPage(i) } }, badges)
    }
    // The chat page is at least partly on screen (swiping to or from it counts): its room and
    // ☗ clock run only then — they are drawn live as the page slides in.
    val chatOnScreen by remember(pager) { derivedStateOf { abs(pager.currentPage + pager.currentPageOffsetFraction - 1f) < 1f } }
    // The neighbours stay composed from the start: deferring them saved ~30 ms of the first
    // frame but added one 150–220 ms frame right after launch (measured 2026-10-20).
    HorizontalPager(pager, Modifier.fillMaxSize(), beyondViewportPageCount = 1) { page ->
        when (page) {
            0 -> TimelineScreen(timeline, store.capabilities, tabSwitch = switch, onReconnect = onSignOut, visible = pager.currentPage == 0)
            1 -> PostLinksInApp(timeline) { ChatScreen(store, onSignOut = onSignOut, tabSwitch = switch, visible = pager.currentPage == 1, onScreen = chatOnScreen) }
            // B-guru post links in DMs open the thread in the app too (like the chat).
            dmPage -> if (dm != null) PostLinksInApp(timeline) { DMPage(dm, store.members, visible = pager.currentPage == dmPage, tabSwitch = switch) }
            jbPage -> if (jb != null) JukeboxScreen(jb, store.capabilities, switch, visible = { pager.currentPage == jbPage },
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

/** The mark of a tab in the switch (💬• = unread in the chat; ✉️'s count is a badge beside it). */
private fun tabLabel(tab: MainTab, store: ChatStore): String = when (tab) {
    MainTab.TIMELINE -> "📰"
    MainTab.CHAT -> if (store.unreadCount > 0) "💬•" else "💬"
    MainTab.DM -> "✉️"
    MainTab.JUKEBOX -> "📻"
}

/** The tabs in the top bar: segments sized to their marks, drawn like the two-tab SegmentedButton row.
 *  [badges]: a red count beside that tab's mark (✉️: 1 対 1 and groups together). */
@Composable
private fun CompactSegments(labels: List<String>, selected: Int, onSelect: (Int) -> Unit, badges: Map<Int, Int> = emptyMap()) {
    val scheme = MaterialTheme.colorScheme
    val shape = androidx.compose.foundation.shape.RoundedCornerShape(50)
    Row(
        Modifier.height(40.dp).clip(shape).border(1.dp, scheme.outline, shape),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
    ) {
        labels.forEachIndexed { i, label ->
            val count = badges[i] ?: 0
            if (i > 0) Box(Modifier.width(1.dp).fillMaxHeight().background(scheme.outline))
            Row(
                Modifier.fillMaxHeight()
                    .background(if (i == selected) AccentGreen.copy(alpha = 0.18f) else androidx.compose.ui.graphics.Color.Transparent) // the app's green, not Material's default
                    .selectable(selected = i == selected, role = androidx.compose.ui.semantics.Role.Tab) { onSelect(i) }
                    .then(if (label == "✉️") Modifier.semantics { contentDescription = if (count > 0) "DM（未読 $count）" else "DM" } else Modifier)
                    .padding(horizontal = 9.dp),
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
            ) {
                Text(label, maxLines = 1, softWrap = false, style = MaterialTheme.typography.labelMedium,
                    color = if (i == selected) AccentGreen else scheme.onSurface)
                if (count > 0) {
                    Box(
                        Modifier.padding(start = 3.dp).height(16.dp).widthIn(min = 16.dp)
                            .background(androidx.compose.ui.graphics.Color(0xFFDC2626), androidx.compose.foundation.shape.RoundedCornerShape(50))
                            .padding(horizontal = 4.dp),
                        contentAlignment = androidx.compose.ui.Alignment.Center,
                    ) {
                        // lineHeight: the inherited 24 sp would push the digit out of the 16 dp pill.
                        Text(if (count > 99) "99+" else "$count", color = androidx.compose.ui.graphics.Color.White, fontSize = 10.sp, lineHeight = 12.sp, maxLines = 1)
                    }
                }
            }
        }
    }
}
