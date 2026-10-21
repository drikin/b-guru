package fm.backspace.bguru.chat

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class ShogiLogicTest {
    private val gameJson = """
        {"action":"state","game":{"id":12,"status":"active","mode":"blitz",
         "creator":{"user_id":"u1","name":"mazzo","avatar":null},"invitee":null,
         "black":{"user_id":"u1","name":"mazzo","avatar":null},"white":{"user_id":"u2","name":"takuto","avatar":"/a.png"},
         "sfen":"lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 2","ply":1,"turn":"white",
         "last_move":{"usi":"7g7f","label":"▲7六歩"},
         "clocks":{"black_ms":600000,"white_ms":600000,"byoyomi_ms":30000,"initial_ms":600000},
         "turn_started_at":"2026-10-21T00:00:00.000Z","deadline_at":null,"server_now":"2026-10-21T00:00:05.000Z",
         "spectators":3,"result":null,"end_reason":null,"created_at":"2026-10-21T00:00:00.000Z",
         "started_at":"2026-10-21T00:00:00.000Z","ended_at":null,"rematch_of":null,"card_message_id":55,"result_post_id":null,
         "future_field":{"x":1}}}
    """.trimIndent()

    // MARK: stream

    @Test fun parsesStreamEvent() {
        val e = ShogiLogic.parseEvent(gameJson)
        assertNotNull(e)
        assertEquals("state", e!!.action)
        val g = e.game!!
        assertEquals(12L, g.id)
        assertEquals("takuto", g.white?.name)
        assertEquals("u2", g.white?.userId)
        assertEquals("7g7f", g.lastMove?.usi)
        assertEquals(30_000L, g.clocks?.byoyomiMs)
        assertEquals(55L, g.cardMessageId)
        assertTrue(g.isActive)
    }

    @Test fun dropsBrokenEvents() {
        assertNull(ShogiLogic.parseEvent("not json"))
        assertNull(ShogiLogic.parseEvent("""{"action":"state"}"""))
        assertNull(ShogiLogic.parseEvent("""{"action":"state","game":{"id":0}}"""))
    }

    @Test fun slowGameHasNoClocks() {
        val e = ShogiLogic.parseEvent("""{"action":"offer","game":{"id":3,"status":"offered","mode":"slow","clocks":null,"creator":{"user_id":"a","name":"A"},"invitee":{"user_id":"b","name":"B"}}}""")!!
        assertEquals("offer", e.action)
        assertNull(e.game!!.clocks)
        assertNull(ShogiLogic.clockNow(e.game!!, 0, 0))
        assertEquals("B", e.game!!.invitee?.name)
    }

    @Test fun upsertNeverRollsBack() {
        val g = ShogiLogic.parseEvent(gameJson)!!.game!!
        val newer = g.copy(ply = 3)
        val list = ShogiLogic.upsert(listOf(newer), g)
        assertEquals(3, list.single().ply) // the older event is ignored
        val ended = g.copy(status = "ended", ply = 1)
        assertEquals("ended", ShogiLogic.upsert(listOf(newer), ended).single().status) // a new status always wins
        assertEquals(2, ShogiLogic.upsert(listOf(g.copy(id = 99)), g).size)
    }

    @Test fun detailAppendsOneMoveOrAsksForTheWhole() {
        val g = ShogiLogic.parseEvent(gameJson)!!.game!!.copy(moves = listOf(ShogiMove(1, "7g7f", "▲7六歩")))
        val next = g.copy(ply = 2, moves = null, lastMove = ShogiLastMove("3c3d", "△3四歩"))
        val merged = ShogiLogic.mergeDetail(g, next)!!
        assertEquals(2, merged.moves!!.size)
        assertEquals("3c3d", merged.moves!!.last().usi)
        assertNull(ShogiLogic.mergeDetail(g, g.copy(ply = 5, moves = null))) // jumped: fetch again
        assertEquals(1, ShogiLogic.mergeDetail(g, g.copy(spectators = 9, moves = null))!!.moves!!.size)
    }

    // MARK: clock

    private fun blitz(ply: Int, turn: String, startedMsAgo: Long, now: Long, black: Long = 300_000, white: Long = 400_000) =
        ShogiGame(1, "active", "blitz", ply = ply, turn = turn,
            clocks = ShogiClocks(black, white, 30_000, 600_000),
            turnStartedAt = Instant.ofEpochMilli(now - startedMsAgo).toString())

    @Test fun clockCountsTheSideToMoveLessOneSecond() {
        val now = 1_800_000_000_000L
        val c = ShogiLogic.clockNow(blitz(10, "black", 11_000, now), 0, now)!!
        assertEquals(290_000L, c.blackMs) // 11 s − 1 s lag allowance
        assertEquals(400_000L, c.whiteMs)
        assertNull(c.byoyomiMs)
    }

    @Test fun clockUsesServerSkew() {
        val now = 1_800_000_000_000L
        // This device is 5 s behind the server: the turn started 6 s ago on the server's clock.
        val g = blitz(10, "white", 1_000, now)
        val c = ShogiLogic.clockNow(g, skew = 5_000, now = now)!!
        assertEquals(400_000L - 5_000L, c.whiteMs)
        assertEquals(5_000L, ShogiLogic.skewOf("2026-10-21T00:00:05Z", Instant.parse("2026-10-21T00:00:00Z").toEpochMilli(), 0))
        assertEquals(77L, ShogiLogic.skewOf(null, 0, 77))
    }

    @Test fun clockGoesIntoByoyomiAndStopsAtZero() {
        val now = 1_800_000_000_000L
        val c = ShogiLogic.clockNow(blitz(10, "black", 11_000, now, black = 0), 0, now)!!
        assertEquals(0L, c.blackMs)
        assertEquals(20_000L, c.byoyomiMs)
        val over = ShogiLogic.clockNow(blitz(10, "black", 60_000, now, black = 0), 0, now)!!
        assertEquals(0L, over.byoyomiMs)
    }

    @Test fun clockWaitsForBothFirstMoves() {
        val now = 1_800_000_000_000L
        val c = ShogiLogic.clockNow(blitz(1, "white", 30_000, now), 0, now)!!
        assertEquals(400_000L, c.whiteMs)
        assertEquals("10:00", ShogiLogic.playerLabel(blitz(1, "white", 30_000, now).copy(white = ShogiPlayer("w", "W")), "white", c).removePrefix("W ").removeSuffix(" ●"))
    }

    @Test fun formatsClock() {
        assertEquals("10:00", ShogiLogic.fmtClock(600_000))
        assertEquals("0:01", ShogiLogic.fmtClock(1))
        assertEquals("0:00", ShogiLogic.fmtClock(-5))
        assertEquals("4:51", ShogiLogic.fmtClock(290_200))
    }

    // MARK: bridge

    @Test fun parsesBoardMessages() {
        assertEquals(ShogiLogic.BoardOut.Ready, ShogiLogic.parseBoard("""{"type":"ready","v":1}"""))
        assertEquals(ShogiLogic.BoardOut.Move("7g7f", "▲7六歩"), ShogiLogic.parseBoard("""{"type":"move","v":1,"usi":"7g7f","label":"▲7六歩"}"""))
        assertEquals(ShogiLogic.BoardOut.Move("P*5e", ""), ShogiLogic.parseBoard("""{"type":"move","v":1,"usi":"P*5e"}"""))
        assertEquals(ShogiLogic.BoardOut.Move("8h2b+", "x"), ShogiLogic.parseBoard("""{"type":"move","v":1,"usi":"8h2b+","label":"x"}"""))
        assertEquals(ShogiLogic.BoardOut.Haptic("select"), ShogiLogic.parseBoard("""{"type":"haptic","v":1,"kind":"select"}"""))
        assertEquals(ShogiLogic.BoardOut.Flip("white"), ShogiLogic.parseBoard("""{"type":"flip","v":1,"orientation":"white"}"""))
        assertEquals(ShogiLogic.BoardOut.Size(513), ShogiLogic.parseBoard("""{"type":"size","v":1,"height":512.4}"""))
        assertEquals(ShogiLogic.BoardOut.Close, ShogiLogic.parseBoard("""{"type":"close","v":1}"""))
        assertEquals(ShogiLogic.BoardOut.Error("boom"), ShogiLogic.parseBoard("""{"type":"error","v":1,"message":"boom"}"""))
    }

    @Test fun rejectsBadBoardMessages() {
        assertNull(ShogiLogic.parseBoard("""{"type":"ready"}"""))              // no version
        assertNull(ShogiLogic.parseBoard("""{"type":"ready","v":2}"""))        // another version
        assertNull(ShogiLogic.parseBoard("""{"type":"move","v":1,"usi":"javascript:x"}"""))
        assertNull(ShogiLogic.parseBoard("""{"type":"move","v":1,"usi":"7g7z"}"""))
        assertNull(ShogiLogic.parseBoard("""{"type":"move","v":1,"usi":"K*5e"}""")) // no king drops
        assertNull(ShogiLogic.parseBoard("""{"type":"haptic","v":1,"kind":"buzz"}"""))
        assertNull(ShogiLogic.parseBoard("""{"type":"size","v":1,"height":-1}"""))
        assertNull(ShogiLogic.parseBoard("""{"type":"token","v":1}"""))
        assertNull(ShogiLogic.parseBoard("[1,2]"))
        assertNull(ShogiLogic.parseBoard("nope"))
    }

    @Test fun stateMessageFollowsTheContract() {
        val m = ShogiLogic.stateMessage(
            sfen = ShogiLogic.INITIAL_SFEN, myColor = null, canMove = false, lastMove = ShogiLastMove("7g7f", "▲7六歩"),
            orientation = "white", confirmMove = true, moveHints = false, compact = true, theme = "dark", topLabel = "A", bottomLabel = null,
        )
        assertEquals("state", (m["type"] as JsonPrimitive).content)
        assertTrue(m.containsKey("my_color"))
        assertEquals("null", m["my_color"].toString())
        assertEquals("false", m["can_move"].toString())
        assertEquals("7g7f", ((m["last_move"] as JsonObject)["usi"] as JsonPrimitive).content)
        assertEquals("white", (m["orientation"] as JsonPrimitive).content)
        assertEquals(true to false, ShogiLogic.settingsOf(m))
        assertEquals("dark", (m["theme"] as JsonPrimitive).content)
        assertFalse(m.containsKey("bottom_label"))
        assertFalse(m.containsKey("hide_band"))
        val hidden = ShogiLogic.stateMessage(ShogiLogic.INITIAL_SFEN, "black", true, null, null, false, true, false, "light", null, null, hideBand = true)
        assertEquals("true", hidden["hide_band"].toString())
        // max_height: the board fits itself into the panel (a number of CSS px).
        assertEquals("300", ShogiLogic.withMaxHeight(m, 300)["max_height"].toString())
        assertFalse(ShogiLogic.withMaxHeight(m, null).containsKey("max_height"))
        // The script hands it over as one JSON string literal.
        val js = ShogiLogic.receiveScript(ShogiLogic.labelsMessage("a\"</script>", "b"))
        assertTrue(js.startsWith("window.shogiBoard&&window.shogiBoard.receive(\""))
        val inner = kotlinx.serialization.json.Json.parseToJsonElement(js.removePrefix("window.shogiBoard&&window.shogiBoard.receive(").removeSuffix(");"))
        val back = kotlinx.serialization.json.Json.parseToJsonElement((inner as JsonPrimitive).content).jsonObject
        assertEquals("a\"</script>", (back["top_label"] as JsonPrimitive).content)
    }

    // MARK: texts, card, demo mover

    @Test fun textsAndColors() {
        val g = ShogiLogic.parseEvent(gameJson)!!.game!!
        assertEquals("black", ShogiLogic.myColor(g, "u1"))
        assertEquals("white", ShogiLogic.myColor(g, "u2"))
        assertNull(ShogiLogic.myColor(g, "u3"))
        assertNull(ShogiLogic.myColor(g, null))
        // A game against oneself (test): my side is the side to move.
        val self = g.copy(white = g.black, turn = "white")
        assertEquals("white", ShogiLogic.myColor(self, "u1"))
        assertEquals("black", ShogiLogic.myColor(self.copy(turn = "black"), "u1"))
        assertNull(ShogiLogic.myColor(self, "u2"))
        assertEquals(true, ApiJson.decodeFromString<ShogiReply>("""{"me":{"user_id":"u1","self_play":true},"games":[]}""").me?.selfPlay)
        assertEquals("☗mazzo の勝ち（投了）・87 手", ShogiLogic.resultText(g.copy(status = "ended", result = "black", endReason = "resign", ply = 87)))
        assertEquals("引き分け（千日手）・120 手", ShogiLogic.resultText(g.copy(status = "ended", result = "draw", endReason = "sennichite", ply = 120)))
        assertEquals("中断・1 手", ShogiLogic.resultText(g.copy(status = "ended", endReason = "aborted")))
        assertEquals("⚡速い", ShogiLogic.modeLabel("blitz"))
        assertEquals("🐢ゆっくり", ShogiLogic.modeLabel("slow"))
    }

    @Test fun miniBoardCells() {
        val c = ShogiLogic.miniCells(ShogiLogic.INITIAL_SFEN)
        assertEquals(81, c.size)
        assertEquals(2, c[0])      // 9一香 (後手)
        assertEquals(0, c[9])      // 9二 empty
        assertEquals(2, c[10])     // 8二飛
        assertEquals(1, c[80])     // 1九香 (先手)
        assertEquals(20, c.count { it == 1 })
        assertEquals(20, c.count { it == 2 })
        val promoted = ShogiLogic.miniCells("9/9/9/9/4+P4/9/9/9/9 b - 1")
        assertEquals(1, promoted[40])
    }

    @Test fun demoMoverPlaysMovesCapturesAndDrops() {
        var s = ShogiLogic.INITIAL_SFEN
        for (m in listOf("7g7f", "3c3d", "2g2f", "8c8d")) s = ShogiLogic.applyUsi(s, m)!!
        assertEquals("lnsgkgsnl/1r5b1/p1pppp1pp/1p4p2/9/2P4P1/PP1PPPP1P/1B5R1/LNSGKGSNL b - 5", s)
        var t = ShogiLogic.INITIAL_SFEN
        for (m in listOf("7g7f", "3c3d", "8h2b+")) t = ShogiLogic.applyUsi(t, m)!!
        assertEquals("lnsgkgsnl/1r5+B1/pppppp1pp/6p2/9/2P6/PP1PPPPPP/7R1/LNSGKGSNL w B 4", t)
        t = ShogiLogic.applyUsi(t, "3a2b")!!
        assertEquals("lnsgkg1nl/1r5s1/pppppp1pp/6p2/9/2P6/PP1PPPPPP/7R1/LNSGKGSNL b Bb 5", t)
        t = ShogiLogic.applyUsi(t, "B*4e")!!
        assertEquals("lnsgkg1nl/1r5s1/pppppp1pp/6p2/5B3/2P6/PP1PPPPPP/7R1/LNSGKGSNL w b 6", t)
        assertNull(ShogiLogic.applyUsi(t, "R*5e")) // nothing in hand
        assertNull(ShogiLogic.applyUsi("garbage", "7g7f"))
    }

    @Test fun oneLiveGameAtATime() {
        val ended = ShogiGame(1, "ended")
        assertNull(ShogiLogic.liveGame(listOf(ended, ShogiGame(2, "closed"))))
        assertEquals(3L, ShogiLogic.liveGame(listOf(ended, ShogiGame(3, "open")))?.id)
        assertEquals(4L, ShogiLogic.liveGame(listOf(ShogiGame(3, "offered"), ShogiGame(4, "active")))?.id)
        // 409 busy carries the game that is up
        val r = ApiJson.decodeFromString<ShogiReply>("""{"error":"対局は 1 局ずつです","code":"busy","game":{"id":7,"status":"open"}}""")
        assertEquals("busy", r.code)
        assertEquals(7L, r.game?.id)
    }

    @Test fun beagleGame() {
        val dog = ShogiPlayer("b1", "ビーグル", "/icon-192.png")
        val me = ShogiPlayer("u1", "ドリキン")
        val g = ShogiGame(20, "active", "blitz", creator = me, invitee = dog, black = dog, white = me, turn = "black")
        assertEquals("black", ShogiLogic.beagleSide(g))
        assertEquals("white", ShogiLogic.myColor(g, "u1"))
        assertNull(ShogiLogic.beagleSide(g.copy(black = ShogiPlayer("x", "mazzo"))))
        val caps = ApiJson.decodeFromString<Capabilities>("""{"scopes":["read","chat"],"features":{"shogi":{"enabled":true,"bridge_version":1,"play":true,"beagle":true}}}""")
        assertTrue(caps.shogiBeagle)
        assertFalse(ApiJson.decodeFromString<Capabilities>("""{"features":{"shogi":{"enabled":true,"play":true}}}""").shogiBeagle)
    }
}
