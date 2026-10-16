package fm.backspace.bguru.chat

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** B-guru's green (same as the web and the Apple apps). */
val AccentGreen = Color(0xFF16A34A)

@Composable
fun BguruTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val scheme = if (dark) darkColorScheme(primary = Color(0xFF4ADE80), onPrimary = Color(0xFF052E16))
                 else lightColorScheme(primary = AccentGreen, onPrimary = Color.White)
    MaterialTheme(colorScheme = scheme, content = content)
}
