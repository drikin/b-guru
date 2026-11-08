package fm.backspace.bguru.chat

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** The room's zoom (drikin 2026-11-08「部室のビューが狭すぎて全体が見にくい」): the scale is the automatic
 *  one (about 13 tiles across, an integer) × the member's own [scale]. At least the whole map fits
 *  (or the automatic scale, if that already shows it all), at most twice the automatic one. 1.0 = as before.
 *  The same rule as the Web, iPhone and Mac. Pure, so it is unit-tested. */
internal object RoomZoom {
    const val TILE = 16
    const val STEP = 1.25f
    const val MAX_FACTOR = 2f

    data class Scale(val zoom: Float, val auto: Float, val min: Float, val max: Float) {
        /** The member's scale this zoom is (what −/＋/pinch start from). */
        val scale get() = zoom / auto
        val minScale get() = min / auto
        val maxScale get() = max / auto
        /** Showing the whole map already (「全体」 is on). */
        val atFit get() = abs(zoom - min) < 0.005f * auto
    }

    /** The automatic integer scale of before: about 13 tiles across on a phone, more on a wide screen. */
    fun auto(wPx: Float, widthDp: Float, mapW: Int): Float =
        max(2, floor(wPx / (TILE * min(mapW.toFloat(), max(13f, widthDp / 46f)))).toInt()).toFloat()

    fun scale(wPx: Float, hPx: Float, widthDp: Float, mapW: Int, mapH: Int, scale: Float): Scale {
        val auto = auto(wPx, widthDp, mapW)
        val fit = min(wPx / (mapW * TILE), hPx / (mapH * TILE))
        val lo = min(fit, auto)
        val hi = max(auto * MAX_FACTOR, lo)
        val s = if (scale.isFinite() && scale > 0f) scale else 1f
        return Scale((auto * s).coerceIn(lo, hi), auto, lo, hi)
    }

    /** One axis of the camera (in map pixels): centred on [focus] (or the map's middle), kept inside the map,
     *  centred when the map is smaller than the view; snapped to whole screen pixels. */
    fun cam(focus: Float?, mapPx: Int, viewPx: Float, zoom: Float): Float {
        val v = viewPx / zoom
        val c = if (focus != null) focus - v / 2 else (mapPx - v) / 2
        val clamped = max(min(c, mapPx - v), min(0f, (mapPx - v) / 2))
        return (clamped * zoom).roundToInt() / zoom
    }

    /** The screen point → the tile under it. */
    fun tileAt(screen: Float, cam: Float, zoom: Float): Int = floor((screen / zoom + cam) / TILE).toInt()

    fun zoomIn(s: Scale) = (s.scale * STEP).coerceIn(s.minScale, s.maxScale)
    fun zoomOut(s: Scale) = (s.scale / STEP).coerceIn(s.minScale, s.maxScale)
    /** 「全体」: the whole map ↔ 1.0. */
    fun toggleFit(s: Scale) = if (s.atFit) 1f else s.minScale
    fun pinch(s: Scale, factor: Float) = (s.scale * factor).coerceIn(s.minScale, s.maxScale)

    /** The text (names, bubbles, labels) shrinks less than the art, so it stays readable zoomed out. */
    fun textZoom(s: Scale) = max(s.zoom, s.auto * 0.55f)
}

/** The member's room zoom and 「広げる」, kept on the device (SharedPreferences "room"). Compose state. */
internal class RoomViewPrefs private constructor(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    var scale by mutableFloatStateOf(prefs.getFloat(KEY_SCALE, 1f).takeIf { it.isFinite() && it > 0f } ?: 1f); private set
    var expanded by mutableStateOf(prefs.getBoolean(KEY_EXPANDED, false)); private set

    /** [save] false while a pinch is moving; saved when it ends. */
    fun changeScale(s: Float, save: Boolean = true) {
        scale = s
        if (save) prefs.edit().putFloat(KEY_SCALE, s).apply()
    }

    fun saveScale() = prefs.edit().putFloat(KEY_SCALE, scale).apply()

    fun toggleExpanded() {
        expanded = !expanded
        prefs.edit().putBoolean(KEY_EXPANDED, expanded).apply()
    }

    companion object {
        const val PREFS = "room"
        const val KEY_SCALE = "roomZoomScale"
        const val KEY_EXPANDED = "roomExpanded"
        @Volatile private var instance: RoomViewPrefs? = null
        fun get(context: Context): RoomViewPrefs =
            instance ?: synchronized(this) { instance ?: RoomViewPrefs(context).also { instance = it } }

        /** The room's share of the column when 広げた: most of it, a few lines of the chat (and the composer) left. */
        fun expandedHeight(columnDp: Float, minChatDp: Float = 140f): Float =
            min(columnDp * 0.85f, columnDp - minChatDp).coerceAtLeast(columnDp * 0.5f)
    }
}

@Composable
internal fun rememberRoomViewPrefs(): RoomViewPrefs {
    val context = LocalContext.current
    return remember(context) { RoomViewPrefs.get(context) }
}
