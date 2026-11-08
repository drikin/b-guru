package fm.backspace.bguru.chat

import android.content.ClipData
import android.content.Context
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.content.TransferableContent
import androidx.compose.foundation.content.consume
import androidx.compose.foundation.content.contentReceiver
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldColors
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/*
 * 📷 Photos in the composers (chat, ✉️ DM, 👥 group DM) and pasting images into them
 * (docs/dm-photos-spec.md; drikin 2026-11-08 「クリップボードの画像を貼れるようにして欲しい」).
 *
 * Paste: an image from the clipboard (long-press 貼り付け), a keyboard's image insert (Gboard's
 * clipboard / stickers) or a drop becomes a photo in the tray, up to the same 4. Text pastes as before.
 * Compose delivers these only to the TextFieldState text field, so the composers' TextFieldValue is
 * mirrored into one ([PhotoTextField]).
 */

/** Pure rules for what a paste attaches (unit-tested: ComposerMediaTest). */
object PasteImages {
    fun isImageMime(mime: String?): Boolean = mime?.trim()?.lowercase()?.startsWith("image/") == true

    /**
     * The clip items that are photos. [itemUris] = each item's uri (null: text only), [itemMimes] = that uri's own
     * type from the content resolver (null: unknown), [clipMimes] = the types the clip declares.
     * An item with a known non-image type is not a photo; an unknown one counts when the clip declares an image.
     */
    fun imageItems(itemUris: List<String?>, itemMimes: List<String?>, clipMimes: List<String>): List<Int> {
        val clipHasImage = clipMimes.any(::isImageMime)
        return itemUris.indices.filter { i ->
            if (itemUris[i].isNullOrBlank()) return@filter false
            val own = itemMimes.getOrNull(i)
            if (own != null) isImageMime(own) else clipHasImage
        }
    }

    /** How many of [count] pasted photos fit, given [remaining] slots. */
    fun fits(count: Int, remaining: Int): Int = minOf(count, remaining.coerceAtLeast(0))

    /** Said when a paste brought more photos than fit (null: all fit). */
    fun overflowMessage(count: Int, remaining: Int, max: Int): String? =
        if (count > remaining.coerceAtLeast(0)) "写真は $max 枚までです" else null

    /**
     * Whether a value from outside (a send cleared it, a mention was picked, a draft came back) must be written
     * into the field: only when its text or selection differs from what the field last reported. Then a value
     * that is merely the field's own echo never overwrites newer typing.
     */
    fun isOutsideChange(value: TextFieldValue, reported: TextFieldValue): Boolean =
        value.text != reported.text || value.selection != reported.selection
}

@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
/** The image uris in a pasted / inserted / dropped clip (in order), the rest left for the text field. */
private fun splitImages(context: Context, content: TransferableContent): Pair<List<Uri>, TransferableContent?> {
    val clip: ClipData = content.clipEntry.clipData
    val uris = (0 until clip.itemCount).map { clip.getItemAt(it).uri }
    val mimes = uris.map { u -> u?.let { runCatching { context.contentResolver.getType(it) }.getOrNull() } }
    val clipMimes = (0 until clip.description.mimeTypeCount).map { clip.description.getMimeType(it) }
    val picked = PasteImages.imageItems(uris.map { it?.toString() }, mimes, clipMimes).map { uris[it]!! }.toSet()
    if (picked.isEmpty()) return emptyList<Uri>() to content
    val rest = content.consume { item -> item.uri != null && item.uri in picked }
    return uris.filter { it != null && it in picked }.map { it!! } to rest
}

/**
 * Pasted images go to [photos] (at most [max], decoded like picked ones); null when photos can't be
 * attached here (editing, no capability), so the text field pastes text only.
 */
@Composable
fun rememberPasteImages(photos: ChatAttachments, max: Int, maxSide: Int, enabled: Boolean): ((List<Uri>) -> Unit)? {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    if (!enabled) return null
    return remember(photos, max, maxSide, context) {
        { uris ->
            val remaining = photos.remaining(max)
            val overflow = PasteImages.overflowMessage(uris.size, remaining, max)
            val take = uris.take(PasteImages.fits(uris.size, remaining))
            if (take.isEmpty()) photos.error = overflow
            else scope.launch {
                photos.add(context, take, max, maxSide)
                if (photos.error == null) photos.error = overflow
            }
        }
    }
}

/**
 * The composers' text field. The caller keeps its [TextFieldValue]; it is mirrored into a [TextFieldState]
 * so [onImages] (pasted / inserted / dropped images) works. Text paste and typing are unchanged.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun PhotoTextField(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    onImages: ((List<Uri>) -> Unit)?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    placeholder: @Composable (() -> Unit)? = null,
    maxLines: Int = 6,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    shape: Shape = RoundedCornerShape(20.dp),
    colors: TextFieldColors = TextFieldDefaults.colors(
        focusedIndicatorColor = Color.Transparent,
        unfocusedIndicatorColor = Color.Transparent,
        disabledIndicatorColor = Color.Transparent,
    ),
) {
    val context = LocalContext.current
    val state = remember { TextFieldState(value.text, value.selection) }
    // What the field last handed out (or took from outside): an echo of it is not an outside change.
    val reported = remember { arrayOf(value) }
    val change by rememberUpdatedState(onValueChange)
    val images by rememberUpdatedState(onImages)
    SideEffect {
        if (PasteImages.isOutsideChange(value, reported[0])) {
            reported[0] = value
            state.edit {
                replace(0, length, value.text)
                selection = TextRange(value.selection.start.coerceIn(0, value.text.length), value.selection.end.coerceIn(0, value.text.length))
            }
        }
    }
    LaunchedEffect(state) {
        snapshotFlow { TextFieldValue(state.text.toString(), state.selection, state.composition) }.collect { v ->
            if (v != reported[0]) {
                reported[0] = v
                change(v)
            }
        }
    }
    val receiver = Modifier.contentReceiver { content ->
        val attach = images ?: return@contentReceiver content
        val (uris, rest) = splitImages(context, content)
        if (uris.isNotEmpty()) attach(uris)
        rest
    }
    TextField(
        state = state,
        modifier = modifier.then(receiver),
        enabled = enabled,
        placeholder = placeholder,
        keyboardOptions = keyboardOptions,
        lineLimits = TextFieldLineLimits.MultiLine(maxHeightInLines = maxLines),
        shape = shape,
        colors = colors,
    )
}

/** 🖼️ (the system Photo Picker, no storage permission) and 📷 the camera, into [photos]. */
@Composable
fun PhotoAttachButtons(photos: ChatAttachments, max: Int, maxSide: Int, enabled: Boolean = true) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // The picker's limit is fixed per launcher; extra picks beyond the remaining slots are dropped in add().
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(max.coerceAtLeast(2))) { uris ->
        if (uris.isNotEmpty()) scope.launch { photos.add(context, uris, max, maxSide) }
    }
    val camera = rememberCameraCapture { ctx, uri -> photos.add(ctx, listOf(uri), max, maxSide) }
    val room = enabled && photos.remaining(max) > 0
    IconButton(onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, enabled = room) {
        Text("🖼️", fontSize = 20.sp, modifier = Modifier.alpha(if (room) 1f else 0.4f))
    }
    CameraButton(onClick = camera, enabled = room)
}
