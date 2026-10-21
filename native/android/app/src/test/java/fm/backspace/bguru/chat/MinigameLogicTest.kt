package fm.backspace.bguru.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MinigameLogicTest {
    private fun obj(s: String) = ApiJson.parseToJsonElement(s).jsonObject
    private fun str(o: JsonObject?, k: String) = (o?.get(k) as? JsonPrimitive)?.content

    @Test fun parsesGameMessages() {
        assertEquals(MinigameLogic.GameOut.Ready(1), MinigameLogic.parse("""{"type":"ready","v":1,"engine_version":1}"""))
        assertEquals(MinigameLogic.GameOut.RequestPlay(3, "daily", "matsuo"),
            MinigameLogic.parse("""{"type":"request_play","v":1,"req":3,"mode":"daily","character":"matsuo"}"""))
        assertEquals(MinigameLogic.GameOut.RequestLeaderboard(4, "week"), MinigameLogic.parse("""{"type":"request_leaderboard","v":1,"req":4,"period":"week"}"""))
        assertEquals(MinigameLogic.GameOut.RequestInfo, MinigameLogic.parse("""{"type":"request_info","v":1}"""))
        assertEquals(MinigameLogic.GameOut.Haptic("highscore"), MinigameLogic.parse("""{"type":"haptic","v":1,"kind":"highscore"}"""))
        assertEquals(MinigameLogic.GameOut.Size(217), MinigameLogic.parse("""{"type":"size","v":1,"height":216.5}"""))
        assertEquals(MinigameLogic.GameOut.Error("x"), MinigameLogic.parse("""{"type":"error","v":1,"message":"x"}"""))
    }

    @Test fun finishedKeepsOnlyWhatTheServerTakes() {
        val f = MinigameLogic.parse("""{"type":"finished","v":1,"req":9,"play_id":257,"inputs":[0,241,5,8],"engine_version":1,
            "mode":"daily","character":"drikin","score":1240,"ticks":4210,"distance":1003,"sd":38}""") as MinigameLogic.GameOut.Finished
        assertEquals(9, f.req)
        assertEquals(257L, f.playId)
        assertEquals(setOf("inputs", "engine_version", "score", "ticks"), f.body.keys)
        assertEquals(4, (f.body["inputs"] as JsonArray).size)
        assertEquals("1240", f.body["score"].toString())
    }

    @Test fun dropsBadMessages() {
        assertNull(MinigameLogic.parse("""{"type":"ready"}"""))                       // no version
        assertNull(MinigameLogic.parse("""{"type":"ready","v":2}"""))
        assertNull(MinigameLogic.parse("""{"type":"request_play","v":1,"req":1,"mode":"ranked","character":"drikin"}"""))
        assertNull(MinigameLogic.parse("""{"type":"request_play","v":1,"req":1,"mode":"daily","character":"someone"}"""))
        assertNull(MinigameLogic.parse("""{"type":"request_play","v":1,"mode":"daily","character":"drikin"}""")) // no req
        assertNull(MinigameLogic.parse("""{"type":"finished","v":1,"req":1,"play_id":1,"inputs":["a"],"engine_version":1}"""))
        assertNull(MinigameLogic.parse("""{"type":"finished","v":1,"req":1,"play_id":0,"inputs":[],"engine_version":1}"""))
        assertNull(MinigameLogic.parse("""{"type":"request_leaderboard","v":1,"req":1,"period":"year"}"""))
        assertNull(MinigameLogic.parse("""{"type":"haptic","v":1,"kind":"buzz"}"""))
        assertNull(MinigameLogic.parse("""{"type":"token","v":1}"""))
        assertNull(MinigameLogic.parse("nope"))
    }

    @Test fun repliesCarryReqAndUnwrap() {
        val play = MinigameLogic.reply(5, 201, obj("""{"apiVersion":1,"play":{"play_id":257,"seed":822266587,"mode":"daily"}}"""), "play")
        assertEquals("5", str(play, "req"))
        assertEquals("257", str(play, "play_id"))
        assertFalse(play.containsKey("apiVersion"))
        val board = MinigameLogic.reply(6, 200, obj("""{"apiVersion":1,"period":"today","entries":[],"me":null}"""), null)
        assertEquals("today", str(board, "period"))
        assertFalse(board.containsKey("apiVersion"))
        val err = MinigameLogic.reply(7, 409, obj("""{"error":"ルール更新のため記録できません","code":"engine_version"}"""), "result")
        assertEquals("7", str(err, "req"))
        assertEquals("engine_version", str(err, "code"))
        assertEquals("ルール更新のため記録できません", str(err, "error"))
        val none = MinigameLogic.reply(8, 502, null, "result")
        assertEquals("error", str(none, "code"))
    }

    @Test fun stateAndEvents() {
        val info = obj("""{"apiVersion":1,"engine_version":1,"me":{"user_id":"u","name":"ドリキン"},"plays_today":3}""")
        val s = MinigameLogic.state(info = info, theme = "dark", maxHeight = 300)
        assertEquals("state", str(s, "type"))
        assertFalse(s.containsKey("apiVersion"))
        assertEquals("3", str(s, "plays_today"))
        assertEquals("dark", str(s, "theme"))
        assertEquals("300", str(s, "max_height"))
        val r = MinigameLogic.state(replyKey = "play", reply = MinigameLogic.errorReply(1, "x", "y"))
        assertTrue(r.containsKey("play"))
        val e = MinigameLogic.event("""{"action":"leaderboard","period":"today","key":"2026-10-21","top":[]}""")!!
        assertEquals("event", str(e, "type"))
        assertEquals("leaderboard", str(e["data"] as JsonObject, "action"))
        assertNull(MinigameLogic.event("garbage"))
        assertTrue(MinigameLogic.receiveScript(MinigameLogic.simple("pause")).startsWith("window.bguruMinigame&&window.bguruMinigame.receive(\""))
    }

    @Test fun capabilities() {
        val caps = ApiJson.decodeFromString<Capabilities>("""{"features":{"minigame":{"enabled":true,"path":"/api/agent/minigame","game_url":"/minigame/index.html","bridge_version":1,"engine_version":1,"play":true,"characters":["drikin"],"modes":["daily","free"]}}}""")
        assertTrue(caps.minigameEnabled)
        assertTrue(caps.canPlayMinigame)
        assertEquals("/minigame/index.html", caps.minigameGameUrl)
        assertFalse(ApiJson.decodeFromString<Capabilities>("""{"features":{"minigame":{"enabled":true,"bridge_version":2}}}""").minigameEnabled)
        assertFalse(ApiJson.decodeFromString<Capabilities>("""{"features":{}}""").minigameEnabled)
        assertEquals("/minigame/index.html", ApiJson.decodeFromString<Capabilities>("""{"features":{"minigame":{"enabled":true,"game_url":"https://evil.example/x"}}}""").minigameGameUrl)
    }
}
