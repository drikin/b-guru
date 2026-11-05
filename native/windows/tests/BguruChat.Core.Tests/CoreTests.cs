using System.Runtime.CompilerServices;
using System.Text.Json;
using BguruChat.Core;
using Xunit;

namespace BguruChat.Core.Tests;

internal sealed class FakeApi : IChatApi
{
    public ChatPage Page = new();
    public List<(string Body, string ClientId, IReadOnlyList<string>? Images)> Sent = [];
    public List<long> MarkedRead = [];
    public Func<string, string, ChatMessage>? OnSend;
    public Exception? SendError;
    public ReactionsResult? ReactResult;
    public Exception? ReactError;

    public Task<Capabilities> CapabilitiesAsync(CancellationToken ct = default) =>
        Task.FromResult(JsonSerializer.Deserialize<Capabilities>("""{"features":{"chat":{"send":true,"mark_read":true,"max_body":1000}}}""", Json.Options)!);
    public Task<ChatPage> ChatAsync(int limit = 100, CancellationToken ct = default) => Task.FromResult(Page);
    public Task<ChatMessage> SendAsync(string body, string clientId, IReadOnlyList<string>? images, CancellationToken ct = default)
    {
        Sent.Add((body, clientId, images));
        if (SendError is not null) throw SendError;
        return Task.FromResult(OnSend!(body, clientId));
    }
    public Task<ChatMessage> EditAsync(long id, string body, CancellationToken ct = default) =>
        Task.FromResult(new ChatMessage { Id = id, Body = body, Edited = true, IsAuthor = true });
    public Task<ReactionsResult> ReactAsync(long id, string emoji, CancellationToken ct = default) =>
        ReactError is not null ? Task.FromException<ReactionsResult>(ReactError) : Task.FromResult(ReactResult!);
    public Task<ReadResult> MarkReadAsync(long lastReadId, CancellationToken ct = default)
    {
        lock (MarkedRead) MarkedRead.Add(lastReadId);
        return Task.FromResult(new ReadResult());
    }
    public Task<UploadResult> UploadAsync(IReadOnlyList<byte[]> jpegs, CancellationToken ct = default) =>
        Task.FromResult(new UploadResult { Urls = jpegs.Select((_, i) => $"/api/media/chat-{i}.jpg").ToList() });
    public Task<List<Member>> MembersAsync(CancellationToken ct = default) => Task.FromResult(new List<Member>());
    public Task<List<CustomEmoji>> EmojisAsync(CancellationToken ct = default) => Task.FromResult(new List<CustomEmoji>());
    public Task<SummaryResult> SummaryAsync(CancellationToken ct = default) => Task.FromResult(new SummaryResult { OnlineCount = 3 });
}

internal sealed class NoEvents : IEventSource
{
    public async IAsyncEnumerable<ServerEvent> ConnectAsync([EnumeratorCancellation] CancellationToken ct)
    {
        await Task.Delay(Timeout.Infinite, ct);
        yield break;
    }
}

public class SseParserTests
{
    [Fact]
    public void ParsesEventsHeartbeatsAndJsonWithoutBlankLine()
    {
        var p = new SseParser();
        Assert.Null(p.Feed(": heartbeat"));
        Assert.Null(p.Feed("event: ready"));
        var ev = p.Feed("""data: {"apiVersion":1}""");
        Assert.NotNull(ev); // 完全な JSON になった時点で出す
        Assert.Equal("ready", ev!.Name);
        Assert.Null(p.Feed("")); // 空行（もう出したので何もない）
        Assert.Null(p.Feed("event: chat"));
        Assert.Null(p.Feed("""data: {"action":"create","""));
        var ev2 = p.Feed("""data: "id":1}""");
        Assert.Equal("chat", ev2!.Name);
        Assert.Equal("{\"action\":\"create\",\n\"id\":1}", ev2.Data);
        Assert.Null(p.Feed("data: not json"));
        Assert.Equal("message", p.Feed("")!.Name); // 名前のないものは message
    }
}

public class BackoffTests
{
    [Fact]
    public void DoublesUpTo30sAndResetsAfterHealthyConnection()
    {
        var b = new Backoff(() => 0.5); // ゆらぎなし
        Assert.Equal(1, b.Next(TimeSpan.Zero).TotalSeconds);
        Assert.Equal(2, b.Next(TimeSpan.Zero).TotalSeconds);
        Assert.Equal(4, b.Next(TimeSpan.Zero).TotalSeconds);
        for (var i = 0; i < 10; i++) b.Next(TimeSpan.Zero);
        Assert.Equal(30, b.Next(TimeSpan.Zero).TotalSeconds);
        Assert.Equal(1, b.Next(TimeSpan.FromSeconds(12)).TotalSeconds);
        var j = new Backoff(() => 1.0);
        Assert.Equal(1.2, j.Next(TimeSpan.Zero).TotalSeconds, 3); // +20%
    }
}

public class MentionTests
{
    [Fact]
    public void TokensQueriesAndCandidates()
    {
        Assert.Equal("@ドリキン ", Mention.Token("ドリキン"));
        Assert.Equal("@[John Smith] ", Mention.Token("John Smith"));
        Assert.Equal("こん", Mention.ActiveQuery("やあ @こん")!.Value.Query);
        Assert.Null(Mention.ActiveQuery("mail@example"));
        Assert.Null(Mention.ActiveQuery("@done next"));
        Assert.Equal("Jo", Mention.ActiveQuery("@[Jo")!.Value.Query);
        Assert.Equal("やあ @コバン ", Mention.Complete("やあ @こ", "コバン"));
        var members = new[] { "こばやし", "コバン", "たけし", "Ａこば" }.Select(n => new Member { UserId = n, Name = n }).ToList();
        var c = Mention.Candidates(members, "こば", recent: ["Ａこば"]);
        Assert.Equal(["こばやし", "Ａこば"], c.Select(m => m.Name).ToList()); // 前方一致が先
        Assert.Equal("ａ", Mention.Norm("Ａ　"));
    }
}

public class NotifyTests
{
    private static ChatMessage Msg(long id, bool mention = false, bool mine = false, string? kind = null) =>
        new() { Id = id, AuthorName = "コバン", Body = "やあ", MentionsMe = mention, IsAuthor = mine, Kind = kind };

    [Fact]
    public void DecidesLikeTheMacApp()
    {
        var all = new NotifySettings();
        var day = new DateTime(2026, 11, 4, 12, 0, 0);
        var night = new DateTime(2026, 11, 4, 3, 0, 0);
        Assert.Equal(NotifyKind.NewMessage, NotifyPolicy.Decide(Msg(1), false, all, day));
        Assert.Equal(NotifyKind.None, NotifyPolicy.Decide(Msg(1), true, all, day)); // パネルが見えている
        Assert.Equal(NotifyKind.None, NotifyPolicy.Decide(Msg(1, mine: true), false, all, day));
        Assert.Equal(NotifyKind.None, NotifyPolicy.Decide(Msg(1, kind: "notice"), false, all, day));
        Assert.Equal(NotifyKind.None, NotifyPolicy.Decide(Msg(1, kind: "beagle_ai"), false, all, day));
        Assert.Equal(NotifyKind.None, NotifyPolicy.Decide(Msg(1), false, all, night)); // 静かな時間
        Assert.Equal(NotifyKind.Mention, NotifyPolicy.Decide(Msg(1, mention: true), false, all, night)); // メンションはいつでも
        Assert.False(NotifyPolicy.PlaysSound(all, night));
        Assert.Equal(NotifyKind.None, NotifyPolicy.Decide(Msg(1), false, new NotifySettings(NotifyMode.Mentions), day));
        Assert.Equal(NotifyKind.NewMessage, NotifyPolicy.Decide(Msg(1), false, new NotifySettings(QuietHours: false), night));
    }

    [Fact]
    public void BundlesNewMessages()
    {
        var b = new NewMessageBundle();
        Assert.True(b.Add(Msg(5)));
        Assert.False(b.Add(Msg(6) with { AuthorName = "たけし", Body = "おはよう" }));
        Assert.Equal(("B-guru チャット", "たけし: おはよう\n（ほか 1 件の新着）"), b.Text());
        Assert.False(b.ClearIfCovered(5));
        Assert.True(b.ClearIfCovered(6));
        Assert.Equal(0, b.Count);
        Assert.Equal("📷 写真", NewMessageBundle.Preview(new ChatMessage { Body = ChatMessage.PhotoOnlyBody, Images = ["/api/media/chat-a.jpg"] }));
    }
}

public class ChatStoreTests
{
    private static ServerEvent Ev(string name, object data) => new(name, JsonSerializer.Serialize(data, Json.Options));
    private static ChatMessage Msg(long id, string body = "やあ", bool mention = false, bool mine = false, string? clientId = null) =>
        new() { Id = id, AuthorName = mine ? "わたし" : "コバン", AuthorId = mine ? "me" : "u1", Body = body, MentionsMe = mention, IsAuthor = mine, ClientId = clientId };

    [Fact]
    public async Task ReadyReloadsAndCreateCountsAndNotifies()
    {
        var api = new FakeApi { Page = new ChatPage { UnreadCount = 2, LatestId = 10, LastReadId = 8, Messages = [Msg(9), Msg(10)] } };
        var store = new ChatStore(api, new NoEvents(), () => new DateTime(2026, 11, 4, 12, 0, 0));
        var mentions = new List<long>(); var news = new List<long>();
        store.Mention += (m, _) => mentions.Add(m.Id);
        store.NewMessage += (m, _) => news.Add(m.Id);
        await store.HandleAsync(Ev("ready", new { apiVersion = 1 }));
        Assert.Equal(2, store.Rows.Count);
        Assert.Equal(2, store.UnreadCount);
        Assert.Equal(8, store.ReadCursor);
        Assert.Equal(3, store.OnlineCount);
        await store.HandleAsync(Ev("chat", new { action = "create", message = Msg(11, mention: true) }));
        await store.HandleAsync(Ev("chat", new { action = "create", message = Msg(12) }));
        await store.HandleAsync(Ev("chat", new { action = "create", message = Msg(12) })); // 2 回目は数えない
        await store.HandleAsync(Ev("chat", new { action = "create", message = Msg(13) with { Kind = "notice" } }));
        Assert.Equal(4, store.UnreadCount);
        Assert.Equal(1, store.MentionCount);
        Assert.Equal([11L], mentions);
        Assert.Equal([12L], news);
        Assert.Equal(13, store.LatestId);
    }

    [Fact]
    public async Task VisiblePanelMarksReadInsteadOfNotifying()
    {
        var api = new FakeApi();
        var store = new ChatStore(api, new NoEvents()) { IsVisible = true };
        var notified = 0;
        store.NewMessage += (_, _) => notified++;
        await store.HandleAsync(Ev("chat", new { action = "create", message = Msg(20) }));
        Assert.Equal(0, store.UnreadCount);
        Assert.Equal(0, notified);
        await Task.Delay(700);
        lock (api.MarkedRead) Assert.Contains(20L, api.MarkedRead);
    }

    [Fact]
    public async Task OptimisticSendIsReplacedByTheStoredMessage()
    {
        var api = new FakeApi();
        api.OnSend = (body, cid) => Msg(30, body, mine: true, clientId: cid);
        var store = new ChatStore(api, new NoEvents());
        var send = store.SendAsync("  こんにちは  ");
        await send;
        var row = Assert.Single(store.Rows);
        Assert.Equal(30, row.Message.Id);
        Assert.Equal(RowState.Sent, row.State);
        Assert.Equal("こんにちは", api.Sent[0].Body);
        // 同じ client_id の create がストリームから来ても行は増えない・キーは変わらない
        var key = row.Key;
        await store.HandleAsync(Ev("chat", new { action = "create", message = Msg(30, "こんにちは", mine: true, clientId: api.Sent[0].ClientId) }));
        Assert.Single(store.Rows);
        Assert.Equal(key, store.Rows[0].Key);
    }

    [Fact]
    public void ReconcileOnlyReplacesTheSameAuthorsTwin()
    {
        var pending = new ChatRow(new ChatMessage { Id = -1, ClientId = "c1", IsAuthor = true, Body = "a" }, RowState.Pending);
        var rows = new List<ChatRow> { pending };
        var other = ChatStore.Reconcile(rows, new ChatMessage { Id = 5, ClientId = "c1", IsAuthor = false, Body = "a" });
        Assert.Equal(2, other.Count); // ほかの人の発言では置き換えない
        var mine = ChatStore.Reconcile(rows, new ChatMessage { Id = 5, ClientId = "c1", IsAuthor = true, Body = "a" });
        Assert.Single(mine);
        Assert.Equal(pending.Key, mine[0].Key);
        Assert.Equal(RowState.Sent, mine[0].State);
    }

    [Fact]
    public async Task PermanentFailureRestoresTheTextAndTransientFailureKeepsTheRow()
    {
        var api = new FakeApi { SendError = new ApiException(400, "invalid", "長すぎます") };
        var store = new ChatStore(api, new NoEvents());
        string? restored = null;
        await store.SendAsync("だめな本文", restore: s => restored = s);
        Assert.Empty(store.Rows);
        Assert.Equal("だめな本文", restored);
        api.SendError = new ApiException(503, null, "落ちている");
        await store.SendAsync("あとで");
        Assert.Equal(RowState.Failed, Assert.Single(store.Rows).State);
        api.SendError = null;
        api.OnSend = (b, c) => Msg(40, b, mine: true, clientId: c);
        await store.RetryAsync(store.Rows[0]);
        Assert.Equal(40, Assert.Single(store.Rows).Message.Id);
    }

    [Fact]
    public async Task PhotosAreUploadedFirst()
    {
        var api = new FakeApi();
        api.OnSend = (b, c) => Msg(50, b, mine: true, clientId: c) with { Images = ["/api/media/chat-0.jpg"] };
        var store = new ChatStore(api, new NoEvents()) { PrepareJpeg = (b, side) => Task.FromResult(b) };
        await store.SendAsync("", [new byte[] { 1, 2, 3 }]);
        Assert.Equal(["/api/media/chat-0.jpg"], api.Sent[0].Images);
        Assert.Empty(store.Outgoing);
    }

    [Fact]
    public async Task ReactionsToggleAndRollBack()
    {
        var api = new FakeApi { Page = new ChatPage { LatestId = 1, Messages = [Msg(1)] } };
        var store = new ChatStore(api, new NoEvents());
        await store.ReloadAsync();
        api.ReactError = new HttpRequestException("切れた");
        await store.ToggleReactionAsync(1, "❤️");
        Assert.Empty(store.Rows[0].Message.Reactions ?? []);
        api.ReactError = null;
        api.ReactResult = new ReactionsResult { Added = true, Reactions = [new Reaction { Emoji = "❤️", Count = 2, Mine = true }] };
        await store.ToggleReactionAsync(1, "❤️");
        Assert.Equal(2, store.Rows[0].Message.Reactions![0].Count);
        var once = ChatStore.Toggled([new Reaction { Emoji = "👍", Count = 1, Mine = true }], "👍");
        Assert.Empty(once);
    }

    [Fact]
    public async Task SyncFromAnotherDeviceClearsUnread()
    {
        var api = new FakeApi { Page = new ChatPage { UnreadCount = 2, LatestId = 10, Messages = [Msg(9), Msg(10)] } };
        var store = new ChatStore(api, new NoEvents());
        await store.ReloadAsync();
        (string, long?)? seen = null;
        store.ReadElsewhere += (s, u) => seen = (s, u);
        await store.HandleAsync(new ServerEvent("sync", """{"scope":"chat","up_to":"10"}""")); // 数が文字列でも
        Assert.Equal(0, store.UnreadCount);
        Assert.Equal(("chat", 10L), seen);
    }

    [Fact]
    public async Task RevokedSignsOutAndEditKeepsReactions()
    {
        var api = new FakeApi { Page = new ChatPage { LatestId = 1, Messages = [Msg(1) with { Reactions = [new Reaction { Emoji = "😂", Count = 1 }] }] } };
        var store = new ChatStore(api, new NoEvents());
        await store.ReloadAsync();
        await store.HandleAsync(Ev("chat", new { action = "edit", message = Msg(1, "なおした") with { Edited = true } }));
        Assert.Equal("なおした", store.Rows[0].Message.Body);
        Assert.Single(store.Rows[0].Message.Reactions!);
        var outs = 0;
        store.SignedOutChanged += () => outs++;
        await store.HandleAsync(Ev("revoked", new { code = "unauthorized" }));
        Assert.True(store.SignedOut);
        Assert.Equal(1, outs);
    }

    [Fact]
    public void DecodesServerMessageJson()
    {
        var json = """{"id":7,"author_id":"u","author_name":"コバン","avatar":null,"body":"📷 写真","created_at":"2026-11-04T10:00:00.000Z","edited":false,"edited_at":null,"is_author":false,"mentions_me":true,"images":["/api/media/chat-x.jpg"],"kind":null}""";
        var m = JsonSerializer.Deserialize<ChatMessage>(json, Json.Options)!;
        Assert.Equal(7, m.Id);
        Assert.True(m.MentionsMe);
        Assert.Equal("", m.DisplayBody);
        var caps = JsonSerializer.Deserialize<Capabilities>("""{"apiVersion":1,"features":{"chat":{"send":true,"max_images":4,"image_upload":"/api/agent/chat/upload","edit_own":false}}}""", Json.Options)!;
        Assert.True(caps.Chat.CanSend);
        Assert.False(caps.Chat.CanEditOwn);
        Assert.True(caps.Chat.Images is false); // 無いものは出さない
        Assert.True(caps.Has("chat", "image_upload"));
    }
}
