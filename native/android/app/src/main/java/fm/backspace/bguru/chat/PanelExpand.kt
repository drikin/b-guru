package fm.backspace.bguru.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** ☗ 将棋と 🎮 散財ダッシュの「広げる」（rbtnn さんの要望 2026-11-08、Web の ⤢ と同じ考え方）。
 *  部室の広げると同じく、チャットの列の大半（RoomViewPrefs.expandedHeight、約 85%）を使う。
 *  変えるのは高さだけで、盤やゲームの部品は作り直さない（遊んでいる途中の回・盤が消えないように）。
 *  この起動の間だけ覚える（Web も閉じたら戻る）。 */
internal object PanelExpand {
    var shogi by mutableStateOf(false)
    var game by mutableStateOf(false)
}

/** パネルの右上に浮かべる ⤢／⤡（少し透ける。Web と同じ位置）。 */
@Composable
internal fun ExpandButton(expanded: Boolean, what: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(
        modifier
            .size(30.dp)
            .background(Color(0xBF1D1820), RoundedCornerShape(8.dp))
            .border(1.dp, Color(0x66F3E9D8), RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .semantics { contentDescription = if (expanded) "${what}を元の大きさに戻す" else "${what}を大きく表示" },
        contentAlignment = Alignment.Center,
    ) { Text(if (expanded) "⤡" else "⤢", color = Color(0xFFF3E9D8), fontSize = 15.sp) }
}
