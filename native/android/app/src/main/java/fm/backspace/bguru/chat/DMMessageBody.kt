package fm.backspace.bguru.chat

import android.content.ClipData
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/*
 * ✉️👥 DM をチャットと同じに (docs/dm-chat-parity-spec.md, 「チャットとDMで機能を同じにして」 2026-11-08):
 * a DM / group message drawn and handled like the chat's MessageRow — long-press menu (よく使う 12 + ＋ picker,
 * 返信, 編集, テキストをコピー / 選択), double-tap ❤️, the reaction chips (long-press: who reacted), the
 * 「編集済み」 mark, links (post links open in the app: PostLinksInApp around the DM page) and 📺 for YouTube.
 */

/** The photos, the text bubble with its menu, and the chips of one DM. [canReact] / [canEdit] already include
 *  the capability and whether this message may be (stored, mine, not a system line…). */
@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable
internal fun DMMessageBody(
    body: String,
    images: List<String>,
    localImages: List<ImageBitmap>,
    mine: Boolean,
    mentionsMe: Boolean,
    editing: Boolean,
    reactions: List<Reaction>,
    canReact: Boolean,
    canEdit: Boolean,
    onReact: (String) -> Unit,
    onEdit: () -> Unit,
    onReply: (() -> Unit)?,
    onSelect: () -> Unit,
    onOpenImage: (List<String>, Int) -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    var picker by remember { mutableStateOf(false) }
    if (picker) EmojiPickerSheet(onDismiss = { picker = false }) { e -> picker = false; onReact(e) }
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    val align = if (mine) Alignment.End else Alignment.Start
    Column(horizontalAlignment = align) {
        Box {
            Column(horizontalAlignment = align, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (images.isNotEmpty() || localImages.isNotEmpty()) {
                    ChatImages(urls = images, local = localImages,
                        onOpen = if (images.isEmpty()) null else { i -> onOpenImage(images, i) },
                        onLongPress = { menu = true })
                }
                // A photo-only DM has no text bubble.
                if (body.isNotEmpty() || (images.isEmpty() && localImages.isEmpty())) {
                    val emojiOnly = remember(body) { isEmojiOnly(body) }
                    val text = remember(body) { linkified(body) }
                    val bubble = when {
                        emojiOnly -> Color.Transparent
                        mine -> AccentGreen.copy(alpha = 0.14f)
                        mentionsMe -> Color(0xFFFACC15).copy(alpha = 0.22f)
                        else -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f)
                    }
                    Text(
                        text,
                        fontSize = if (emojiOnly) 34.sp else 16.sp,
                        modifier = Modifier
                            .background(bubble, RoundedCornerShape(12.dp))
                            .then(if (editing) Modifier.border(1.5.dp, AccentGreen, RoundedCornerShape(12.dp)) else Modifier)
                            .combinedClickable(
                                onClick = {},
                                onDoubleClick = { if (canReact) onReact("❤️") },
                                onLongClick = { menu = true },
                            )
                            .padding(horizontal = if (emojiOnly) 4.dp else 10.dp, vertical = if (emojiOnly) 0.dp else 6.dp),
                    )
                    // 📺 a YouTube link: 「みんなで見る」 under the bubble.
                    val watch = LocalWatch.current
                    val video = remember(body) { WatchLogic.firstVideoUrl(body) }
                    if (watch != null && video != null) WatchTogetherButton(watch, video)
                }
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                if (canReact) {
                    ReactionQuickRows(onReact = { e -> menu = false; onReact(e) }, onMore = { menu = false; picker = true })
                    HorizontalDivider()
                }
                if (onReply != null) DropdownMenuItem(text = { Text("返信（@メンション）") }, onClick = { menu = false; onReply() })
                if (canEdit) DropdownMenuItem(text = { Text("編集") }, onClick = { menu = false; onEdit() })
                if (body.isNotEmpty()) {
                    DropdownMenuItem(text = { Text("テキストをコピー") }, onClick = {
                        menu = false
                        scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("message", body))) }
                    })
                    DropdownMenuItem(text = { Text("テキストを選択") }, onClick = { menu = false; onSelect() })
                }
            }
        }
        if (reactions.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 2.dp)) {
                // The chat's chip, plus long-press: who reacted (the timeline's list).
                reactions.forEach { r -> PostReactionChip(r, null, enabled = canReact) { onReact(r.emoji) } }
            }
        }
    }
}

/** 「編集済み」 beside the time (the chat's mark). */
@Composable
internal fun EditedMark(edited: Boolean) {
    if (edited) Text("編集済み", style = MaterialTheme.typography.labelSmall, color = AccentGreen)
}

/** Above the composer while editing (the chat's 「メッセージを編集中」 row). */
@Composable
internal fun EditingBanner(onCancel: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("メッセージを編集中", style = MaterialTheme.typography.labelMedium, color = AccentGreen, modifier = Modifier.weight(1f))
        TextButton(onClick = onCancel) { Text("キャンセル") }
    }
}
