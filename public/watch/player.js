/* 📺 YouTube 共同鑑賞のプレイヤー（Web・iPhone・Mac・Android で共用。lib/watch.ts）。
 *
 * このページは本番（https://bsm.backspace.fm/watch/）から読まれる。YouTube の埋め込みは送り元が要る
 * （file:// や文字列から読むと 152/153 で見られない）。鍵・API はこのページに持たせない: 操作は
 * 置き場所（Web の iframe の親・アプリ）へ渡し、置き場所が API に送る。状態は置き場所から受け取る。
 *
 * 置き場所 → ページ: window.bguruWatch.receive(msg)
 *   { type: "hello", bridge: 1, platform, can_control, compact? }
 *   { type: "state", state }        GET state・操作の応答・即時の知らせ（lib/watch.ts の WatchStateDto）
 *   { type: "layout", compact }     小さな窓（操作の帯だけ）
 *   { type: "error", message }      操作が断られた（「埋め込めない動画」など）
 *   知らない type は無視する（古いアプリと新しいページ、その逆のどちらでも動くように）。
 * ページ → 置き場所:
 *   { type: "ready", bridge: 1 } / { type: "action", body: { action, ... } } / { type: "popout" }
 *   Web: parent.postMessage({ source: "bguru-watch", ... }, origin)、iPhone・Mac: webkit.messageHandlers.watch、
 *   Android: BguruWatchBridge.postMessage(JSON)（addWebMessageListener。いちばん外のフレームだけ）
 *
 * 合わせ方（architect の指摘 2026-10-25）:
 *   - 操作として送るのは、ここの部品を押したときだけ。YouTube の状態の変化（自分で合わせた結果も含む）は送らない
 *   - 合わせるべき位置 = position + (サーバの今 − updated_at)。端末の時計とのずれは、届いた状態の server_now の
 *     いちばん新しい見積もり（遅れて届いたものほど小さく出るので最大を取る）
 *   - 2 秒以上ずれていたらシーク。ただし読み込み直後 3 秒・読み込み中・広告中は合わせない、シークは 5 秒あける
 *   - 終わった・再生できないは、今の動画と版を添えて 1 回だけ報告（サーバが 1 回だけ次へ進める）
 */
(function () {
  "use strict";
  var BRIDGE_VERSION = 1;
  var $ = function (id) { return document.getElementById(id); };

  var hello = { platform: "web", can_control: true, compact: false };
  var state = null;            // 最後に受け取った WatchStateDto
  var offsets = [];            // server_now − 受け取った時の Date.now()（最近 8 件）
  var player = null, playerReady = false, ytLoading = false;
  var loadedId = null, loadedAt = 0, lastSeek = 0;
  var reportedEnd = null;      // "版:動画" を報告済み
  var muted = false, autoMuted = false, wantPlaySince = 0;
  var dragging = false;

  // ───────────────────────── 置き場所とのやり取り

  function post(msg) {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.watch) {
        window.webkit.messageHandlers.watch.postMessage(msg);
      } else if (window.BguruWatchBridge && window.BguruWatchBridge.postMessage) {
        window.BguruWatchBridge.postMessage(JSON.stringify(msg)); // Android: addWebMessageListener (main frame only)
      } else if (window.parent && window.parent !== window) {
        msg.source = "bguru-watch";
        window.parent.postMessage(msg, location.origin);
      }
    } catch (e) { /* 置き場所がない（単体で開いた） */ }
  }
  function send(body) { if (hello.can_control) post({ type: "action", body: body }); }

  function receive(msg) {
    if (typeof msg === "string") { try { msg = JSON.parse(msg); } catch (e) { return; } }
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "hello":
        hello.platform = String(msg.platform || "web");
        hello.can_control = msg.can_control !== false;
        document.body.classList.toggle("ro", !hello.can_control);
        if (typeof msg.compact === "boolean") setCompact(msg.compact);
        break;
      case "state":
        if (msg.state && typeof msg.state === "object") applyState(msg.state);
        break;
      case "layout":
        setCompact(!!msg.compact);
        break;
      case "error":
        showMsg(String(msg.message || "うまくいきませんでした"));
        break;
      default:
        break; // 知らない知らせは無視
    }
  }
  window.bguruWatch = { receive: receive, version: BRIDGE_VERSION };
  // Web: 親（同じ置き場所）からの postMessage。
  window.addEventListener("message", function (e) {
    if (e.origin !== location.origin || e.source !== window.parent) return;
    var d = e.data;
    if (d && d.source === "bguru-watch-host") receive(d);
  });

  function setCompact(on) { document.body.classList.toggle("compact", on); }

  var msgTimer = null;
  function showMsg(text) {
    $("msg").textContent = text;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(function () { $("msg").textContent = ""; }, 6000);
  }

  // ───────────────────────── 時計

  function serverNow() {
    if (!offsets.length) return Date.now();
    return Date.now() + Math.max.apply(null, offsets);
  }
  function targetPosition() {
    if (!state || !state.video) return 0;
    var p = Number(state.position) || 0;
    if (state.playing) p += Math.max(0, serverNow() - Number(state.updated_at)) / 1000;
    var d = playerReady && player.getDuration ? player.getDuration() : 0;
    return d > 0 ? Math.min(p, d) : p;
  }
  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    var mm = h ? String(m).padStart(2, "0") : String(m);
    return (h ? h + ":" : "") + mm + ":" + String(x).padStart(2, "0");
  }

  // ───────────────────────── 状態

  function applyState(s) {
    if (typeof s.server_now === "number") {
      offsets.push(s.server_now - Date.now());
      if (offsets.length > 8) offsets.shift();
    }
    // 古い版（遅れて届いた応答）は捨てる。
    if (state && typeof s.version === "number" && s.version < state.version && sameVideo(state, s)) return;
    state = s;
    render();
    ensurePlayer();
    sync(true);
  }
  function sameVideo(a, b) { return (a.video && a.video.video_id) === (b.video && b.video.video_id); }

  function render() {
    var v = state && state.video;
    $("empty").hidden = !!v;
    $("title").textContent = v ? v.title : "なにも流れていません";
    var sub = [];
    if (v && v.channel) sub.push(v.channel);
    if (v && v.by) sub.push(v.by + "さんが流しました");
    if (state && state.last && state.last.by && v) {
      var label = { pause: "一時停止", play: "再生", seek: "位置を変えました" }[state.last.action];
      if (label) sub.push(state.last.by + "さんが" + label);
    }
    $("sub").textContent = sub.join(" ・ ");
    $("toggle").disabled = !v;
    $("seek").disabled = !v;
    $("next").disabled = !v && !(state && state.queue && state.queue.length);
    $("toggle").textContent = v && state.playing ? "⏸" : "▶";
    $("toggle").setAttribute("aria-label", v && state.playing ? "一時停止" : "再生");
    var q = (state && state.queue) || [];
    var ul = $("queue");
    ul.textContent = "";
    if (!q.length) {
      var li = document.createElement("li");
      li.className = "none";
      li.textContent = "まだありません。URL を貼って「リストへ」";
      ul.appendChild(li);
    }
    q.forEach(function (item) {
      var li = document.createElement("li");
      var img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.src = "https://i.ytimg.com/vi/" + encodeURIComponent(item.video_id) + "/mqdefault.jpg";
      var info = document.createElement("div");
      info.className = "info";
      var t = document.createElement("div"); t.className = "t"; t.textContent = item.title;
      var s2 = document.createElement("div"); s2.className = "s"; s2.textContent = (item.by ? item.by + "さん" : "") + (item.channel ? " ・ " + item.channel : "");
      info.appendChild(t); info.appendChild(s2);
      var play = document.createElement("button"); play.textContent = "▶"; play.title = "いま見る（みんな）"; play.setAttribute("aria-label", "いま見る");
      play.onclick = function () { send({ action: "queue_play", id: item.id }); };
      var rm = document.createElement("button"); rm.textContent = "✕"; rm.title = "リストから外す"; rm.setAttribute("aria-label", "リストから外す");
      rm.onclick = function () { send({ action: "queue_remove", id: item.id }); };
      li.appendChild(img); li.appendChild(info); li.appendChild(play); li.appendChild(rm);
      ul.appendChild(li);
    });
  }

  // ───────────────────────── YouTube

  function ensurePlayer() {
    if (player || ytLoading || !state || !state.video) return;
    ytLoading = true;
    window.onYouTubeIframeAPIReady = function () {
      var host = state && state.youtube_host === "www.youtube-nocookie.com" ? "https://www.youtube-nocookie.com" : "https://www.youtube.com";
      player = new YT.Player("yt", {
        host: host,
        width: "100%",
        height: "100%",
        playerVars: {
          controls: 0, disablekb: 1, playsinline: 1, rel: 0, fs: 0, iv_load_policy: 3, modestbranding: 1,
          enablejsapi: 1, origin: location.origin,
        },
        events: {
          onReady: function () { playerReady = true; sync(true); },
          onStateChange: onPlayerState,
          onError: function (e) { if (playingCurrent()) reportEnd("error", e && e.data); },
        },
      });
    };
    var s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = function () { ytLoading = false; showMsg("YouTube を読み込めませんでした"); };
    document.head.appendChild(s);
  }

  function onPlayerState(e) {
    // 0 終了 / 1 再生 / 2 一時停止 / 3 読み込み中 / 5 頭出し。ここから操作は送らない（終わりの報告だけ）。
    // 終わった: 今の動画のときだけ（切り替えた直後に前の動画の「終わった」が来て、次の動画を飛ばしていた）。
    if (e.data === 0 && playingCurrent() && Date.now() - loadedAt > 3000) reportEnd("ended");
    if (e.data === 1) { wantPlaySince = 0; $("unmute").hidden = !autoMuted; }
  }

  /** YouTube の中で今かかっているのが、みんなの今の動画か。 */
  function playingCurrent() {
    if (!state || !state.video || !player || !player.getVideoData) return false;
    var d = player.getVideoData();
    return !!d && d.video_id === state.video.video_id && loadedId === state.video.video_id;
  }

  function reportEnd(kind, code) {
    if (!state || !state.video) return;
    var key = state.version + ":" + state.video.video_id;
    if (reportedEnd === key) return;
    reportedEnd = key;
    post({ type: "action", body: { action: kind, video_id: state.video.video_id, version: state.version, code: code } });
  }

  /** 状態に合わせる。`now` はすぐ（状態が届いたとき）。そうでなければ 1 秒ごとの見回り。 */
  function sync(now) {
    if (!playerReady || !state) return;
    var v = state.video;
    if (!v) {
      if (loadedId) { try { player.stopVideo(); } catch (e) {} loadedId = null; }
      return;
    }
    var target = targetPosition();
    if (loadedId !== v.video_id) {
      loadedId = v.video_id;
      loadedAt = Date.now();
      lastSeek = Date.now();
      if (state.playing) player.loadVideoById({ videoId: v.video_id, startSeconds: target });
      else player.cueVideoById({ videoId: v.video_id, startSeconds: target });
      if (state.playing) wantPlaySince = Date.now();
      return;
    }
    var ps = player.getPlayerState ? player.getPlayerState() : -1;
    if (state.playing) {
      if (ps !== 1 && ps !== 3) {
        player.playVideo();
        if (!wantPlaySince) wantPlaySince = Date.now();
      }
    } else if (ps === 1 || ps === 3) {
      player.pauseVideo();
    }
    // 音つきの自動再生を止められた（Web）: 消音で再生し、「音を出す」を出す。
    if (state.playing && wantPlaySince && Date.now() - wantPlaySince > 1500 && ps !== 1 && !autoMuted) {
      autoMuted = true;
      player.mute();
      player.playVideo();
      $("unmute").hidden = false;
    }
    // 位置: 読み込み直後・読み込み中・広告中（再生中なのに位置が動かない）は合わせない。
    var settled = Date.now() - loadedAt > 3000 && ps !== 3;
    if (settled && Date.now() - lastSeek > 5000) {
      var cur = player.getCurrentTime ? player.getCurrentTime() : 0;
      if (Math.abs(cur - target) > 2) {
        lastSeek = Date.now();
        player.seekTo(target, true);
      }
    } else if (now && !state.playing && Date.now() - loadedAt > 1000) {
      // 一時停止・シークの知らせ: 止まっている絵も合わせる。
      var c2 = player.getCurrentTime ? player.getCurrentTime() : 0;
      if (Math.abs(c2 - target) > 0.5) { lastSeek = Date.now(); player.seekTo(target, true); }
    }
  }

  // ───────────────────────── 帯（1 秒ごとに描き直す）

  function tick() {
    var v = state && state.video;
    var d = playerReady && player.getDuration ? player.getDuration() : 0;
    var t = targetPosition();
    if (!dragging) {
      $("seek").max = String(Math.max(0, Math.floor(d)));
      $("seek").value = String(Math.floor(t));
    }
    $("time").textContent = v ? fmt(dragging ? Number($("seek").value) : t) + " / " + fmt(d) : "0:00 / 0:00";
    sync(false);
  }
  setInterval(tick, 1000);

  // ───────────────────────── 操作（押したときだけ送る）

  $("toggle").onclick = function () {
    if (!state || !state.video) return;
    // 位置は添えない: サーバの今の位置（直前のシークも含む）から。シークの直後に押すと、添えた古い位置でシークを打ち消していた。
    send({ action: state.playing ? "pause" : "play" });
  };
  $("seek").addEventListener("input", function () { dragging = true; tick(); });
  $("seek").addEventListener("change", function () {
    dragging = false;
    if (state && state.video) send({ action: "seek", position: Number($("seek").value) });
  });
  $("next").onclick = function () { send({ action: "next" }); };
  $("mute").onclick = function () {
    if (!playerReady) return;
    muted = !muted;
    autoMuted = false;
    $("unmute").hidden = true;
    if (muted) player.mute(); else player.unMute();
    $("mute").textContent = muted ? "🔇" : "🔊";
  };
  $("unmute").onclick = function () {
    if (!playerReady) return;
    autoMuted = false;
    muted = false;
    player.unMute();
    $("unmute").hidden = true;
    $("mute").textContent = "🔊";
  };
  $("pop").onclick = function () { post({ type: "popout" }); };
  $("add").addEventListener("submit", function (e) {
    e.preventDefault();
    var u = $("url").value.trim();
    if (!u) return;
    send({ action: "load", url: u });
    $("url").value = "";
  });
  $("enqueue").onclick = function () {
    var u = $("url").value.trim();
    if (!u) return;
    send({ action: "queue_add", url: u });
    $("url").value = "";
  };

  render();
  post({ type: "ready", bridge: BRIDGE_VERSION });
})();
