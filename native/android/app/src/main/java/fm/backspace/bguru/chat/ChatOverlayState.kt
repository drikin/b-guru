package fm.backspace.bguru.chat

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/*
 * チャットの上に機能を重ねる形 (docs/chat-overlay-spec.md), behind capabilities `chat_overlay.enabled`.
 * The chat's second row is only switches; a switch on puts that feature in a small window over the chat
 * (any number of them, draggable), ⤢ expands one (at most one at a time) and the others shrink to chips,
 * typing shrinks every window to a chip. This file is the state only (no UI, unit-tested in
 * ChatOverlayStateTest); ChatOverlay.kt draws it and bridges it to the feature stores.
 */

/** The features that can sit over the chat, in the order of the switches. */
enum class ActivityId(val key: String) {
    ROOM("room"), SHOGI("shogi"), GAME("game"), WATCH("watch"), OFFKAI("offkai");

    companion object {
        fun of(key: String): ActivityId? = entries.firstOrNull { it.key == key.trim().lowercase() }
        /** `watch,offkai` (the demo's extras). */
        fun list(keys: String?): List<ActivityId> = keys?.split(',')?.mapNotNull(::of)?.distinct() ?: emptyList()
    }
}

/** Where each small window was left (dp from the top-left of the chat's message area), kept on this device. */
interface OverlayPositions {
    fun load(id: ActivityId): Pair<Float, Float>?
    fun save(id: ActivityId, x: Float, y: Float)

    object None : OverlayPositions {
        override fun load(id: ActivityId): Pair<Float, Float>? = null
        override fun save(id: ActivityId, x: Float, y: Float) = Unit
    }

    class Prefs(context: Context) : OverlayPositions {
        private val prefs = context.applicationContext.getSharedPreferences("chat_overlay", Context.MODE_PRIVATE)
        override fun load(id: ActivityId): Pair<Float, Float>? {
            if (!prefs.contains("x_${id.key}")) return null
            return prefs.getFloat("x_${id.key}", 0f) to prefs.getFloat("y_${id.key}", 0f)
        }
        override fun save(id: ActivityId, x: Float, y: Float) {
            prefs.edit().putFloat("x_${id.key}", x).putFloat("y_${id.key}", y).apply()
        }
    }
}

/** Which windows are over the chat. Main thread (Compose state). */
class OverlayState(private val positions: OverlayPositions = OverlayPositions.None) {
    /** Switched on, in the order they were switched on (the last is "on top"). */
    var shown by mutableStateOf<List<ActivityId>>(emptyList()); private set
    /** The one that is expanded (at most one), or none. */
    var expanded by mutableStateOf<ActivityId?>(null); private set
    /** The member is typing (composer focused with the keyboard up): every window is a chip. */
    var typing by mutableStateOf(false)

    private val moved = mutableStateMapOf<ActivityId, Pair<Float, Float>>()
    /** The stores' own `open` as last seen (see [storeOpened]). */
    private val storeOpen = HashMap<ActivityId, Boolean>()

    fun isShown(id: ActivityId) = id in shown

    /** Switch on (no-op when on); `expand` also makes it the expanded one. */
    fun show(id: ActivityId, expand: Boolean = false) {
        if (id !in shown) shown = shown + id
        if (expand) expanded = id
    }

    /** Switch off: the window goes (a sound it plays is the bridge's business). */
    fun hide(id: ActivityId) {
        if (id in shown) shown = shown - id
        if (expanded == id) expanded = null
    }

    /** The switch: on ⇄ off. True when it is now on. 🎮 opens expanded (too small to play otherwise). */
    fun toggle(id: ActivityId, opensExpanded: Boolean = id == ActivityId.GAME): Boolean {
        if (id in shown) { hide(id); return false }
        show(id, expand = opensExpanded)
        return true
    }

    /** ⤢ on a small window, or a chip: that one expanded, the one before back to small. */
    fun expand(id: ActivityId) = show(id, expand = true)

    /** ⤡: back to a small window. */
    fun collapse() { expanded = null }

    /** Small windows to draw now. */
    val minis: List<ActivityId> get() = if (typing || expanded != null) emptyList() else shown

    /** The expanded window to draw now. */
    val expandedNow: ActivityId? get() = if (typing) null else expanded

    /**
     * Chips to draw now: while typing every shown window; while one is expanded the other shown ones; and
     * always the features still playing sound though switched off (`sticky`: 📺 playing, 🍻 listening,
     * 🏠 in the room's voice) — tapping a chip expands it.
     */
    fun chips(sticky: Set<ActivityId> = emptySet()): List<ActivityId> {
        val extra = sticky.filter { it !in shown }.sortedBy { it.ordinal }
        return when {
            typing -> shown + extra
            expanded != null -> shown.filter { it != expanded } + extra
            else -> extra
        }
    }

    /** What the back button does now: collapse the expanded one, else switch off the top window. */
    fun backTarget(): BackStep? = when {
        typing -> null
        expanded != null -> BackStep.Collapse
        shown.isNotEmpty() -> BackStep.Hide(shown.last())
        else -> null
    }

    sealed interface BackStep {
        data object Collapse : BackStep
        data class Hide(val id: ActivityId) : BackStep
    }

    /**
     * A store's own `open` changed (a push, the chat's ☗ card, 「みんなで見る」, the demo): opened from
     * outside → switched on and expanded; closed from outside → switched off. Only transitions count, so
     * a window switched off while its store stays open (📺 still playing) is not brought back.
     */
    fun storeOpened(id: ActivityId, open: Boolean) {
        val was = storeOpen[id] ?: false
        storeOpen[id] = open
        if (open == was) return
        if (open && id !in shown) show(id, expand = true)
        else if (!open && id in shown) hide(id)
    }

    /** Where the small window of `id` is (dp), or null for its default place. */
    fun position(id: ActivityId): Pair<Float, Float>? = moved[id] ?: positions.load(id)?.also { moved[id] = it }

    fun moveTo(id: ActivityId, x: Float, y: Float, persist: Boolean = true) {
        moved[id] = x to y
        if (persist) positions.save(id, x, y)
    }

    companion object {
        /** A window dragged to (x, y) stays inside the area: dp, top-left of a w × h window in an aw × ah area. */
        fun clamp(x: Float, y: Float, w: Float, h: Float, aw: Float, ah: Float): Pair<Float, Float> =
            x.coerceIn(0f, (aw - w).coerceAtLeast(0f)) to y.coerceIn(0f, (ah - h).coerceAtLeast(0f))
    }
}
