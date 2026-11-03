package fm.backspace.bguru.chat

import android.content.ActivityNotFoundException
import android.content.Context
import android.graphics.Bitmap
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.max

/** Takes a photo with the camera app (ActivityResultContracts.TakePicture, so no CAMERA
 *  permission) into cacheDir/camera/, shows it with the 「五撮 Vol.1」 switch
 *  (`CameraReviewDialog`), and hands a content:// Uri to `attach`, the same path a picked
 *  photo takes (resize, EXIF rotation, re-encode, the photo limit). With the switch off that
 *  is the shot itself; with it on, the filtered JPEG. The files are deleted once `attach`
 *  returns; nothing is saved to shared storage or the gallery. */
@Composable
fun rememberCameraCapture(attach: suspend (Context, Uri) -> Unit): () -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // Survives the activity being recreated while the camera app is in front.
    var pending by rememberSaveable { mutableStateOf<String?>(null) }
    // The shot being looked at (before 「追加」 / 「やめる」).
    var review by rememberSaveable { mutableStateOf<String?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val path = pending ?: return@rememberLauncherForActivityResult
        pending = null
        val file = File(path)
        if (!ok || !file.exists() || file.length() == 0L) { file.delete(); return@rememberLauncherForActivityResult }
        review = path
    }
    review?.let { path ->
        CameraReviewDialog(
            file = File(path),
            scope = scope,
            onCancel = { review = null; scope.launch(Dispatchers.IO) { File(path).delete() } },
            onAdd = { filtered ->
                review = null
                scope.launch {
                    val shot = File(path)
                    // 五撮: the filtered JPEG goes through the ordinary photo path instead of the shot.
                    val out = filtered?.let { withContext(Dispatchers.IO) { runCatching { CameraFiles.writeJpeg(context, it) }.getOrNull() } }
                    try { attach(context, CameraFiles.uri(context, out ?: shot)) }
                    finally { withContext(Dispatchers.IO) { shot.delete(); out?.delete() } }
                }
            },
        )
    }
    return {
        val file = CameraFiles.newFile(context)
        pending = file.path
        try {
            launcher.launch(CameraFiles.uri(context, file))
        } catch (e: ActivityNotFoundException) {
            pending = null
            file.delete()
            Toast.makeText(context, "カメラのアプリが見つかりません", Toast.LENGTH_SHORT).show()
        } catch (e: SecurityException) {
            pending = null
            file.delete()
            Toast.makeText(context, "カメラを開けませんでした", Toast.LENGTH_SHORT).show()
        }
    }
}

/** The shot, large, with the 「五撮 Vol.1」 switch (drikin 2026-11-03: 撮ったあとに五撮をかけるか選べる、
 *  端末の中でかける・全員). The switch starts where it was last left when adding (first time: off).
 *  With it on, the preview is the filtered photo — made once, off the main thread, from the shot
 *  decoded at most 2048 px with the EXIF rotation, in the shot's own colour space. `onAdd` gets the
 *  filtered bitmap, or null for the shot as it is. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CameraReviewDialog(file: File, scope: CoroutineScope, onCancel: () -> Unit, onAdd: (Bitmap?) -> Unit) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences(CameraFiles.PREFS, Context.MODE_PRIVATE) }
    var on by rememberSaveable { mutableStateOf(prefs.getBoolean(CameraFiles.PREF_GOSATSU, false)) }
    val shot by produceState<Result<Bitmap>?>(null, file) {
        value = withContext(Dispatchers.IO) { runCatching { CameraFiles.decode(file) } }
    }
    // Started once (the first time it is needed) and kept while the dialog is open: switching
    // off and on again never runs the filter twice.
    var job by remember(file) { mutableStateOf<Deferred<Result<Bitmap>>?>(null) }
    val original = shot?.getOrNull()
    LaunchedEffect(on, original) {
        if (on && original != null && job == null) {
            job = scope.async(Dispatchers.Default) { runCatching { CameraFiles.gosatsu(original) } }
        }
    }
    val filtered by produceState<Result<Bitmap>?>(null, job) { value = job?.await() }
    val busy = on && original != null && filtered == null
    val failed = shot?.isFailure == true || (on && filtered?.isFailure == true)
    // While the filter runs, the shot itself stays on screen, dimmed under the spinner.
    val showing = if (on) filtered?.getOrNull() ?: original else original

    Dialog(onDismissRequest = onCancel, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        // Edge to edge like the post editor: the bars' icons dark on the light sheet and light on the dark one.
        val view = androidx.compose.ui.platform.LocalView.current
        val dark = androidx.compose.foundation.isSystemInDarkTheme()
        LaunchedEffect(view, dark) {
            (view.parent as? androidx.compose.ui.window.DialogWindowProvider)?.window?.let { w ->
                androidx.core.view.WindowCompat.getInsetsController(w, view).apply {
                    isAppearanceLightStatusBars = !dark
                    isAppearanceLightNavigationBars = !dark
                }
            }
        }
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.systemBars.union(WindowInsets.displayCutout))) {
                TopAppBar(windowInsets = WindowInsets(0),
                    title = { Text("写真を追加") },
                    navigationIcon = { TextButton(onClick = onCancel) { Text("やめる") } },
                    actions = {
                        TextButton(enabled = shot != null && !busy && !(on && filtered?.isFailure == true), onClick = {
                            prefs.edit().putBoolean(CameraFiles.PREF_GOSATSU, on).apply()
                            onAdd(if (on) filtered?.getOrNull() else null)
                        }) { Text("追加") }
                    },
                )
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    showing?.let {
                        Image(it.asImageBitmap(), contentDescription = if (on && !busy) "五撮 Vol.1 をかけた写真" else "撮った写真",
                            contentScale = ContentScale.Fit, alpha = if (busy) 0.4f else 1f, modifier = Modifier.fillMaxSize())
                    }
                    if (shot == null || busy) CircularProgressIndicator()
                }
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("五撮 Vol.1", style = MaterialTheme.typography.titleMedium)
                            Text(if (busy) "仕上げています…" else "フィルムの粒子と高い解像感のフィルター",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Switch(checked = on, onCheckedChange = { on = it }, enabled = original != null,
                            modifier = Modifier.semantics { contentDescription = "五撮 Vol.1 をかける" })
                    }
                    if (failed) {
                        Text(if (shot?.isFailure == true) "写真を読めませんでした（そのまま追加できます）" else "五撮をかけられませんでした",
                            color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}

/** The camera button next to the photo button. */
@Composable
fun CameraButton(onClick: () -> Unit, enabled: Boolean, modifier: Modifier = Modifier) {
    IconButton(onClick = onClick, enabled = enabled, modifier = modifier) {
        Icon(
            painterResource(R.drawable.ic_photo_camera),
            contentDescription = "カメラで撮る",
            modifier = Modifier.size(22.dp),
            tint = LocalContentColor.current,
        )
    }
}

private object CameraFiles {
    const val PREFS = "camera"
    const val PREF_GOSATSU = "gosatsu"
    private const val MAX_SIDE = 2048
    private const val QUALITY = 95

    private fun dir(context: Context) = File(context.cacheDir, "camera").apply { mkdirs() }

    /** A fresh file; shots left behind by an earlier, abandoned capture are removed. */
    fun newFile(context: Context): File {
        val dir = dir(context)
        val stale = System.currentTimeMillis() - 60 * 60 * 1000
        dir.listFiles()?.forEach { if (it.lastModified() < stale) it.delete() }
        return File(dir, "shot-${System.currentTimeMillis()}.jpg")
    }

    fun uri(context: Context, file: File): Uri =
        FileProvider.getUriForFile(context, "${context.packageName}.camera", file)

    /** At most 2048 px on the long side, EXIF rotation applied (ImageDecoder), a software
     *  ARGB_8888 bitmap in the photo's own colour space (Display P3 stays P3). */
    fun decode(file: File): Bitmap {
        val bmp = ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { decoder, info, _ ->
            val w = info.size.width
            val h = info.size.height
            val scale = minOf(1.0, MAX_SIDE.toDouble() / max(w, h))
            decoder.setTargetSize((w * scale).toInt().coerceAtLeast(1), (h * scale).toInt().coerceAtLeast(1))
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        return if (bmp.config == Bitmap.Config.ARGB_8888) bmp else bmp.copy(Bitmap.Config.ARGB_8888, false)
    }

    /** 五撮 Vol.1 on the raw pixel values (copyPixelsToBuffer / FromBuffer: getPixels would turn
     *  them into sRGB and the filter's measurements would drift), same colour space out. */
    fun gosatsu(src: Bitmap): Bitmap {
        val w = src.width
        val h = src.height
        val bmp = if (src.rowBytes == w * 4) src else src.copy(Bitmap.Config.ARGB_8888, false)
        val raw = ByteBuffer.allocate(bmp.rowBytes * h)
        bmp.copyPixelsToBuffer(raw)
        val out = Gosatsu.applyRgba(raw.array(), w, h)
        val space = bmp.colorSpace?.takeIf { it.model == ColorSpace.Model.RGB } ?: ColorSpace.get(ColorSpace.Named.SRGB)
        return Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888, false, space).apply {
            copyPixelsFromBuffer(ByteBuffer.wrap(out))
        }
    }

    /** The filtered photo as a JPEG (quality 95, its colour profile kept) next to the shot. */
    fun writeJpeg(context: Context, bitmap: Bitmap): File {
        val file = File(dir(context), "gosatsu-${System.currentTimeMillis()}.jpg")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, QUALITY, it) }
        return file
    }
}
