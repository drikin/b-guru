package fm.backspace.bguru.chat

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import org.junit.Assert.assertEquals
import org.junit.Test

/** docs/composer-keys.md, the table. */
class ComposerKeysTest {
    private fun d(
        composing: Boolean = false, physical: Boolean = true, shift: Boolean = false,
        ctrl: Boolean = false, mentionOpen: Boolean = false, editing: Boolean = false,
    ) = decideEnter(composing, physical, shift, ctrl, mentionOpen, editing)

    @Test fun physicalKeyboard() {
        assertEquals(EnterAction.Send, d())
        assertEquals(EnterAction.Newline, d(shift = true))
        assertEquals(EnterAction.Send, d(ctrl = true))
        assertEquals(EnterAction.Send, d(ctrl = true, shift = true))
        assertEquals(EnterAction.PickMention, d(mentionOpen = true))
        assertEquals(EnterAction.Newline, d(mentionOpen = true, shift = true))
        assertEquals(EnterAction.Send, d(editing = true))          // save
        assertEquals(EnterAction.Send, d(editing = true, mentionOpen = true))
    }

    @Test fun conversionOpenOnlyConfirms() {
        for (physical in listOf(true, false)) for (shift in listOf(true, false)) for (ctrl in listOf(true, false))
            for (m in listOf(true, false)) for (e in listOf(true, false))
                assertEquals(EnterAction.PassThrough, d(composing = true, physical = physical, shift = shift, ctrl = ctrl, mentionOpen = m, editing = e))
    }

    @Test fun onScreenKeyboardReturnIsANewline() {
        // PassThrough: the text field inserts the newline itself; nothing is sent.
        for (shift in listOf(true, false)) for (ctrl in listOf(true, false))
            for (m in listOf(true, false)) for (e in listOf(true, false))
                assertEquals(EnterAction.PassThrough, d(physical = false, shift = shift, ctrl = ctrl, mentionOpen = m, editing = e))
    }

    @Test fun newlineAtTheCursor() {
        assertEquals(TextFieldValue("ab\ncd", TextRange(3)), TextFieldValue("abcd", TextRange(2)).insertNewline())
        assertEquals(TextFieldValue("a\nd", TextRange(2)), TextFieldValue("abcd", TextRange(3, 1)).insertNewline())
        assertEquals(TextFieldValue("abcd\n", TextRange(5)), TextFieldValue("abcd", TextRange(4)).insertNewline())
    }
}
