package fm.backspace.bguru.chat

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/** Phone: timeline and chat as two pages — swipe left/right or use the switch at
 *  the top (like the iPhone app). Tablet / wide window: both side by side. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(store: ChatStore, timeline: TimelineStore, onSignOut: () -> Unit) {
    val wide = LocalConfiguration.current.screenWidthDp >= 840
    if (wide) {
        Row(Modifier.fillMaxSize()) {
            Row(Modifier.width(420.dp).fillMaxHeight()) {
                TimelineScreen(timeline, store.capabilities, tabSwitch = null, onReconnect = onSignOut)
            }
            VerticalDivider()
            ChatScreen(store, onSignOut = onSignOut)
        }
        return
    }
    val pager = rememberPagerState(initialPage = 1) { 2 } // 0 = timeline, 1 = chat
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    // Switching pages hides the keyboard.
    LaunchedEffect(pager.currentPage) { focus.clearFocus() }
    // A "reply to your post" notification: show the timeline (it opens the thread).
    LaunchedEffect(timeline.openThread) { if (timeline.openThread != null) pager.animateScrollToPage(0) }

    val switch: @Composable () -> Unit = {
        SingleChoiceSegmentedButtonRow(Modifier.width(250.dp)) {
            SegmentedButton(selected = pager.currentPage == 0, onClick = { scope.launch { pager.animateScrollToPage(0) } },
                shape = SegmentedButtonDefaults.itemShape(0, 2), icon = {}) {
                Text(if (timeline.unreadCount > 0) "タイムライン•" else "タイムライン", maxLines = 1, softWrap = false,
                    style = androidx.compose.material3.MaterialTheme.typography.labelMedium)
            }
            SegmentedButton(selected = pager.currentPage == 1, onClick = { scope.launch { pager.animateScrollToPage(1) } },
                shape = SegmentedButtonDefaults.itemShape(1, 2), icon = {}) {
                Text(if (store.unreadCount > 0) "チャット•" else "チャット", maxLines = 1, softWrap = false,
                    style = androidx.compose.material3.MaterialTheme.typography.labelMedium)
            }
        }
    }
    HorizontalPager(pager, Modifier.fillMaxSize(), beyondViewportPageCount = 1) { page ->
        if (page == 0) TimelineScreen(timeline, store.capabilities, tabSwitch = switch, onReconnect = onSignOut, visible = pager.currentPage == 0)
        else ChatScreen(store, onSignOut = onSignOut, tabSwitch = switch, visible = pager.currentPage == 1)
    }
}
