package fm.backspace.bguru.chat

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Guards against drawing tricks that some GPU drivers composite upside down (2026-10-21 report
 *  of the screen drawn flipped): no offscreen Compose layers, no forced View layers, no hardware
 *  bitmaps we draw ourselves. The screens are checked for real by scripts/orientation-check.sh. */
class RenderingGuardTest {
    private val banned = listOf(
        "CompositingStrategy.Offscreen" to "an offscreen layer (an intermediate texture)",
        "setLayerType(" to "a forced View layer (e.g. on the board / game WebView)",
        "Bitmap.Config.HARDWARE" to "a hardware bitmap",
        "ALLOCATOR_HARDWARE" to "a hardware bitmap",
    )

    @Test fun noRiskyLayers() {
        val dir = File("src/main/java").takeIf { it.isDirectory } ?: File("app/src/main/java")
        assertTrue("sources not found from ${File(".").absolutePath}", dir.isDirectory)
        val hits = dir.walkTopDown().filter { it.extension == "kt" }.flatMap { f ->
            f.readLines().mapIndexedNotNull { i, line ->
                val code = line.substringBefore("//")
                banned.firstOrNull { code.contains(it.first) }?.let { "${f.name}:${i + 1} ${it.second}: ${line.trim()}" }
            }
        }.toList()
        assertTrue("Do not use these (see RenderingGuardTest):\n" + hits.joinToString("\n"), hits.isEmpty())
    }
}
