package fm.backspace.bguru.chat

import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** The prototype's palette (warm paper and wood), light and dark. */
@Immutable
data class JbColors(
    val bg: Color, val panel: Color, val ink: Color, val sub: Color, val line: Color,
    val wood1: Color, val wood2: Color, val plinth: Color, val platter: Color,
    val accent: Color, val accentInk: Color, val chip: Color, val chipOn: Color, val chipOnInk: Color,
)

private val LightJb = JbColors(
    Color(0xFFF3ECE1), Color(0xFFFBF7F0), Color(0xFF2A2118), Color(0xFF7A6A58), Color(0xFFE2D6C4),
    Color(0xFFA8784F), Color(0xFF7C5434), Color(0xFF3A2A1E), Color(0xFF26201B),
    Color(0xFF16A34A), Color.White, Color(0xFFEFE5D6), Color(0xFF2A2118), Color(0xFFFBF7F0),
)
private val DarkJb = JbColors(
    Color(0xFF14110E), Color(0xFF1D1915), Color(0xFFF1E8DC), Color(0xFFA8988A), Color(0xFF2F2822),
    Color(0xFF6E4B2F), Color(0xFF4A3120), Color(0xFF0D0B09), Color(0xFF0F0D0B),
    Color(0xFF22C55E), Color(0xFF06210F), Color(0xFF2A241E), Color(0xFFF1E8DC), Color(0xFF14110E),
)

@Composable
fun jbColors(): JbColors = if (isSystemInDarkTheme()) DarkJb else LightJb

/** Android's "remove animations" (animator duration scale 0): the record does not turn. */
@Composable
fun reduceMotion(): Boolean {
    val context = LocalContext.current
    return remember { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }
}

/** Degrees the record has turned: 33⅓ rpm (1.8 s a turn) while [spinning]. Read it inside
 *  graphicsLayer {} so only the layer redraws each frame. */
@Composable
fun rememberSpin(spinning: Boolean): () -> Float {
    val angle = remember { mutableFloatStateOf(0f) }
    LaunchedEffect(spinning) {
        if (!spinning) return@LaunchedEffect
        var last = 0L
        while (true) withFrameNanos { t ->
            if (last != 0L) angle.floatValue = (angle.floatValue + (t - last) / 1.8e9f * 360f) % 360f
            last = t
        }
    }
    return { angle.floatValue }
}

private val Mono = FontFamily.Monospace

/** ジュークボックス: the turntable, what is playing, today's picks and the record shelf
 *  (docs/jukebox-client-spec.md; looks follow the prototype). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JukeboxScreen(
    jukebox: JukeboxStore,
    capabilities: Capabilities?,
    tabSwitch: (@Composable () -> Unit)?,
    visible: Boolean = true,
    onOpenThread: (Long) -> Unit,
) {
    val c = jbColors()
    val focus = LocalFocusManager.current
    LaunchedEffect(visible) { if (visible) jukebox.open(capabilities?.jukeboxPath ?: "/api/agent/jukebox") }
    val listState = rememberLazyListState()
    val filtered = jukebox.filtered
    // Opened from the mini player / the notification: back up to the turntable.
    LaunchedEffect(jukebox.revealTick) { if (jukebox.revealTick > 0) listState.animateScrollToItem(0) }
    val currentId = jukebox.current?.id

    Scaffold(
        topBar = {
            TopAppBar(
                title = { if (tabSwitch != null) tabSwitch() else Text("ジュークボックス") },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = c.bg, titleContentColor = c.ink),
            )
        },
        containerColor = c.bg,
        contentWindowInsets = WindowInsets(0),
    ) { padding ->
        LazyColumn(
            state = listState,
            modifier = Modifier.padding(padding).fillMaxSize().imePadding().pointerInput(Unit) { detectTapGestures(onTap = { focus.clearFocus() }) },
            horizontalAlignment = Alignment.CenterHorizontally,
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp),
        ) {
            item(key = "deck", contentType = "deck") {
                Turntable(jukebox, visible, c, Modifier.widthIn(max = 440.dp).fillMaxWidth())
                Spacer(Modifier.height(16.dp))
            }
            item(key = "now", contentType = "now") {
                NowPlaying(jukebox, c, Modifier.widthIn(max = 440.dp).fillMaxWidth())
                Spacer(Modifier.height(16.dp))
            }
            item(key = "picks", contentType = "picks") {
                Picks(jukebox, c, onOpenThread, Modifier.widthIn(max = 440.dp).fillMaxWidth())
            }
            item(key = "shelf", contentType = "shelf") {
                ShelfHeader(jukebox, c, Modifier.widthIn(max = 440.dp).fillMaxWidth())
            }
            if (filtered.isEmpty()) {
                item(key = "empty") {
                    Text(
                        when {
                            !jukebox.hasLoaded -> "読み込み中…"
                            jukebox.failed -> "読み込めませんでした。タブを開き直すともう一度読みます"
                            else -> "見つかりませんでした"
                        },
                        fontSize = 13.sp, color = c.sub,
                        modifier = Modifier.widthIn(max = 440.dp).fillMaxWidth().background(c.panel, RoundedCornerShape(12.dp)).padding(14.dp),
                    )
                }
            }
            items(filtered, key = { it.id }, contentType = { "ep" }) { e ->
                ShelfRow(e, e.id == currentId, jukebox.progress[e.id], c,
                    Modifier.widthIn(max = 440.dp).fillMaxWidth()) { focus.clearFocus(); jukebox.play(e) }
            }
            item(key = "end") { Spacer(Modifier.navigationBarsPadding()) }
        }
    }
}

// MARK: turntable

@Composable
private fun Turntable(jukebox: JukeboxStore, visible: Boolean, c: JbColors, modifier: Modifier) {
    val still = reduceMotion()
    val playing = jukebox.playing
    val spin = rememberSpin(playing && visible && !still)
    val arm by animateFloatAsState(
        if (playing) 2f else -24f,
        if (still) snap() else tween(900, easing = CubicBezierEasing(.5f, .1f, .2f, 1f)), label = "arm",
    )
    val cur = jukebox.current
    Box(
        modifier
            .semantics { contentDescription = if (playing) "ターンテーブル（再生中）" else "ターンテーブル" }
            .clip(RoundedCornerShape(18.dp))
            .background(Brush.linearGradient(listOf(c.wood1, c.wood2)))
            .drawBehind {
                // Wood grain.
                var x = -size.height
                while (x < size.width) {
                    drawLine(Color.White.copy(alpha = 0.04f), Offset(x, size.height), Offset(x + size.height * 0.18f, 0f), 2.dp.toPx())
                    x += 7.dp.toPx()
                }
            }
            .padding(18.dp),
    ) {
        // Not clipped: the raised tonearm swings out over the wood, like a real deck.
        BoxWithConstraints(Modifier.fillMaxWidth().aspectRatio(1f).background(c.plinth, RoundedCornerShape(14.dp))) {
            val p = maxWidth
            // Platter + record grooves (round, so they never need redrawing while turning).
            Canvas(Modifier.fillMaxSize()) {
                val s = size.minDimension
                val center = Offset(size.width / 2, size.height / 2)
                val platterR = s * 0.44f
                drawCircle(Brush.radialGradient(0f to Color(0xFF3B342E), 0.6f to Color(0xFF3B342E), 0.61f to c.platter, 1f to c.platter, center = center, radius = platterR), platterR, center)
                drawCircle(Color.White.copy(alpha = 0.04f), platterR - 1.5.dp.toPx(), center, style = Stroke(3.dp.toPx()))
                val recR = s * 0.42f
                drawCircle(Color(0xFF090909), recR + 2.dp.toPx(), center)
                drawCircle(Color(0xFF111111), recR, center)
                val step = 2.6.dp.toPx()
                var r = recR * 0.34f
                while (r < recR - step / 2) {
                    drawCircle(Color(0xFF1C1C1C), r, center, style = Stroke(1.4.dp.toPx()))
                    r += step
                }
            }
            // The label (turns).
            val labelSize = p * 0.84f * 0.34f
            Box(
                Modifier.align(Alignment.Center).size(labelSize)
                    .graphicsLayer { rotationZ = spin() }
                    .clip(CircleShape)
                    .background(cur?.color ?: JbItem.labelColor(0))
                    .border(2.dp, Color.Black.copy(alpha = 0.18f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("BACKSPACE.FM", color = Color.White.copy(alpha = 0.75f), fontSize = 6.sp, letterSpacing = 1.sp, maxLines = 1)
                    Text(cur?.label ?: "♪", color = Color.White, fontFamily = Mono, fontWeight = FontWeight.Bold,
                        fontSize = if ((cur?.label?.length ?: 0) > 5) 14.sp else 18.sp, maxLines = 1)
                    Text(cur?.year?.toString() ?: "", color = Color.White.copy(alpha = 0.85f), fontSize = 9.sp, letterSpacing = 2.sp, maxLines = 1)
                }
                Box(Modifier.size(labelSize * 0.06f).background(c.plinth, CircleShape))
            }
            // Sheen (stays still, like light on the vinyl).
            Canvas(Modifier.fillMaxSize()) {
                val center = Offset(size.width / 2, size.height / 2)
                val w = Color.White
                rotate(-60f, center) {
                    drawCircle(
                        Brush.sweepGradient(
                            0f to w.copy(alpha = 0f), 30f / 360 to w.copy(alpha = 0.09f), 70f / 360 to w.copy(alpha = 0f),
                            180f / 360 to w.copy(alpha = 0f), 215f / 360 to w.copy(alpha = 0.07f), 250f / 360 to w.copy(alpha = 0f), 1f to w.copy(alpha = 0f),
                            center = center,
                        ),
                        size.minDimension * 0.42f, center,
                    )
                }
            }
            // Tonearm: down while playing, up when stopped.
            Canvas(
                Modifier.align(Alignment.TopEnd).offset(x = -p * 0.02f, y = p * 0.02f).width(p * 0.44f).height(p * 0.70f)
                    .graphicsLayer { transformOrigin = TransformOrigin(0.82f, 0.12f); rotationZ = arm },
            ) {
                val k = minOf(size.width / 100f, size.height / 160f)
                translate((size.width - 100f * k) / 2, (size.height - 160f * k) / 2) {
                    fun o(x: Float, y: Float) = Offset(x * k, y * k)
                    drawCircle(Color(0xFFCFC6BB), 13f * k, o(82f, 19f))
                    drawCircle(Color(0xFF6B6259), 6f * k, o(82f, 19f))
                    val path = Path().apply { moveTo(82f * k, 19f * k); lineTo(70f * k, 120f * k); lineTo(52f * k, 146f * k) }
                    drawPath(path, Color(0xFFD9D2C9), style = Stroke(5f * k, cap = StrokeCap.Round, join = StrokeJoin.Round))
                    rotate(-35f, o(51f, 146f)) {
                        drawRoundRect(Color(0xFF2B2620), o(40f, 140f), Size(22f * k, 13f * k), CornerRadius(3f * k))
                    }
                }
            }
            Row(Modifier.align(Alignment.BottomStart).padding(start = p * 0.05f, bottom = p * 0.05f),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.size(7.dp).background(if (playing) Color(0xFF4ADE80) else Color(0xFF55402F), CircleShape))
                Text("33⅓", color = Color(0xFFE9DCCB).copy(alpha = 0.85f), fontSize = 10.sp, fontFamily = Mono)
            }
        }
    }
}

// MARK: now playing

@Composable
private fun NowPlaying(jukebox: JukeboxStore, c: JbColors, modifier: Modifier) {
    val cur = jukebox.current
    Column(
        modifier.clip(RoundedCornerShape(14.dp)).background(c.panel).border(1.dp, c.line, RoundedCornerShape(14.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(cur?.ep?.title ?: "レコード棚から 1 枚どうぞ", fontSize = 16.sp, fontWeight = FontWeight.Bold, lineHeight = 23.sp, color = c.ink)
        if (cur != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(cur.date, fontSize = 12.sp, fontFamily = Mono, color = c.sub)
                val dur = if (jukebox.durationMs > 0) formatTime(jukebox.durationMs / 1000) else cur.duration
                Text(listOf(dur, cur.ep.series).filter { it.isNotEmpty() }.joinToString(" ・ "), fontSize = 12.sp, color = c.sub)
            }
            if (cur.ep.summary.isNotEmpty()) {
                Text(cur.ep.summary + if (cur.ep.summary.length >= 160) "…" else "", fontSize = 12.5.sp, lineHeight = 20.sp, color = c.sub)
            }
        }
        SeekBar(jukebox, c)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
            Pill("⟲15", c, "15 秒戻る") { jukebox.seekBy(-15_000) }
            Box(
                Modifier.size(54.dp).clip(CircleShape).background(c.accent)
                    .clickable(enabled = cur != null) { jukebox.toggle() }
                    .semantics { contentDescription = if (jukebox.playing) "一時停止" else "再生" },
                contentAlignment = Alignment.Center,
            ) { Text(if (jukebox.playing) "❚❚" else "▶", color = c.accentInk, fontSize = 20.sp) }
            Pill("30⟳", c, "30 秒進む") { jukebox.seekBy(30_000) }
            val sp = jukebox.speed
            Pill((if (sp == 1.25f || sp == 1.75f) "%.2f×" else "%.1f×").format(sp), c, "再生速度") { jukebox.cycleSpeed() }
        }
        SleepRow(jukebox, c)
        jukebox.notice?.let { Text(it, fontSize = 12.sp, color = Color(0xFFDC2626)) }
    }
}

/** Position bar + times: the only part that redraws twice a second while playing. */
@Composable
private fun SeekBar(jukebox: JukeboxStore, c: JbColors) {
    val len = jukebox.durationMs
    val pos = jukebox.positionMs
    var dragging by remember { mutableStateOf<Float?>(null) }
    val f = dragging ?: if (len > 0) (pos.toFloat() / len).coerceIn(0f, 1f) else 0f
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(
            Modifier.fillMaxWidth().height(22.dp)
                .semantics { contentDescription = "再生位置" }
                .pointerInput(Unit) { detectTapGestures { o -> jukebox.seekTo(o.x / size.width) } }
                .pointerInput(Unit) {
                    detectHorizontalDragGestures(
                        onDragStart = { o -> dragging = o.x / size.width },
                        onDragEnd = { dragging?.let(jukebox::seekTo); dragging = null },
                        onDragCancel = { dragging = null },
                    ) { change, _ -> dragging = (change.position.x / size.width).coerceIn(0f, 1f) }
                }
                .drawBehind {
                    val h = 6.dp.toPx()
                    val y = (size.height - h) / 2
                    drawRoundRect(c.line, Offset(0f, y), Size(size.width, h), CornerRadius(h / 2))
                    if (f > 0f) drawRoundRect(c.accent, Offset(0f, y), Size(size.width * f, h), CornerRadius(h / 2))
                },
        )
        Row(Modifier.fillMaxWidth()) {
            Text(formatTime(((dragging?.let { it * len } ?: pos.toFloat()) / 1000).toLong()), fontSize = 11.sp, fontFamily = Mono, color = c.sub)
            Spacer(Modifier.weight(1f))
            Text(formatTime(len / 1000), fontSize = 11.sp, fontFamily = Mono, color = c.sub)
        }
    }
}

@Composable
private fun Pill(text: String, c: JbColors, label: String, onClick: () -> Unit) {
    Box(
        Modifier.height(40.dp).widthIn(min = 40.dp).clip(CircleShape).background(c.chip).clickable(onClick = onClick)
            .semantics { contentDescription = label }.padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, fontSize = 13.sp, color = c.ink, maxLines = 1) }
}

@Composable
private fun SleepRow(jukebox: JukeboxStore, c: JbColors) {
    var open by remember { mutableStateOf(false) }
    val minutes = jukebox.sleepMinutes
    // Remaining time, refreshed every 15 s.
    val now by produceState(System.currentTimeMillis(), minutes) { while (true) { value = System.currentTimeMillis(); kotlinx.coroutines.delay(15_000) } }
    val text = when (minutes) {
        null -> "スリープタイマー：オフ"
        JukeboxStore.SLEEP_END_OF_EPISODE -> "スリープ：この回の終わりまで"
        else -> "スリープ：あと ${((jukebox.sleepEndsAt - now + 59_999) / 60_000).coerceAtLeast(1)} 分"
    }
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Box {
            Text("☾ $text", fontSize = 12.sp, color = if (minutes != null) c.accent else c.sub,
                modifier = Modifier.clip(CircleShape).clickable { open = true }.padding(horizontal = 10.dp, vertical = 6.dp))
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                listOf(15, 30, 60).forEach { m -> DropdownMenuItem(text = { Text("$m 分") }, onClick = { jukebox.setSleep(m); open = false }) }
                DropdownMenuItem(text = { Text("この回の終わりまで") }, onClick = { jukebox.setSleep(JukeboxStore.SLEEP_END_OF_EPISODE); open = false })
                DropdownMenuItem(text = { Text("オフ") }, onClick = { jukebox.setSleep(null); open = false })
            }
        }
    }
}

// MARK: picks + shelf

@Composable
private fun Picks(jukebox: JukeboxStore, c: JbColors, onOpenThread: (Long) -> Unit, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        SectionTitle("きょうの 1 枚", c)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PickCard("🎲 シャッフル", "%,d 枚からランダムに".format(jukebox.items.size), c, Modifier.weight(1f)) { jukebox.shuffle() }
            val a = jukebox.anniversary
            if (a != null) PickCard("📅 ${a.second} 年前の今ごろ", a.first.ep.title, c, Modifier.weight(1f)) { jukebox.play(a.first) }
            else Spacer(Modifier.weight(1f))
        }
        val t = jukebox.today
        if (t?.postId != null && jukebox.anniversary?.first?.id == t.id) {
            Text("💬 この回の感想スレッドを開く", fontSize = 12.sp, color = c.accent,
                modifier = Modifier.clip(CircleShape).clickable { onOpenThread(t.postId) }.padding(horizontal = 4.dp, vertical = 2.dp))
        }
    }
}

@Composable
private fun SectionTitle(text: String, c: JbColors) {
    Text(text, fontSize = 14.sp, letterSpacing = 0.8.sp, color = c.sub, fontWeight = FontWeight.Medium, modifier = Modifier.padding(top = 4.dp))
}

@Composable
private fun PickCard(title: String, sub: String, c: JbColors, modifier: Modifier, onClick: () -> Unit) {
    Column(
        modifier.clip(RoundedCornerShape(12.dp)).background(c.panel).border(1.dp, c.line, RoundedCornerShape(12.dp))
            .clickable(onClick = onClick).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(title, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(sub, fontSize = 11.sp, color = c.sub, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun ShelfHeader(jukebox: JukeboxStore, c: JbColors, modifier: Modifier) {
    val focus = LocalFocusManager.current
    Column(modifier.padding(top = 10.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        SectionTitle("レコード棚", c)
        BasicTextField(
            value = jukebox.query,
            onValueChange = jukebox::search,
            singleLine = true,
            textStyle = TextStyle(fontSize = 14.sp, color = c.ink),
            cursorBrush = androidx.compose.ui.graphics.SolidColor(c.accent),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }),
            // A hardware Enter only closes the keyboard (focus must not wander to another tab).
            modifier = Modifier.fillMaxWidth().onPreviewKeyEvent { e ->
                if (e.key == Key.Enter || e.key == Key.NumPadEnter) { if (e.type == KeyEventType.KeyUp) focus.clearFocus(); true } else false
            },
            decorationBox = { inner ->
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(c.panel).border(1.dp, c.line, RoundedCornerShape(10.dp))
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(Modifier.weight(1f)) {
                        if (jukebox.query.isEmpty()) Text("題名・説明で探す（例：WWDC、ゲスト名）", fontSize = 14.sp, color = c.sub, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        inner()
                    }
                    if (jukebox.query.isNotEmpty()) {
                        Text("✕", fontSize = 13.sp, color = c.sub, modifier = Modifier.clip(CircleShape).clickable { jukebox.search("") }.padding(horizontal = 6.dp)
                            .semantics { contentDescription = "検索を消す" })
                    }
                }
            },
        )
        val years = jukebox.years
        LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            item(key = "all") { Chip("すべて", jukebox.year == null, c) { jukebox.chooseYear(null) } }
            items(years, key = { it }) { y -> Chip("$y", jukebox.year == y, c) { jukebox.chooseYear(y) } }
        }
        LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            items(JukeboxStore.SERIES_CHIPS, key = { it }) { s -> Chip(s, jukebox.series == s, c) { jukebox.series = s } }
        }
        val n = jukebox.filtered.size
        if (jukebox.items.isNotEmpty()) Text("%,d 枚".format(n), fontSize = 11.sp, color = c.sub)
    }
}

@Composable
private fun Chip(text: String, on: Boolean, c: JbColors, onClick: () -> Unit) {
    Text(
        text, fontSize = 12.sp, color = if (on) c.chipOnInk else c.ink, fontWeight = if (on) FontWeight.Bold else FontWeight.Normal, maxLines = 1,
        modifier = Modifier.clip(CircleShape).background(if (on) c.chipOn else c.chip).clickable(onClick = onClick).padding(horizontal = 11.dp, vertical = 6.dp),
    )
}

/** One record on the shelf: small disc in the year's colour, title (2 lines), date,
 *  length or ✓ 聴いた, series, and a bar when it was left part-way. */
@Composable
private fun ShelfRow(e: JbItem, isCurrent: Boolean, pr: JbProgress?, c: JbColors, modifier: Modifier, onClick: () -> Unit) {
    Row(
        modifier
            .background(c.panel)
            .drawBehind {
                if (isCurrent) drawRect(c.accent.copy(alpha = 0.12f))
                drawLine(c.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx())
            }
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.size(30.dp).drawBehind { drawDisc(e.color) })
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(e.ep.title, fontSize = 13.5.sp, lineHeight = 18.sp, color = c.ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(e.date, fontSize = 11.sp, fontFamily = Mono, color = c.sub)
                Text(if (pr?.done == true) "✓ 聴いた" else e.duration, fontSize = 11.sp, fontFamily = Mono,
                    color = if (pr?.done == true) c.accent else c.sub)
                if (e.ep.series != "本編") Text(e.ep.series, fontSize = 11.sp, color = c.sub, maxLines = 1)
            }
            val f = pr?.fraction ?: 0f
            if (pr != null && !pr.done && f > 0f) {
                Box(Modifier.fillMaxWidth().padding(top = 2.dp).height(3.dp).drawBehind {
                    drawRoundRect(c.line, cornerRadius = CornerRadius(2.dp.toPx()))
                    drawRoundRect(c.accent, size = Size(size.width * f, size.height), cornerRadius = CornerRadius(2.dp.toPx()))
                })
            }
        }
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawDisc(label: Color) {
    val r = size.minDimension / 2
    drawCircle(Color(0xFF151515), r)
    var g = r * 0.4f
    while (g < r) { drawCircle(Color(0xFF262626), g, style = Stroke(1f)); g += 2.dp.toPx() }
    drawCircle(label, r * 0.36f)
}

// MARK: mini player

/** Bottom of every tab while an episode is playing or paused: a turning record, the
 *  title and play/pause. Tap → the jukebox tab. After the voice room paused it: 続きを再生. */
@Composable
fun JukeboxMiniPlayer(jukebox: JukeboxStore, inVoice: Boolean, onOpen: () -> Unit) {
    val cur = jukebox.current ?: return
    val c = jbColors()
    val still = reduceMotion()
    val spin = rememberSpin(jukebox.playing && !still)
    val offerResume = jukebox.pausedForVoice && !inVoice
    Column(Modifier.fillMaxWidth().background(c.panel.copy(alpha = 0.97f))) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(c.line))
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onOpen).navigationBarsPadding().padding(horizontal = 16.dp, vertical = 8.dp)
                .semantics { contentDescription = "ジュークボックス：${cur.ep.title}" },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(Modifier.size(36.dp).graphicsLayer { rotationZ = spin() }.drawBehind { drawDisc(cur.color) })
            Column(Modifier.weight(1f)) {
                Text(cur.ep.title, fontSize = 12.5.sp, color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    when {
                        offerResume -> "ボイスルームに入ったので止めました"
                        inVoice && jukebox.pausedForVoice -> "ボイスルームの間は止めています"
                        else -> listOf(cur.date, if (jukebox.durationMs > 0) formatTime(jukebox.durationMs / 1000) else cur.duration).filter { it.isNotEmpty() }.joinToString(" ・ ")
                    },
                    fontSize = 11.sp, color = c.sub, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            if (offerResume) {
                Text("続きを再生", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = c.accentInk,
                    modifier = Modifier.clip(CircleShape).background(c.accent).clickable { jukebox.resume() }.padding(horizontal = 14.dp, vertical = 9.dp))
            } else {
                Box(
                    Modifier.size(38.dp).clip(CircleShape).background(c.accent).clickable { jukebox.toggle() }
                        .semantics { contentDescription = if (jukebox.playing) "一時停止" else "再生" },
                    contentAlignment = Alignment.Center,
                ) { Text(if (jukebox.playing) "❚❚" else "▶", color = c.accentInk, fontSize = 15.sp, textAlign = TextAlign.Center) }
            }
            if (!jukebox.playing) {
                Text("✕", fontSize = 14.sp, color = c.sub,
                    modifier = Modifier.clip(CircleShape).clickable { jukebox.dismiss() }.padding(8.dp).semantics { contentDescription = "ミニプレイヤーを閉じる" })
            }
        }
    }
}
