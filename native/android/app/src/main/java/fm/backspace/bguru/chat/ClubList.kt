package fm.backspace.bguru.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** 部活で絞り込む: pick a club and the timeline shows only its posts (「すべての部活」 = all).
 *  リュー 2026-11-09「タイムラインからさらに左側にスワイプすると部活一覧が出るようにしても良いかも」
 *  → オーナー「全アプリに作る」. Phone: a page left of the timeline. Wide screen: the timeline's list
 *  menu (「部活で絞り込む」). The clubs this member hides (部活の表示) are left out.
 *  Same as native/shared/ClubListView.swift. Unit-tested: ClubFilterTest. */
object ClubFilterRules {
    /** The clubs the list offers: the server's order (clubs keeps it), without the hidden ones. */
    fun visible(clubs: Map<String, String>, hidden: Set<String>): List<Pair<String, String>> =
        clubs.filterKeys { it !in hidden }.toList()

    /** The picked club after the hidden ones changed: a hidden club goes back to all (null). */
    fun keep(filter: String?, hidden: Set<String>): String? = filter?.takeIf { it !in hidden }

    /** Demo only: the sample posts of one club (null = all). */
    fun demoPosts(all: List<Post>, club: String?): List<Post> = if (club == null) all else all.filter { it.club == club }
}

/** The phone page left of the timeline. [onPicked]: back to the timeline page. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ClubListPage(timeline: TimelineStore, onPicked: () -> Unit) {
    LaunchedEffect(Unit) { timeline.loadHiddenClubKeys() }
    Scaffold(
        topBar = { TopAppBar(title = { Text("部活") }) },
        contentWindowInsets = androidx.compose.foundation.layout.WindowInsets(0),
    ) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize()) {
            clubRows(timeline) { key -> onPicked(); timeline.setClubFilter(key) }
        }
    }
}

/** Wide screen: the same list in a sheet, from the timeline's list menu. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ClubFilterSheet(timeline: TimelineStore) {
    LaunchedEffect(Unit) { timeline.loadHiddenClubKeys() }
    ModalBottomSheet(onDismissRequest = { timeline.dialog = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            Text("部活で絞り込む", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 560.dp)) {
                clubRows(timeline) { key -> timeline.dialog = null; timeline.setClubFilter(key) }
            }
            Spacer(Modifier.height(12.dp))
        }
    }
}

/** 「すべての部活」, the caption, then 「部活」 with each visible club; the picked one has a check. */
private fun LazyListScope.clubRows(timeline: TimelineStore, onPick: (String?) -> Unit) {
    item(key = "all") { ClubRow("🗂", "すべての部活", timeline.clubFilter == null) { onPick(null) } }
    item(key = "caption") {
        Text("選んだ部活の投稿だけをタイムラインに出します。", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
    }
    item(key = "section") {
        Text("部活", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 4.dp))
    }
    val clubs = timeline.visibleClubs
    if (clubs.isEmpty()) item(key = "loading") {
        Text("読み込み中…", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
    }
    items(clubs, key = { "club-${it.first}" }) { (key, name) ->
        ClubRow("🏷️", name, timeline.clubFilter == key) { onPick(key) }
    }
}

@Composable
private fun ClubRow(mark: String, name: String, on: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().semantics { selected = on }.clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(mark)
        Spacer(Modifier.width(12.dp))
        Text(name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (on) Icon(Icons.Default.Check, "選択中", tint = AccentGreen)
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
