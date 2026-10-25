package fm.backspace.bguru.chat

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
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
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.collectLatest

/** The voice room strip above the chat messages — same as native/shared/VoiceBar.swift.
 *
 *    room empty, not in it     → 🎙 ボイスルーム  誰もいません        [開く]
 *    people talking, not in it → 〰 3 人が参加中  (avatars)          [参加]
 *    in the room               → avatars (ring = speaking, slash = muted) [🎤] [退出]
 *
 *  Hidden entirely unless the server says voice is on for this member. */
@Composable
fun VoiceBar(voice: VoiceStore) {
    if (!voice.enabled) return
    val context = LocalContext.current
    var showAll by remember { mutableStateOf(false) }

    // The mic is asked for on the first unmute (never on joining — you enter muted).
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) voice.setMic(true) else voice.notice = "マイクを使えません（設定でマイクを許可してください）"
    }
    // Android 12+: routing the call to a Bluetooth headset needs "nearby devices".
    // Asked only when one is connected; joining goes ahead whatever the answer.
    val btPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { voice.join() }

    fun join() {
        val needBt = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && voice.bluetoothAudioConnected &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED
        if (needBt) btPermission.launch(Manifest.permission.BLUETOOTH_CONNECT) else voice.join()
    }

    fun toggleMic() {
        when {
            voice.micOn -> voice.setMic(false)
            voice.hasMicPermission -> voice.setMic(true)
            else -> micPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    Surface(color = AccentGreen.copy(alpha = if (voice.inRoom) 0.12f else 0.05f), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (voice.inRoom) InRoom(voice, onMic = ::toggleMic, onShowAll = { showAll = true })
            else Outside(voice, onJoin = ::join)
            voice.notice?.let { n ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(n, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f, fill = false))
                    if (n.startsWith("マイクを使えません")) {
                        TextButton(onClick = {
                            context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
                        }) { Text("設定を開く") }
                    }
                }
            }
        }
    }

    if (showAll) MemberSheet(voice, onClose = { showAll = false })
    voice.reportTarget?.let { ReportDialog(voice, it) }
}

// MARK: not in the room

@Composable
private fun Outside(voice: VoiceStore, onJoin: () -> Unit) {
    val info = voice.roomInfo
    val people = if (info?.active == true) info.participants else emptyList()
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(if (people.isEmpty()) MicIcon else WaveIcon, contentDescription = null, tint = AccentGreen, modifier = Modifier.size(20.dp))
        if (people.isEmpty()) {
            Text("ボイスルーム", style = MaterialTheme.typography.bodyMedium)
            Text("誰もいません", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            Text("${people.size} 人が参加中", style = MaterialTheme.typography.bodyMedium)
            Row(horizontalArrangement = Arrangement.spacedBy((-6).dp)) {
                people.take(5).forEach { Avatar(it.avatar, it.name ?: "?", size = 22.dp) }
            }
        }
        Spacer(Modifier.weight(1f))
        if (voice.canJoin) {
            Button(
                onClick = onJoin,
                colors = ButtonDefaults.buttonColors(containerColor = AccentGreen),
                contentPadding = ButtonDefaults.TextButtonContentPadding,
                modifier = Modifier.semantics { contentDescription = if (people.isEmpty()) "ボイスルームを開く" else "ボイスルームに参加" },
            ) { Text(if (people.isEmpty()) "開く" else "参加", fontWeight = FontWeight.Bold) }
        } else {
            Text("使うにはログインし直してください", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

// MARK: in the room

@Composable
private fun InRoom(voice: VoiceStore, onMic: () -> Unit, onShowAll: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (voice.phase == VoiceStore.Phase.CONNECTING || voice.phase == VoiceStore.Phase.RECONNECTING) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = AccentGreen)
            Text(
                if (voice.phase == VoiceStore.Phase.CONNECTING) "接続中…" else "再接続中…",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        val shown = voice.members.take(4)
        val rest = voice.members.size - shown.size
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(3.dp)) {
            shown.forEach { Face(voice, it) }
            if (rest > 0 || voice.members.size > 1) {
                Box(
                    Modifier
                        .defaultMinSize(minWidth = 30.dp, minHeight = 30.dp)
                        .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f), CircleShape)
                        .clickable(onClick = onShowAll)
                        .padding(horizontal = 6.dp)
                        .semantics { contentDescription = "参加者 ${voice.members.size} 人の一覧" },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(if (rest > 0) "+$rest" else "一覧", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
                }
            }
        }
        Spacer(Modifier.weight(1f))
        MicButton(voice, onMic)
        OutlinedButton(
            onClick = { voice.leave() },
            contentPadding = ButtonDefaults.TextButtonContentPadding,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
        ) { Text("退出") }
    }
}

/** One face: ring = speaking, slashed-mic badge = muted. Tap / long-press for the
 *  report (and admin) menu — not on my own face. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Face(voice: VoiceStore, m: VoiceStore.Member) {
    var menu by remember { mutableStateOf(false) }
    Box {
        Box(
            Modifier
                .border(if (m.speaking) 2.5.dp else 0.dp, if (m.speaking) AccentGreen else Color.Transparent, CircleShape)
                .then(if (m.isMe) Modifier else Modifier.combinedClickable(onClick = { menu = true }, onLongClick = { menu = true }))
                .semantics {
                    contentDescription = m.name + (if (m.speaking) "、話しています" else "") + (if (m.muted) "、ミュート中" else "")
                },
        ) {
            Avatar(m.avatar, m.name, size = 30.dp)
            if (m.muted) {
                Box(
                    Modifier.align(Alignment.BottomEnd).size(14.dp).background(MaterialTheme.colorScheme.outline, CircleShape),
                    contentAlignment = Alignment.Center,
                ) { Icon(MicOffIcon, contentDescription = null, tint = Color.White, modifier = Modifier.size(9.dp)) }
            }
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            MemberActions(voice, m) { menu = false }
        }
    }
}

/** Mute toggle that shows whether my voice is going out:
 *    muted       → grey, slashed mic
 *    on, quiet   → green outline, mic
 *    on, talking → solid green, ring that swells with the level */
@Composable
private fun MicButton(voice: VoiceStore, onClick: () -> Unit) {
    val active = voice.micActive
    // The ring follows the level (~15 Hz) off composition: only its layer redraws.
    val ring = remember { Animatable(1f) }
    LaunchedEffect(voice) {
        snapshotFlow { if (voice.micActive) 1f + voice.micLevel * 0.18f else 1f }.collectLatest { ring.animateTo(it) }
    }
    val shape = RoundedCornerShape(8.dp)
    val enabled = voice.phase == VoiceStore.Phase.CONNECTED
    Box(contentAlignment = Alignment.Center) {
        if (active) {
            Box(Modifier.size(width = 46.dp, height = 38.dp).graphicsLayer { scaleX = ring.value; scaleY = ring.value }.border(3.dp, AccentGreen.copy(alpha = 0.45f), RoundedCornerShape(10.dp)))
        }
        Box(
            Modifier
                .size(width = 40.dp, height = 32.dp)
                .background(if (active) AccentGreen else MaterialTheme.colorScheme.onSurface.copy(alpha = if (voice.micOn) 0.06f else 0.08f), shape)
                .border(if (voice.micOn) 1.5.dp else 0.dp, if (voice.micOn) AccentGreen else Color.Transparent, shape)
                .clickable(enabled = enabled && !voice.micBusy, onClick = onClick)
                .semantics {
                    contentDescription = if (voice.micOn) (if (active) "ミュートする（話しています）" else "ミュートする（マイク オン）") else "ミュートを解除して話す"
                },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                if (voice.micOn) MicIcon else MicOffIcon, contentDescription = null,
                tint = when {
                    active -> Color.White
                    voice.micOn -> AccentGreen
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                },
                modifier = Modifier.size(18.dp),
            )
            if (voice.micBusy) {
                CircularProgressIndicator(Modifier.align(Alignment.BottomEnd).padding(1.dp).size(9.dp), strokeWidth = 1.5.dp, color = AccentGreen)
            }
        }
    }
}

/** Everyone in the room (up to 100): talking first, then mics on, then listeners. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MemberSheet(voice: VoiceStore, onClose: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onClose) {
        val speakers = voice.members.count { !it.muted }
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("参加者 ${voice.members.size} 人", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.width(8.dp))
            Text("話せる人 $speakers/${voice.maxSpeakers}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        HorizontalDivider()
        LazyColumn(Modifier.navigationBarsPadding()) {
            items(voice.members, key = { it.userId }) { m ->
                var menu by remember { mutableStateOf(false) }
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Box(Modifier.border(if (m.speaking) 2.5.dp else 0.dp, if (m.speaking) AccentGreen else Color.Transparent, CircleShape)) {
                        Avatar(m.avatar, m.name, size = 28.dp)
                    }
                    Text(m.name + if (m.isMe) "（自分）" else "", maxLines = 1, modifier = Modifier.weight(1f))
                    if (m.speaking) Text("話しています", style = MaterialTheme.typography.bodySmall, color = AccentGreen)
                    Icon(
                        if (m.muted) MicOffIcon else MicIcon,
                        contentDescription = if (m.muted) "ミュート中" else "マイク オン",
                        tint = if (m.muted) MaterialTheme.colorScheme.onSurfaceVariant else AccentGreen,
                        modifier = Modifier.size(18.dp),
                    )
                    if (!m.isMe) {
                        Box {
                            IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, contentDescription = "${m.name} の操作") }
                            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                MemberActions(voice, m) { menu = false }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Menu items for someone else in the room: report (anyone), and for admins mute /
 *  remove / remove and ban. */
@Composable
private fun MemberActions(voice: VoiceStore, m: VoiceStore.Member, close: () -> Unit) {
    if (voice.canModerate) {
        DropdownMenuItem(text = { Text("ミュートさせる") }, enabled = !m.muted, onClick = { close(); voice.forceMute(m.userId) })
        DropdownMenuItem(text = { Text("退出させる") }, onClick = { close(); voice.kick(m.userId) })
        DropdownMenuItem(
            text = { Text("退出させて入室禁止", color = MaterialTheme.colorScheme.error) },
            onClick = { close(); voice.kick(m.userId, ban = true) },
        )
        HorizontalDivider()
    }
    DropdownMenuItem(text = { Text("管理者に通報…") }, onClick = { close(); voice.reportTarget = m })
}

@Composable
private fun ReportDialog(voice: VoiceStore, target: VoiceStore.Member) {
    var reason by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = { voice.reportTarget = null },
        title = { Text("${target.name} さんを管理者に通報") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("管理者に通知が届きます。相手には知らされません。", style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(reason, { reason = it.take(500) }, placeholder = { Text("何があったか（任意）") })
            }
        },
        confirmButton = {
            TextButton(onClick = {
                voice.report(target.userId, reason)
                voice.reportTarget = null
            }) { Text("通報する", color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = { voice.reportTarget = null }) { Text("やめる") } },
    )
}

// MARK: icons (Material "mic", "mic_off", "graphic_eq" — the core icon set has none)

private fun icon(name: String, path: String) = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
    .addPath(pathData = addPathNodes(path), fill = SolidColor(Color.Black))
    .build()

private val MicIcon = icon(
    "mic",
    "M12,14c1.66,0 2.99,-1.34 2.99,-3L15,5c0,-1.66 -1.34,-3 -3,-3S9,3.34 9,5v6c0,1.66 1.34,3 3,3zM17.3,11c0,3 -2.54,5.1 -5.3,5.1S6.7,14 6.7,11L5,11c0,3.41 2.72,6.23 6,6.72L11,21h2v-3.28c3.28,-0.48 6,-3.3 6,-6.72h-1.7z",
)

private val MicOffIcon = icon(
    "mic_off",
    "M19,11h-1.7c0,0.74 -0.16,1.43 -0.43,2.05l1.23,1.23c0.56,-0.98 0.9,-2.09 0.9,-3.28zM14.98,11.17c0,-0.06 0.02,-0.11 0.02,-0.17L15,5c0,-1.66 -1.34,-3 -3,-3S9,3.34 9,5v0.18l5.98,5.99zM4.27,3L3,4.27l6.01,6.01L9.01,11c0,1.66 1.33,3 2.99,3 0.22,0 0.44,-0.03 0.65,-0.08l1.66,1.66c-0.71,0.33 -1.5,0.52 -2.31,0.52 -2.76,0 -5.3,-2.1 -5.3,-5.1L5,11c0,3.41 2.72,6.23 6,6.72L11,21h2v-3.28c0.91,-0.13 1.77,-0.45 2.54,-0.9L19.73,21 21,19.73 4.27,3z",
)

private val WaveIcon = icon(
    "graphic_eq",
    "M7,18h2L9,6L7,6v12zM11,22h2L13,2h-2v20zM3,14h2v-4L3,10v4zM15,18h2L17,6h-2v12zM19,10v4h2v-4h-2z",
)
