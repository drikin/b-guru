package fm.backspace.bguru.chat

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant

/** 🍻 オフ会 UI (docs/offkai-spec.md): the tab's label, the panel above / beside the chat (start + archive,
 *  or the running event: who speaks, 聞く / 話す / 終了, the photos), an ended event's album, the viewer. */

private val OffkaiAmber = Color(0xFFF59E0B)

/** 🍻 (read out as 「オフ会」), with a dot while one is on. */
@Composable
fun OffkaiSegmentLabel(offkai: OffkaiStore) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp),
        modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = if (offkai.running) "オフ会（開催中）" else "オフ会" }) {
        Text("🍻", style = MaterialTheme.typography.labelLarge, maxLines = 1)
        if (offkai.running) Box(Modifier.size(7.dp).background(OffkaiAmber, CircleShape))
    }
}

/** Back: from an album to the list, from the panel to the text view. */
@Composable
fun OffkaiBackHandler(offkai: OffkaiStore) {
    BackHandler(enabled = offkai.open) { if (offkai.album != null) offkai.closeAlbum() else offkai.open = false }
}

/** The 🍻 panel. The caller sizes it (part of the column above the chat, or the side). */
@Composable
fun OffkaiPanel(offkai: OffkaiStore, modifier: Modifier = Modifier) {
    // Opening the tab reads the state again (what the stream may have missed).
    LaunchedEffect(Unit) { offkai.refresh() }
    var viewing by remember { mutableStateOf<Pair<Boolean, Long>?>(null) } // (album?, photo id)
    Surface(modifier, color = MaterialTheme.colorScheme.surfaceContainerLow) {
        val album = offkai.album
        when {
            album != null -> AlbumView(offkai, album) { viewing = true to it.id }
            offkai.running -> RunningView(offkai) { viewing = false to it.id }
            else -> StartView(offkai)
        }
    }
    viewing?.let { (fromAlbum, id) ->
        val list = if (fromAlbum) offkai.albumPhotos else offkai.photos
        if (list.isEmpty()) { viewing = null; return@let }
        val start = list.indexOfFirst { it.id == id }.coerceAtLeast(0)
        OffkaiPhotoViewer(offkai, list, start, onClose = { viewing = null })
    }
}

// MARK: not running — start + archive

@Composable
private fun StartView(offkai: OffkaiStore) {
    var title by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (offkai.canControl) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it.take(OffkaiLogic.TITLE_MAX) },
                    placeholder = { Text("場所・ひとこと（なくても可）", style = MaterialTheme.typography.bodySmall) },
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.weight(1f),
                )
                Button(onClick = { confirm = true }, enabled = !offkai.busy) { Text("🍻 オフ会を始める", maxLines = 1) }
            }
        } else {
            Text("🍻 オフ会はまだ始まっていません", style = MaterialTheme.typography.bodyMedium)
        }
        offkai.notice?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        HorizontalDivider()
        Text("これまでのオフ会", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (offkai.archive.isEmpty()) {
            Text("まだありません", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
            items(offkai.archive, key = { it.id }) { e -> ArchiveRow(offkai, e) { offkai.openAlbum(e) } }
            if (offkai.archiveMore) item(key = "more") {
                LaunchedEffect(offkai.archive.size) { offkai.loadMoreArchive() }
                Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(20.dp)) }
            }
        }
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("🍻 オフ会を始めますか？") },
            text = { Text("会員全員に「オフ会が始まりました」と通知が届きます。開始から 6 時間で自動で終わります。") },
            confirmButton = { TextButton(onClick = { confirm = false; offkai.start(title); title = "" }) { Text("始める") } },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("やめる") } },
        )
    }
}

@Composable
private fun ArchiveRow(offkai: OffkaiStore, e: OffkaiEvent, onOpen: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(48.dp).clip(RoundedCornerShape(6.dp))) {
            PhotoPicture(offkai, e.cover, e.id, Modifier.fillMaxSize(), maxPx = 160)
        }
        Column(Modifier.weight(1f)) {
            Text(OffkaiLogic.title(e), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${OffkaiLogic.dateLabel(e.startedAt)}・写真 ${e.photoCount} 枚", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text("›", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

// MARK: running

@Composable
private fun RunningView(offkai: OffkaiStore, onOpen: (OffkaiPhoto) -> Unit) {
    val e = offkai.current ?: return
    val context = LocalContext.current
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(Unit) { while (true) { delay(30_000); now = Instant.now() } }
    var confirmEnd by remember { mutableStateOf(false) }
    var confirmTakeOver by remember { mutableStateOf(false) }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) offkai.speak(true) else offkai.notice = "マイクを使えません（設定でマイクを許可してください）"
    }
    fun speakNow() {
        if (App.session(context).store?.voice?.hasMicPermission == true) offkai.speak(true)
        else micPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        // Title, how long, who speaks, how many listen.
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("🍻 ${OffkaiLogic.title(e)}", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text("開催中 ${OffkaiLogic.elapsed(e.startedAt, now)}", style = MaterialTheme.typography.labelSmall, color = OffkaiAmber)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            val sp = e.speaker
            val speakLine = when {
                offkai.iAmSpeaker -> if (offkai.micOn) "🎙 あなたが現地から話しています" else "🎙 あなたが話す番です（接続中…）"
                sp != null && sp.connected -> "🎙 ${sp.name ?: "だれか"}が話しています"
                else -> "🎙 いま話している人はいません"
            }
            Text(speakLine, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            Text("🎧 ${offkai.listeners}人", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        // 🔊 聞く／止める ・ 🎙 現地から話す／話すのをやめる ・ 📷 ・ 終了
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            when (offkai.phase) {
                OffkaiStore.Phase.IDLE -> FilledTonalButton(onClick = { offkai.listen() }, modifier = Modifier.height(36.dp)) { Text("🔊 聞く", fontSize = 13.sp) }
                OffkaiStore.Phase.CONNECTING -> FilledTonalButton(onClick = { offkai.stopListening() }, modifier = Modifier.height(36.dp)) { Text("接続中…", fontSize = 13.sp) }
                else -> FilledTonalButton(onClick = { offkai.stopListening() }, modifier = Modifier.height(36.dp)) {
                    Text(if (offkai.phase == OffkaiStore.Phase.RECONNECTING) "🔇 止める（再接続中）" else "🔇 止める", fontSize = 13.sp)
                }
            }
            if (offkai.canControl) {
                if (offkai.iAmSpeaker) {
                    OutlinedButton(onClick = { offkai.speak(false) }, enabled = !offkai.busy, modifier = Modifier.height(36.dp)) { Text("話すのをやめる", fontSize = 13.sp) }
                } else {
                    OutlinedButton(onClick = { if (e.speaker != null) confirmTakeOver = true else speakNow() }, enabled = !offkai.busy, modifier = Modifier.height(36.dp)) {
                        Text("🎙 現地から話す", fontSize = 13.sp)
                    }
                }
                PhotoButton(offkai)
            }
            if (offkai.canEnd) TextButton(onClick = { confirmEnd = true }, enabled = !offkai.busy, modifier = Modifier.height(36.dp)) {
                Text("終了", fontSize = 13.sp, color = MaterialTheme.colorScheme.error)
            }
        }
        ReadChatToggle(offkai)
        offkai.notice?.let { n ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(n, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f, fill = false))
                if (n.startsWith("マイクを使えません")) TextButton(onClick = {
                    context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
                }) { Text("設定を開く") }
            }
        }
        if (offkai.uploading > 0) Text("写真を送っています（${offkai.uploading} 枚）…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        PhotoGrid(offkai, offkai.photos, Modifier.weight(1f).fillMaxWidth(), followNewest = true, empty = "📷 から写真を上げると、ここに時間の順に並びます", onOpen = onOpen)
    }
    if (confirmEnd) {
        AlertDialog(
            onDismissRequest = { confirmEnd = false },
            title = { Text("オフ会を終了しますか？") },
            text = { Text("声の部屋が閉じます。写真はアルバムとして残ります。") },
            confirmButton = { TextButton(onClick = { confirmEnd = false; offkai.end() }) { Text("終了する") } },
            dismissButton = { TextButton(onClick = { confirmEnd = false }) { Text("やめる") } },
        )
    }
    if (confirmTakeOver) {
        AlertDialog(
            onDismissRequest = { confirmTakeOver = false },
            title = { Text("現地から話しますか？") },
            text = { Text("話せるのは 1 人だけです（同じ場所のマイクが 2 つあるとハウリングするため）。${e.speaker?.name ?: "いまの人"}さんから話す役を引き継ぎます。") },
            confirmButton = { TextButton(onClick = { confirmTakeOver = false; speakNow() }) { Text("話す") } },
            dismissButton = { TextButton(onClick = { confirmTakeOver = false }) { Text("やめる") } },
        )
    }
}

/** 🔈 チャットを読み上げる (this phone only, on by default): new chat messages are read aloud while this
 *  phone is in the 🍻 audio. A checkbox row; [compact] for the small 🍻 window over the chat. */
@Composable
internal fun ReadChatToggle(offkai: OffkaiStore, compact: Boolean = false) {
    val on = offkai.readChat
    Row(
        Modifier.toggleable(value = on, role = Role.Checkbox, onValueChange = { offkai.changeReadChat(it) })
            .then(if (compact) Modifier.height(28.dp) else Modifier.height(32.dp)),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Box(Modifier.size(if (compact) 16.dp else 18.dp).scale(if (compact) 0.7f else 0.8f), contentAlignment = Alignment.Center) {
            Checkbox(checked = on, onCheckedChange = null)
        }
        Text("🔈 チャットを読み上げる", fontSize = if (compact) 11.sp else 12.sp, maxLines = 1,
            color = if (on) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** 📷: take one or pick up to 4; then a caption and 送る. Resized to 1280 px, EXIF dropped (ChatAttachments). */
@Composable
internal fun PhotoButton(offkai: OffkaiStore, compact: Boolean = false) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val staged = remember { ChatAttachments() }
    var menu by remember { mutableStateOf(false) }
    var caption by remember { mutableStateOf("") }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(OffkaiLogic.MAX_PHOTOS)) { uris ->
        if (uris.isNotEmpty()) scope.launch { staged.add(context, uris, OffkaiLogic.MAX_PHOTOS, OffkaiLogic.PHOTO_MAX_SIDE) }
    }
    val camera = rememberCameraCapture { ctx, uri -> staged.add(ctx, listOf(uri), OffkaiLogic.MAX_PHOTOS, OffkaiLogic.PHOTO_MAX_SIDE) }
    Box {
        if (compact) OutlinedButton(onClick = { menu = true }, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
            modifier = Modifier.height(30.dp).width(40.dp).semantics { contentDescription = "写真" }) { Text("📷", fontSize = 13.sp) }
        else OutlinedButton(onClick = { menu = true }, modifier = Modifier.height(36.dp)) { Text("📷 写真", fontSize = 13.sp) }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text("カメラで撮る") }, onClick = { menu = false; camera() }, enabled = staged.remaining(OffkaiLogic.MAX_PHOTOS) > 0)
            DropdownMenuItem(text = { Text("写真を選ぶ（4 枚まで）") }, enabled = staged.remaining(OffkaiLogic.MAX_PHOTOS) > 0,
                onClick = { menu = false; picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) })
        }
    }
    if (staged.photos.isNotEmpty() || staged.loading > 0) {
        AlertDialog(
            onDismissRequest = { staged.take(); caption = "" },
            title = { Text("🍻 アルバムに上げる") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        staged.photos.forEachIndexed { i, p ->
                            Box {
                                Image(p.preview, contentDescription = null, contentScale = ContentScale.Crop,
                                    modifier = Modifier.size(56.dp).clip(RoundedCornerShape(6.dp)))
                                Text("✕", color = Color.White, fontSize = 11.sp, modifier = Modifier.align(Alignment.TopEnd)
                                    .background(Color.Black.copy(alpha = 0.55f), CircleShape).clickable { staged.remove(i) }.padding(horizontal = 5.dp))
                            }
                        }
                        if (staged.loading > 0) CircularProgressIndicator(Modifier.size(24.dp).align(Alignment.CenterVertically))
                    }
                    if (staged.remaining(OffkaiLogic.MAX_PHOTOS) > 0) Row {
                        TextButton(onClick = { camera() }) { Text("📷 撮る") }
                        TextButton(onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }) { Text("🖼️ 選ぶ") }
                    }
                    OutlinedTextField(value = caption, onValueChange = { caption = it.take(OffkaiLogic.CAPTION_MAX) },
                        placeholder = { Text("ひとこと（なくても可）") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    staged.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                    Text("チャットにも流れます（チャットの写真は 24 時間で消えますが、アルバムには残ります）",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
            confirmButton = {
                TextButton(enabled = staged.loading == 0 && staged.photos.isNotEmpty(), onClick = {
                    val c = caption
                    caption = ""
                    offkai.upload(staged.take(), c) { back -> staged.restore(back) }
                }) { Text("送る") }
            },
            dismissButton = { TextButton(onClick = { staged.take(); caption = "" }) { Text("やめる") } },
        )
    }
}

// MARK: album (ended)

@Composable
private fun AlbumView(offkai: OffkaiStore, e: OffkaiEvent, onOpen: (OffkaiPhoto) -> Unit) {
    Column(Modifier.fillMaxSize().padding(horizontal = 8.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { offkai.closeAlbum() }) { Text("‹ 戻る") }
            Column(Modifier.weight(1f)) {
                Text("🍻 ${OffkaiLogic.title(e)}", style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${OffkaiLogic.dateLabel(e.startedAt)}・写真 ${if (offkai.albumLoading) e.photoCount else offkai.albumPhotos.size} 枚",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        AlbumSaveRow(offkai, e)
        offkai.notice?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        if (offkai.albumLoading && offkai.albumPhotos.isEmpty()) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        } else {
            PhotoGrid(offkai, offkai.albumPhotos, Modifier.weight(1f).fillMaxWidth(), followNewest = false, empty = "写真はありません", onOpen = onOpen)
        }
    }
}

/** 「⬇ まとめて保存（N 枚）」 (only when the server said can_download and there is a photo), then 「12 / 40」 with
 *  中止, then 「40 枚を保存しました」. Saved into the gallery's Pictures/B-guru/<B-guru オフ会 日付 題>/. */
@Composable
private fun AlbumSaveRow(offkai: OffkaiStore, e: OffkaiEvent) {
    val context = LocalContext.current
    val s = offkai.save?.takeIf { it.eventId == e.id }
    val count = offkai.albumPhotos.size
    when {
        s?.running == true -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(horizontal = 8.dp)) {
            LinearProgressIndicator(progress = { if (s.total > 0) s.done.toFloat() / s.total else 0f }, modifier = Modifier.weight(1f))
            Text("⬇ ${OffkaiAlbumNames.progress(s.done, s.total)}", style = MaterialTheme.typography.bodySmall)
            TextButton(onClick = { offkai.cancelSave() }) { Text("中止") }
        }
        else -> Column(Modifier.padding(horizontal = 8.dp)) {
            if (offkai.albumCanDownload && count >= 1 && !offkai.albumLoading) {
                OutlinedButton(onClick = { offkai.saveAlbum(context.mainActivity()?.let { a -> a::askWriteStorage }) },
                    modifier = Modifier.height(34.dp)) { Text("⬇ まとめて保存（$count 枚）", fontSize = 13.sp) }
            }
            s?.message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

private fun android.content.Context.mainActivity(): MainActivity? {
    var c: android.content.Context? = this
    while (c is android.content.ContextWrapper) {
        if (c is MainActivity) return c
        c = c.baseContext
    }
    return null
}

// MARK: photos

@Composable
private fun PhotoGrid(offkai: OffkaiStore, photos: List<OffkaiPhoto>, modifier: Modifier, followNewest: Boolean, empty: String, onOpen: (OffkaiPhoto) -> Unit) {
    if (photos.isEmpty()) {
        Box(modifier, contentAlignment = Alignment.Center) {
            Text(empty, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }
    val state = rememberLazyGridState()
    // Oldest first, the newest at the bottom: a new photo (or opening) shows the newest.
    if (followNewest) LaunchedEffect(photos.size) { state.animateScrollToItem(photos.size - 1) }
    LazyVerticalGrid(GridCells.Adaptive(92.dp), modifier, state = state,
        horizontalArrangement = Arrangement.spacedBy(3.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        items(photos, key = { it.id }) { p ->
            Box(Modifier.aspectRatio(1f).clip(RoundedCornerShape(4.dp)).clickable { onOpen(p) }) {
                PhotoPicture(offkai, p.url, p.id, Modifier.fillMaxSize(), maxPx = 360)
            }
        }
    }
}

/** A photo (a demo upload: its own picture; no picture: a drawn 🍻 tile). */
@Composable
private fun PhotoPicture(offkai: OffkaiStore, url: String?, id: Long, modifier: Modifier, maxPx: Int, contentScale: ContentScale = ContentScale.Crop) {
    val local = offkai.localPictures[id]
    if (local != null) { Image(local, contentDescription = null, modifier = modifier, contentScale = contentScale); return }
    RemoteImage(url, modifier, contentScale = contentScale, maxPx = maxPx) {
        val tint = listOf(0xFFFDE68A, 0xFFBFDBFE, 0xFFFBCFE8, 0xFFBBF7D0, 0xFFDDD6FE)[(id % 5).toInt().let { if (it < 0) -it else it }]
        Box(modifier.background(Color(tint)), contentAlignment = Alignment.Center) { Text("🍻", fontSize = 22.sp) }
    }
}

/** Full screen, swipe between photos; my own photo can be deleted. */
@Composable
private fun OffkaiPhotoViewer(offkai: OffkaiStore, photos: List<OffkaiPhoto>, start: Int, onClose: () -> Unit) {
    var confirm by remember { mutableStateOf<OffkaiPhoto?>(null) }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            val pager = rememberPagerState(initialPage = start.coerceIn(0, (photos.size - 1).coerceAtLeast(0))) { photos.size }
            HorizontalPager(pager, Modifier.fillMaxSize(), key = { photos.getOrNull(it)?.id ?: it }) { page ->
                val p = photos.getOrNull(page) ?: return@HorizontalPager
                PhotoPicture(offkai, p.url, p.id, Modifier.fillMaxSize(), maxPx = 2048, contentScale = ContentScale.Fit)
            }
            Row(Modifier.align(Alignment.TopEnd).padding(12.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                val p = photos.getOrNull(pager.currentPage)
                if (p != null && OffkaiLogic.isMine(p, offkai.me)) {
                    TextButton(onClick = { confirm = p }) { Text("🗑 消す", color = Color.White) }
                }
                TextButton(onClick = onClose) { Text("✕ 閉じる", color = Color.White) }
            }
            photos.getOrNull(pager.currentPage)?.let { p ->
                Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Color.Black.copy(alpha = 0.5f))
                    .navigationBarsPadding().padding(horizontal = 16.dp, vertical = 10.dp)) {
                    if (p.caption.isNotBlank()) Text(p.caption, color = Color.White, style = MaterialTheme.typography.bodyMedium)
                    Row {
                        Text("${p.uploader.name ?: "だれか"}・${relativeTime(p.createdAt)}", color = Color.White.copy(alpha = 0.75f),
                            style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                        if (photos.size > 1) Text("${pager.currentPage + 1} / ${photos.size}", color = Color.White.copy(alpha = 0.75f), style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
    confirm?.let { p ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text("この写真を消しますか？") },
            text = { Text("アルバムから消えます（チャットに流れた分は 24 時間で消えます）。") },
            confirmButton = { TextButton(onClick = { confirm = null; offkai.deletePhoto(p); if (photos.size <= 1) onClose() }) { Text("消す") } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("やめる") } },
        )
    }
}
