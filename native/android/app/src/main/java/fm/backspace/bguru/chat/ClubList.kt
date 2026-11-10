package fm.backspace.bguru.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** How the club list is ordered: 「自分の順番」 (saved on the server) or 「未読順」 (オーナー 2026-11-09). Kept per device. */
enum class ClubSort { CUSTOM, UNREAD }

/** 部活で絞り込む: pick a club and the timeline shows only its posts (「すべての部活」 = all).
 *  リュー 2026-11-09「タイムラインからさらに左側にスワイプすると部活一覧が出るようにしても良いかも」
 *  → オーナー「全アプリに作る」. Phone: a page left of the timeline. Wide screen: the timeline's list
 *  menu (「部活で絞り込む」). The clubs this member hides (部活の表示) are left out.
 *  オーナー 2026-11-09「未読数も出してほしい。未読の数でソーティング、自分でカスタマイズした順番か未読順かで選べるように」:
 *  each club shows its unread (posts by others not read yet; replies not counted), and the list is in
 *  this member's own order (kept on the server, the same on every device) or by unread.
 *  Same as native/shared/ClubListView.swift. Unit-tested: ClubFilterTest. */
object ClubFilterRules {
    /** The clubs the list offers: the server's order (clubs keeps it), without the hidden ones. */
    fun visible(clubs: Map<String, String>, hidden: Set<String>): List<Pair<String, String>> =
        clubs.filterKeys { it !in hidden }.toList()

    /** The picked club after the hidden ones changed: a hidden club goes back to all (null). */
    fun keep(filter: String?, hidden: Set<String>): String? = filter?.takeIf { it !in hidden }

    /** 自分の順番: the saved keys first, in that order (ones not in the list skipped), then the rest in the catalog's order. */
    fun customOrder(visible: List<Pair<String, String>>, saved: List<String>): List<Pair<String, String>> {
        val names = visible.toMap()
        val first = saved.distinct().mapNotNull { k -> names[k]?.let { k to it } }
        val placed = first.mapTo(HashSet()) { it.first }
        return first + visible.filter { it.first !in placed }
    }

    /** The list as shown: 自分の順番, or 未読順 = most unread first, ties in 自分の順番. */
    fun sorted(visible: List<Pair<String, String>>, saved: List<String>, unread: Map<String, Int>, mode: ClubSort): List<Pair<String, String>> {
        val custom = customOrder(visible, saved)
        return if (mode == ClubSort.UNREAD) custom.sortedByDescending { unread[it.first] ?: 0 } else custom // stable
    }

    /** 「すべての部活」: the unread of the listed clubs only. */
    fun total(visible: List<Pair<String, String>>, unread: Map<String, Int>): Int = visible.sumOf { (unread[it.first] ?: 0).coerceAtLeast(0) }

    /** The badge's text: nothing for 0, 99+ above 99. */
    fun badge(n: Int): String? = when { n <= 0 -> null; n > 99 -> "99+"; else -> "$n" }

    /** ↑ (by = -1) / ↓ (+1) in the arranging list; at an end nothing moves. */
    fun move(keys: List<String>, index: Int, by: Int): List<String> {
        val to = index + by
        if (index !in keys.indices || to !in keys.indices) return keys
        return keys.toMutableList().apply { add(to, removeAt(index)) }
    }

    /** The order PUT: the arranged (listed) clubs, then the saved ones not listed now (hidden) so they keep a place. */
    fun orderToSave(arranged: List<String>, saved: List<String>): List<String> {
        val a = arranged.distinct()
        return a + saved.distinct().filter { it !in a }
    }

    /** Demo only: the sample posts of one club (null = all). */
    fun demoPosts(all: List<Post>, club: String?): List<Post> = if (club == null) all else all.filter { it.club == club }
}

/** The arranging list while 「並べ替え」 is on (null: off). */
private class ClubArrange { var keys by mutableStateOf<List<String>?>(null) }

/** 「並べ替え」 / 「キャンセル」「完了」: only in 自分の順番 on a server that keeps the order. */
@Composable
private fun ArrangeButtons(timeline: TimelineStore, arrange: ClubArrange) {
    val keys = arrange.keys
    if (keys != null) {
        TextButton(onClick = { arrange.keys = null }) { Text("キャンセル") }
        TextButton(onClick = { timeline.saveClubOrder(keys); arrange.keys = null }) { Text("完了", fontWeight = FontWeight.SemiBold) }
    } else if (timeline.canClubOrder && (timeline.clubSort == ClubSort.CUSTOM || !timeline.canClubUnread) && timeline.visibleClubs.size > 1) {
        TextButton(onClick = { arrange.keys = timeline.sortedClubs.map { it.first } }) { Text("並べ替え") }
    }
}

/** The phone page left of the timeline. [visible]: on screen (the counts are read again). [onPicked]: back to the timeline page. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ClubListPage(timeline: TimelineStore, visible: Boolean, onPicked: () -> Unit) {
    val arrange = remember { ClubArrange() }
    LaunchedEffect(Unit) { timeline.loadHiddenClubKeys() }
    LaunchedEffect(visible) { if (visible) timeline.loadClubUnread() else arrange.keys = null }
    Scaffold(
        topBar = { TopAppBar(title = { Text("部活") }, actions = { ArrangeButtons(timeline, arrange) }) },
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0),
    ) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize()) {
            clubRows(timeline, arrange) { key -> onPicked(); timeline.setClubFilter(key) }
        }
    }
}

/** Wide screen: the same list in a sheet, from the timeline's list menu. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ClubFilterSheet(timeline: TimelineStore) {
    val arrange = remember { ClubArrange() }
    LaunchedEffect(Unit) { timeline.loadHiddenClubKeys(); timeline.loadClubUnread() }
    ModalBottomSheet(onDismissRequest = { timeline.dialog = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("部活で絞り込む", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f).padding(vertical = 8.dp))
                ArrangeButtons(timeline, arrange)
            }
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 560.dp)) {
                clubRows(timeline, arrange) { key -> timeline.dialog = null; timeline.setClubFilter(key) }
            }
            Spacer(Modifier.height(12.dp))
        }
    }
}

/** The sort switch, 「すべての部活」, the caption, then 「部活」 with each visible club and its unread; the picked one has a check.
 *  While arranging: each club with ↑ ↓ instead. */
private fun LazyListScope.clubRows(timeline: TimelineStore, arrange: ClubArrange, onPick: (String?) -> Unit) {
    val arranging = arrange.keys
    val counts = timeline.canClubUnread
    if (counts && arranging == null) item(key = "sort") {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            listOf(ClubSort.CUSTOM to "自分の順番", ClubSort.UNREAD to "未読順").forEachIndexed { i, (mode, label) ->
                SegmentedButton(selected = timeline.clubSort == mode, onClick = { timeline.setClubSortMode(mode) },
                    shape = SegmentedButtonDefaults.itemShape(i, 2)) { Text(label) }
            }
        }
    }
    timeline.clubOrderError?.let { err ->
        item(key = "error") { Text(err, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
    }
    if (arranging != null) {
        item(key = "arrange-caption") {
            Text("↑ ↓ で並べ替えて「完了」で保存します。どの端末でも同じ順番になります。", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
        }
        val names = timeline.visibleClubs.toMap()
        val keys = arranging.filter { it in names }
        itemsIndexed(keys, key = { _, k -> "arrange-$k" }) { i, k ->
            ArrangeRow(names[k] ?: k, up = i > 0, down = i < keys.size - 1,
                onUp = { arrange.keys = ClubFilterRules.move(keys, i, -1) }, onDown = { arrange.keys = ClubFilterRules.move(keys, i, 1) })
        }
        return
    }
    item(key = "all") { ClubRow("🗂", "すべての部活", timeline.clubFilter == null, if (counts) timeline.clubUnreadTotal else 0) { onPick(null) } }
    item(key = "caption") {
        Text("選んだ部活の投稿だけをタイムラインに出します。" + if (counts) "数字はまだ読んでいない投稿（返信は数えません）。" else "",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
    }
    item(key = "section") {
        Text("部活", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 4.dp))
    }
    val clubs = timeline.sortedClubs
    if (clubs.isEmpty()) item(key = "loading") {
        Text("読み込み中…", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
    }
    itemsIndexed(clubs, key = { _, c -> "club-${c.first}" }) { _, (key, name) ->
        ClubRow("🏷️", name, timeline.clubFilter == key, if (counts) timeline.clubUnread[key] ?: 0 else 0) { onPick(key) }
    }
}

@Composable
private fun ClubRow(mark: String, name: String, on: Boolean, unread: Int, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().semantics { selected = on }.clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(mark)
        Spacer(Modifier.width(12.dp))
        Text(name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        ClubFilterRules.badge(unread)?.let { UnreadBadge(it, unread) }
        if (on) { Spacer(Modifier.width(8.dp)); Icon(Icons.Default.Check, "選択中", tint = AccentGreen) }
    }
    HorizontalDivider()
}

/** The unread count at the row's end: a small pill. */
@Composable
private fun UnreadBadge(text: String, n: Int) {
    Box(
        Modifier.semantics { contentDescription = "未読 $n 件" }.heightIn(min = 22.dp)
            .background(AccentGreen, RoundedCornerShape(11.dp)).padding(horizontal = 8.dp, vertical = 2.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = Color.White, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun ArrangeRow(name: String, up: Boolean, down: Boolean, onUp: () -> Unit, onDown: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 2.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("🏷️")
        Spacer(Modifier.width(12.dp))
        Text(name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        IconButton(onClick = onUp, enabled = up) { Icon(Icons.Default.KeyboardArrowUp, "$name を上へ", Modifier.size(24.dp)) }
        IconButton(onClick = onDown, enabled = down) { Icon(Icons.Default.KeyboardArrowDown, "$name を下へ", Modifier.size(24.dp)) }
    }
    HorizontalDivider()
}

/** Above the timeline while a club is picked: which club, and the way back to all. */
@Composable
fun ClubFilterBanner(timeline: TimelineStore) {
    val name = timeline.clubFilterName ?: return
    Row(
        Modifier.fillMaxWidth().background(AccentGreen.copy(alpha = 0.08f)).padding(start = 14.dp, end = 4.dp, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("🏷️ $name", color = AccentGreen, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        Text("の投稿だけ", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.weight(1f))
        TextButton(onClick = { timeline.setClubFilter(null) }) { Text("すべてに戻す", style = MaterialTheme.typography.labelMedium) }
    }
}
