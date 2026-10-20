package fm.backspace.bguru.chat

import android.content.res.Configuration
import android.view.KeyCharacterMap
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue

/*
 * Enter and newline in every text box (chat, chat edit, thread reply, new post).
 * The rule is docs/composer-keys.md (ドリキン 2026-10-19) — change that table first.
 *
 *   physical keyboard: Enter / Ctrl+Enter send (save while editing), ⇧Enter newline,
 *                      Enter with the @ list open picks the first name, Esc cancels an edit.
 *   on-screen keyboard: return is a newline; only the send button sends.
 *   a Japanese conversion is open: Enter only confirms it (the IME's).
 *
 * Physical or on-screen is read from the key event itself, not guessed from the screen:
 * an IME that sends KEYCODE_ENTER does so from the virtual keyboard device
 * (deviceId VIRTUAL_KEYBOARD, InputDevice.isVirtual, FLAG_SOFT_KEYBOARD).
 */

enum class EnterAction {
    /** Not ours: the IME confirms its conversion, or the text field inserts the newline. */
    PassThrough,
    Send,
    /** Insert "\n" at the cursor ourselves (⇧Enter on a hardware keyboard). */
    Newline,
    PickMention,
}

/** Plain logic of docs/composer-keys.md, unit-tested in LogicTest. */
fun decideEnter(
    composing: Boolean,
    physical: Boolean,
    shift: Boolean,
    ctrl: Boolean,
    mentionOpen: Boolean,
    editing: Boolean,
): EnterAction = when {
    composing -> EnterAction.PassThrough
    !physical -> EnterAction.PassThrough
    ctrl -> EnterAction.Send
    shift -> EnterAction.Newline
    mentionOpen && !editing -> EnterAction.PickMention
    else -> EnterAction.Send
}

/** True when the key came from a real keyboard (built-in or attached), not from an IME. */
fun KeyEvent.isPhysicalKey(): Boolean {
    val e = nativeKeyEvent
    if (e.deviceId == KeyCharacterMap.VIRTUAL_KEYBOARD) return false
    if (e.flags and android.view.KeyEvent.FLAG_SOFT_KEYBOARD != 0) return false
    val device = e.device ?: return false
    return !device.isVirtual
}

/** Multi-line with the default action, so the on-screen keyboard shows a return key
 *  that inserts a newline (never a send / done key). */
val ComposerKeyboardOptions = KeyboardOptions(imeAction = ImeAction.Default)

/** A hardware keyboard is attached and in use, so Enter sends and the hint is true. */
@Composable
fun hardwareKeyboardAttached(): Boolean {
    val c = LocalConfiguration.current
    return c.keyboard == Configuration.KEYBOARD_QWERTY && c.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO
}

/** The placeholder, with the key hint only when Enter actually sends. */
@Composable
fun composerPlaceholder(base: String): String =
    if (hardwareKeyboardAttached()) "$base（Enter 送信・⇧Enter 改行）" else base

/**
 * The one key handler every composer uses.
 * [onUp]: ↑ on a hardware keyboard (chat: edit the last message); return true if used.
 */
fun Modifier.composerKeys(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    onSend: () -> Unit,
    mentionOpen: Boolean = false,
    onPickMention: () -> Unit = {},
    editing: Boolean = false,
    onCancel: (() -> Unit)? = null,
    onUp: (() -> Boolean)? = null,
): Modifier = onPreviewKeyEvent { e ->
    if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
    // A Japanese conversion is open: Enter / ↑ / Esc belong to the IME.
    val composing = value.composition != null
    if (composing) return@onPreviewKeyEvent false
    val physical = e.isPhysicalKey()
    when (e.key) {
        Key.Enter, Key.NumPadEnter -> when (
            decideEnter(composing, physical, e.isShiftPressed, e.isCtrlPressed || e.isMetaPressed, mentionOpen, editing)
        ) {
            EnterAction.PassThrough -> false
            EnterAction.Send -> { onSend(); true }
            EnterAction.PickMention -> { onPickMention(); true }
            EnterAction.Newline -> { onValueChange(value.insertNewline()); true }
        }
        Key.Escape -> if (physical && editing && onCancel != null) { onCancel(); true } else false
        Key.DirectionUp -> if (physical && onUp != null) onUp() else false
        else -> false
    }
}

/** "\n" in place of the selection, cursor after it. */
fun TextFieldValue.insertNewline(): TextFieldValue {
    val start = minOf(selection.start, selection.end)
    val end = maxOf(selection.start, selection.end)
    val t = text.substring(0, start) + "\n" + text.substring(end)
    return TextFieldValue(t, TextRange(start + 1))
}
