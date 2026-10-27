package fm.backspace.bguru.chat

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/** 送る直前の絵文字の画像（縮めた PNG か、そのままの GIF）。 */
class PreparedEmoji(val bytes: ByteArray, val mime: String, val preview: ImageBitmap, val suggestedName: String?)

/** 端末で縮める: GIF は 256KB 以下ならそのまま、それ以外は 1 枚目を長辺 128px の PNG に（EXIF の向きは
 *  ImageDecoder が直す。位置情報などは PNG に作り直すので端末から出ない）。読めないときは例外。 */
suspend fun prepareCustomEmoji(context: Context, uri: Uri): PreparedEmoji = withContext(Dispatchers.IO) {
    val cr = context.contentResolver
    val displayName = runCatching {
        cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    }.getOrNull()
    val raw = cr.openInputStream(uri)?.use { input ->
        val out = ByteArrayOutputStream()
        val buf = ByteArray(64 * 1024)
        var total = 0
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            total += n
            if (total > CustomEmojiRules.SOURCE_MAX_BYTES) throw IllegalArgumentException("画像が大きすぎます")
            out.write(buf, 0, n)
        }
        out.toByteArray()
    } ?: throw IllegalArgumentException("画像を読めませんでした")
    val mime = CustomEmojiRules.sniffMime(raw.copyOf(minOf(raw.size, 16)), cr.getType(uri))
    // 1 枚目を長辺 128px 以下で（プレビューにも使う）
    val bmp = ImageDecoder.decodeBitmap(ImageDecoder.createSource(java.nio.ByteBuffer.wrap(raw))) { decoder, info, _ ->
        val (w, h) = CustomEmojiRules.fit(info.size.width, info.size.height)
        decoder.setTargetSize(w, h)
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE // compress() needs a software bitmap
    }
    val name = CustomEmojiRules.suggestName(displayName)
    when (CustomEmojiRules.chooseOutput(mime, raw.size.toLong())) {
        CustomEmojiRules.Output.GIF -> PreparedEmoji(raw, "image/gif", bmp.asImageBitmap(), name)
        CustomEmojiRules.Output.PNG -> {
            val png = ByteArrayOutputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it); it.toByteArray() }
            if (png.size > CustomEmojiRules.MAX_BYTES) throw IllegalArgumentException("画像は256KBまでです")
            PreparedEmoji(png, "image/png", bmp.asImageBitmap(), name)
        }
    }
}

private fun apiErrorText(e: Throwable, deleting: Boolean): String = when (e) {
    is ApiError.Http -> CustomEmojiRules.errorText(e.status, e.code, e.serverMessage, deleting)
    is ApiError.Unauthorized -> CustomEmojiRules.errorText(401, e.code, null, deleting)
    else -> CustomEmojiRules.errorText(null, null, null, deleting)
}

/** ピッカーの「＋ 登録」: 画像を選ぶ → 名前（その場で確かめる）→ 送る。うまくいったら一覧を読み直す。 */
@Composable
fun CustomEmojiRegisterDialog(api: ApiClient, registerPath: String, listPath: String?, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var image by remember { mutableStateOf<PreparedEmoji?>(null) }
    var preparing by remember { mutableStateOf(false) }
    var nameText by remember { mutableStateOf("") }
    var touched by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        preparing = true
        error = null
        scope.launch {
            runCatching { prepareCustomEmoji(context, uri) }
                .onSuccess { p ->
                    image = p
                    if (nameText.isBlank()) p.suggestedName?.let { nameText = it }
                }
                .onFailure { image = null; error = (it as? IllegalArgumentException)?.message ?: "この画像は使えません" }
            preparing = false
        }
    }
    val name = CustomEmojiRules.normalize(nameText)
    val nameError = CustomEmojiRules.nameError(name, EmojiCatalog.urls.keys)
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("カスタム絵文字を登録") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Box(Modifier.size(64.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
                        val p = image
                        if (p != null) Image(p.preview, "選んだ画像", Modifier.size(48.dp), contentScale = ContentScale.Fit)
                        else Text(if (preparing) "…" else "画像", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    OutlinedButton(onClick = { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, enabled = !busy && !preparing) {
                        Text(if (image == null) "画像を選ぶ" else "選び直す")
                    }
                }
                OutlinedTextField(
                    nameText,
                    { v -> nameText = v.take(CustomEmojiRules.NAME_MAX + 2); touched = true; error = null },
                    label = { Text("名前") },
                    prefix = { Text(":") },
                    suffix = { Text(":") },
                    singleLine = true,
                    isError = touched && nameError != null,
                    supportingText = { Text(if (touched && nameError != null) nameError else "英小文字・数字・_、${CustomEmojiRules.NAME_MAX} 文字まで") },
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, keyboardType = KeyboardType.Ascii, autoCorrectEnabled = false),
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text("長辺 128px の PNG に縮めて送ります（GIF は 256KB までならそのまま）。", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("キャンセル") } },
        confirmButton = {
            Button(
                onClick = {
                    val p = image ?: return@Button
                    busy = true
                    error = null
                    scope.launch {
                        runCatching { api.registerCustomEmoji(registerPath, name, p.bytes, p.mime) }
                            .onSuccess {
                                EmojiCatalog.load(api, listPath, force = true)
                                busy = false
                                onDismiss()
                            }
                            .onFailure { busy = false; error = apiErrorText(it, deleting = false) }
                    }
                },
                enabled = !busy && !preparing && image != null && nameError == null,
                colors = ButtonDefaults.buttonColors(containerColor = AccentGreen),
            ) { Text(if (busy) "登録中…" else "登録する") }
        },
    )
}

/** 長押しの「:name: を削除」: 確かめてから DELETE。その絵文字のリアクションも消える。 */
@Composable
fun CustomEmojiDeleteDialog(api: ApiClient, deleteTemplate: String, listPath: String?, name: String, id: Long, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var error by remember(id) { mutableStateOf<String?>(null) }
    var busy by remember(id) { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(CustomEmojiRules.deleteTitle(name)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(CustomEmojiRules.deleteBody(name))
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("キャンセル") } },
        confirmButton = {
            Button(
                onClick = {
                    busy = true
                    error = null
                    scope.launch {
                        val r = runCatching { api.deleteCustomEmoji(deleteTemplate, id) }
                        val e = r.exceptionOrNull()
                        // 404 = 誰かが先に消していた。どちらも一覧を読み直して閉じる。
                        if (e == null || (e is ApiError.Http && e.status == 404)) {
                            EmojiCatalog.load(api, listPath, force = true)
                            busy = false
                            onDismiss()
                        } else {
                            busy = false
                            error = apiErrorText(e, deleting = true)
                        }
                    }
                },
                enabled = !busy,
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
            ) { Text(if (busy) "削除中…" else "削除する") }
        },
    )
}
