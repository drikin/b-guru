package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Test

/** ✉️ is a tab right after 💬 (「アプリ版の DM を素直にチャットの右のタブに移動」 2026-11-08). */
class MainTabsTest {
    @Test fun phonePagesInOrder() {
        assertEquals(listOf(MainTab.TIMELINE, MainTab.CHAT, MainTab.DM, MainTab.JUKEBOX), MainTabs.pages(dm = true, jukebox = true))
        assertEquals(listOf(MainTab.TIMELINE, MainTab.CHAT, MainTab.DM), MainTabs.pages(dm = true, jukebox = false))
        assertEquals(listOf(MainTab.TIMELINE, MainTab.CHAT, MainTab.JUKEBOX), MainTabs.pages(dm = false, jukebox = true))
        assertEquals(listOf(MainTab.TIMELINE, MainTab.CHAT), MainTabs.pages(dm = false, jukebox = false))
    }

    @Test fun pageIndexesFollowWhatIsOn() {
        // The chat stays page 1 (its room / ☗ clock run while page 1 is on screen).
        assertEquals(1, MainTabs.pageOf(MainTab.CHAT, dm = true, jukebox = true))
        assertEquals(2, MainTabs.pageOf(MainTab.DM, dm = true, jukebox = true))
        assertEquals(3, MainTabs.pageOf(MainTab.JUKEBOX, dm = true, jukebox = true))
        assertEquals(2, MainTabs.pageOf(MainTab.JUKEBOX, dm = false, jukebox = true))
        assertEquals(-1, MainTabs.pageOf(MainTab.DM, dm = false, jukebox = true))
        assertEquals(-1, MainTabs.pageOf(MainTab.JUKEBOX, dm = true, jukebox = false))
    }

    // 部活一覧（リュー 2026-11-09 → オーナー「全アプリに作る」）: a page left of the timeline, not in the switch.
    @Test fun clubListIsLeftOfTheTimelineAndNotInTheSwitch() {
        assertEquals(listOf(MainTab.CLUBS, MainTab.TIMELINE, MainTab.CHAT, MainTab.DM, MainTab.JUKEBOX), MainTabs.pages(dm = true, jukebox = true, clubs = true))
        assertEquals(0, MainTabs.pageOf(MainTab.CLUBS, dm = true, jukebox = true, clubs = true))
        assertEquals(1, MainTabs.pageOf(MainTab.TIMELINE, dm = true, jukebox = true, clubs = true))
        // The app starts on 💬, now page 2.
        assertEquals(2, MainTabs.pageOf(MainTab.CHAT, dm = false, jukebox = false, clubs = true))
        assertEquals(3, MainTabs.pageOf(MainTab.DM, dm = true, jukebox = true, clubs = true))
        assertEquals(4, MainTabs.pageOf(MainTab.JUKEBOX, dm = true, jukebox = true, clubs = true))
        assertEquals(listOf(MainTab.TIMELINE, MainTab.CHAT, MainTab.DM, MainTab.JUKEBOX), MainTabs.switchTabs(dm = true, jukebox = true))
        assertEquals(listOf(MainTab.CHAT, MainTab.DM), MainTabs.right(dm = true, jukebox = false))
    }

    @Test fun wideRightSideSwitch() {
        assertEquals(listOf(MainTab.CHAT, MainTab.DM, MainTab.JUKEBOX), MainTabs.right(dm = true, jukebox = true))
        assertEquals(listOf(MainTab.CHAT, MainTab.DM), MainTabs.right(dm = true, jukebox = false))
        assertEquals(listOf(MainTab.CHAT), MainTabs.right(dm = false, jukebox = false))
    }
}
