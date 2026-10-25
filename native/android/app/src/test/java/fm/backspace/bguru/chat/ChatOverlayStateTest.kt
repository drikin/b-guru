package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** docs/chat-overlay-spec.md: one expanded at most, the others as chips, typing shrinks everything, back order. */
class ChatOverlayStateTest {
    private val W = ActivityId.WATCH
    private val O = ActivityId.OFFKAI
    private val S = ActivityId.SHOGI
    private val G = ActivityId.GAME
    private val R = ActivityId.ROOM

    @Test fun switchesShowSmallWindows() {
        val o = OverlayState()
        assertTrue(o.toggle(W))
        assertTrue(o.toggle(O))
        assertEquals(listOf(W, O), o.minis)
        assertNull(o.expandedNow)
        assertEquals(emptyList<ActivityId>(), o.chips())
        assertFalse(o.toggle(W))
        assertEquals(listOf(O), o.minis)
    }

    @Test fun gameOpensExpanded() {
        val o = OverlayState()
        o.toggle(G)
        assertEquals(G, o.expandedNow)
        assertEquals(emptyList<ActivityId>(), o.minis)
    }

    @Test fun onlyOneExpandedTheOthersAreChips() {
        val o = OverlayState()
        o.show(W); o.show(O); o.show(S)
        o.expand(S)
        assertEquals(S, o.expandedNow)
        assertEquals(emptyList<ActivityId>(), o.minis)
        assertEquals(listOf(W, O), o.chips())
        // A chip tapped: that one expanded, ☗ back among the chips.
        o.expand(O)
        assertEquals(O, o.expandedNow)
        assertEquals(listOf(W, S), o.chips())
        o.collapse()
        assertNull(o.expandedNow)
        assertEquals(listOf(W, O, S), o.minis)
    }

    @Test fun hidingTheExpandedOneClearsIt() {
        val o = OverlayState()
        o.show(S, expand = true)
        o.hide(S)
        assertNull(o.expanded)
        assertTrue(o.shown.isEmpty())
    }

    @Test fun typingShrinksEverythingAndComesBack() {
        val o = OverlayState()
        o.show(W); o.show(S, expand = true)
        o.typing = true
        assertNull(o.expandedNow)
        assertEquals(emptyList<ActivityId>(), o.minis)
        assertEquals(listOf(W, S), o.chips())
        o.typing = false
        assertEquals(S, o.expandedNow)
        assertEquals(listOf(W), o.chips())
    }

    @Test fun soundStillPlayingStaysAsAChip() {
        val o = OverlayState()
        o.show(W)
        o.hide(W) // 📺 switched off with a video on: no window, a chip
        assertEquals(listOf(W), o.chips(sticky = setOf(W)))
        assertEquals(emptyList<ActivityId>(), o.minis)
        // Shown windows are not doubled as chips.
        o.show(O)
        assertEquals(listOf(W), o.chips(sticky = setOf(W, O)))
        o.typing = true
        assertEquals(listOf(O, W), o.chips(sticky = setOf(W, O)))
    }

    @Test fun backCollapsesFirstThenClosesTheTopWindow() {
        val o = OverlayState()
        o.show(R); o.show(O); o.expand(R)
        assertEquals(OverlayState.BackStep.Collapse, o.backTarget())
        o.collapse()
        assertEquals(OverlayState.BackStep.Hide(O), o.backTarget())
        o.hide(O)
        assertEquals(OverlayState.BackStep.Hide(R), o.backTarget())
        o.hide(R)
        assertNull(o.backTarget())
    }

    @Test fun backDoesNothingWhileTyping() {
        val o = OverlayState()
        o.show(W)
        o.typing = true
        assertNull(o.backTarget())
    }

    @Test fun outsideOpenSwitchesOnAndExpands() {
        val o = OverlayState()
        o.storeOpened(S, true) // a push / the chat's ☗ card
        assertTrue(o.isShown(S))
        assertEquals(S, o.expandedNow)
        o.storeOpened(S, false)
        assertFalse(o.isShown(S))
    }

    @Test fun ownOpenIsNotExpandedAndSwitchedOffStaysOff() {
        val o = OverlayState()
        o.show(W) // the switch, then the store opens
        o.storeOpened(W, true)
        assertNull(o.expandedNow)
        o.hide(W) // switched off, the player kept (video on): the same `open` again does not bring it back
        o.storeOpened(W, true)
        assertFalse(o.isShown(W))
    }

    @Test fun positionsArePersistedAndClamped() {
        val saved = HashMap<ActivityId, Pair<Float, Float>>()
        val store = object : OverlayPositions {
            override fun load(id: ActivityId) = saved[id]
            override fun save(id: ActivityId, x: Float, y: Float) { saved[id] = x to y }
        }
        val o = OverlayState(store)
        assertNull(o.position(W))
        o.moveTo(W, 30f, 40f)
        assertEquals(30f to 40f, saved[W])
        assertEquals(30f to 40f, OverlayState(store).position(W))
        assertEquals(184f to 0f, OverlayState.clamp(500f, -20f, 176f, 120f, 360f, 500f))
        assertEquals(0f to 0f, OverlayState.clamp(10f, 10f, 400f, 600f, 360f, 500f))
    }

    @Test fun keysForTheDemo() {
        assertEquals(listOf(W, O), ActivityId.list("watch, offkai,bogus,watch"))
        assertEquals(emptyList<ActivityId>(), ActivityId.list(null))
    }
}
