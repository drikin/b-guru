package fm.backspace.bguru.chat

import android.content.ActivityNotFoundException
import android.content.Context
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/** Takes a photo with the camera app (ActivityResultContracts.TakePicture, so no CAMERA
 *  permission) into cacheDir/camera/ and hands its content:// Uri to `attach`, the same
 *  path a picked photo takes (resize, EXIF rotation, re-encode, the photo limit). The
 *  file is deleted once `attach` returns; nothing is saved to shared storage or the gallery. */
@Composable
fun rememberCameraCapture(attach: suspend (Context, Uri) -> Unit): () -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // Survives the activity being recreated while the camera app is in front.
    var pending by rememberSaveable { mutableStateOf<String?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val path = pending ?: return@rememberLauncherForActivityResult
        pending = null
        val file = File(path)
        if (!ok || !file.exists() || file.length() == 0L) { file.delete(); return@rememberLauncherForActivityResult }
        scope.launch {
            try { attach(context, CameraFiles.uri(context, file)) }
            finally { withContext(Dispatchers.IO) { file.delete() } }
        }
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
}
