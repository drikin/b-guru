using System.Text.Json;

namespace BguruChat.Core;

public enum RowState { Sent, Pending, Failed }

/// <summary>チャットの 1 行（送信中・失敗の仮の行も）。Key はこの画面のあいだ変わらない（送信中から届いたあとまで）。</summary>
public sealed record ChatRow(ChatMessage Message, RowState State = RowState.Sent)
{
    public string Key { get; init; } = Message.ClientId ?? $"m{Message.Id}";
}

/// <summary>ストリームの出どころ（テストでは偽物）。</summary>
public interface IEventSource
{
    IAsyncEnumerable<ServerEvent> ConnectAsync(CancellationToken ct);
}

public sealed class ApiEventSource(ApiClient api) : IEventSource
{
    public IAsyncEnumerable<ServerEvent> ConnectAsync(CancellationToken ct) => LiveStream.ReadAsync(api, ct);
}

public enum Connection { Connecting, Live, Offline }

/// <summary>
/// チャットの状態と決まり（native/shared/ChatStore.swift と同じ）。画面に依存しない。
/// 呼ぶ側（App）は UI のスレッドから呼ぶ。await のあとも同じスレッドに戻る（SynchronizationContext のまま）。
/// </summary>
public sealed class ChatStore
{
    private readonly IChatApi api;
    private readonly IEventSource events;
    private readonly Func<DateTime> now;

    public ChatStore(IChatApi api, IEventSource events, Func<DateTime>? now = null)
    {
        this.api = api;
        this.events = events;
        this.now = now ?? (() => DateTime.Now);
    }

    public List<ChatRow> Rows { get; private set; } = [];
    public int UnreadCount { get; private set; }
    public int MentionCount { get; private set; }
    public int OnlineCount { get; private set; }
    public long LatestId { get; private set; }
    /// <summary>どこまで読んだか（「ここから未読」の線）。</summary>
    public long? ReadCursor { get; private set; }
    public string? MyUserId { get; private set; }
    public Capabilities? Capabilities { get; private set; }
    public List<Member> Members { get; private set; } = [];
    public List<CustomEmoji> Emojis { get; private set; } = [];
    public Connection Connection { get; private set; } = Connection.Connecting;
    public bool HasLoaded { get; private set; }
    public bool SignedOut { get; private set; }
    public NotifySettings Notify { get; set; } = new();

    /// <summary>パネルが見えている（見えているあいだの新着は知らせず既読にする）。</summary>
    public bool IsVisible
    {
        get => visible;
        set
        {
            if (visible == value) return;
            visible = value;
            if (value) MarkReadSoon();
            Changed?.Invoke();
        }
    }
    private bool visible;

    /// <summary>何か変わった（画面を描き直す）。</summary>
    public event Action? Changed;
    /// <summary>メンションが届いた（音はするか）。</summary>
    public event Action<ChatMessage, bool>? Mention;
    /// <summary>ほかの新着が届いた（まとめの通知を更新する。音はするか）。</summary>
    public event Action<ChatMessage, bool>? NewMessage;
    /// <summary>自分のほかの端末で既読になった（scope, up_to）。通知を消す。</summary>
    public event Action<string, long?>? ReadElsewhere;
    /// <summary>ログアウトした（鍵が無効・取り消された）。</summary>
    public event Action? SignedOutChanged;
    /// <summary>知らないイベント・ほかの機能のイベント（あとの段階の機能が見る）。</summary>
    public event Action<ServerEvent>? OtherEvent;

    public ChatLimits Limits => Capabilities?.Chat ?? new ChatLimits(1000, 4, 1280, true, true, true, true, true, true);

    private long tempSeq;
    private CancellationTokenSource? readCts;
    private CancellationTokenSource? wakeCts;

    // MARK: - 起動とストリーム

    /// <summary>起動時に 1 回: 機能・絵文字・メンバーを読み、ストリームを回し続ける（止めるまで）。</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        try { Capabilities = await api.CapabilitiesAsync(ct); }
        catch (ApiException e) when (e.IsUnauthorized) { SignOut(); return; }
        catch (Exception e) when (e is not OperationCanceledException) { }
        _ = LoadExtrasAsync(ct);
        var backoff = new Backoff();
        while (!ct.IsCancellationRequested && !SignedOut)
        {
            var started = DateTime.UtcNow;
            var connected = TimeSpan.Zero;
            try
            {
                Connection = Connection.Connecting;
                Changed?.Invoke();
                await foreach (var ev in events.ConnectAsync(ct))
                {
                    connected = DateTime.UtcNow - started;
                    await HandleAsync(ev);
                    if (SignedOut) return;
                }
            }
            catch (ApiException e) when (e.IsUnauthorized) { SignOut(); return; }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception) { /* つながらない・切れた → 待ってからやり直す */ }
            connected = DateTime.UtcNow - started;
            Connection = Connection.Offline;
            Changed?.Invoke();
            await WaitAsync(backoff.Next(connected), ct);
        }
    }

    /// <summary>ネットワークが戻った: 待ちを飛ばしてすぐつなぎ直す。</summary>
    public void Wake() => wakeCts?.Cancel();

    private async Task WaitAsync(TimeSpan wait, CancellationToken ct)
    {
        wakeCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        try { await Task.Delay(wait, wakeCts.Token); }
        catch (OperationCanceledException) { }
        finally { wakeCts.Dispose(); wakeCts = null; }
    }

    private async Task LoadExtrasAsync(CancellationToken ct)
    {
        try { Members = await api.MembersAsync(ct); } catch (Exception e) when (e is not OperationCanceledException) { }
        try { Emojis = await api.EmojisAsync(ct); } catch (Exception e) when (e is not OperationCanceledException) { }
        Changed?.Invoke();
    }

    private void SignOut()
    {
        if (SignedOut) return;
        SignedOut = true;
        SignedOutChanged?.Invoke();
    }

    // MARK: - イベント

    private sealed record ChatEvent(string Action, ChatMessage? Message, long? Id, List<Reaction>? Reactions);
    private sealed record PresenceEvent(List<string> UserIds);
    private sealed record SyncEvent(string? Scope, long? UpTo);

    public async Task HandleAsync(ServerEvent ev)
    {
        switch (ev.Name)
        {
            case "ready":
                Connection = Connection.Live;
                await ReloadAsync();
                break;
            case "chat":
                if (Parse<ChatEvent>(ev) is { } e) ApplyChat(e);
                break;
            case "presence":
                if (Parse<PresenceEvent>(ev) is { } p) { OnlineCount = p.UserIds.Count; Changed?.Invoke(); }
                break;
            case "sync":
                if (Parse<SyncEvent>(ev) is { Scope: { } scope } s)
                {
                    if (scope == "chat") await ReadElsewhereAsync(s.UpTo);
                    ReadElsewhere?.Invoke(scope, s.UpTo);
                }
                break;
            case "revoked":
                SignOut();
                break;
            default:
                OtherEvent?.Invoke(ev); // 知らないものは無視（あとの段階の機能が使う）
                break;
        }
    }

    private static T? Parse<T>(ServerEvent ev) where T : class
    {
        try { return ev.As<T>(); }
        catch (JsonException) { return null; }
    }

    private void ApplyChat(ChatEvent e)
    {
        switch (e.Action)
        {
            case "create" when e.Message is { } m:
                Received(m);
                break;
            case "edit" when e.Message is { } m:
                var i = Rows.FindIndex(r => r.Message.Id == m.Id);
                if (i >= 0)
                {
                    var old = Rows[i].Message;
                    Rows[i] = Rows[i] with { Message = m with { Reactions = old.Reactions, ClientId = old.ClientId } };
                    Changed?.Invoke();
                }
                break;
            case "delete" when e.Id is { } id:
                if (Rows.RemoveAll(r => r.Message.Id == id) > 0) Changed?.Invoke();
                break;
            case "reactions" when e.Id is { } id:
                var j = Rows.FindIndex(r => r.Message.Id == id);
                if (j >= 0)
                {
                    Rows[j] = Rows[j] with { Message = Rows[j].Message with { Reactions = e.Reactions ?? [] } };
                    Changed?.Invoke();
                }
                break;
        }
    }

    private void Received(ChatMessage m)
    {
        LatestId = Math.Max(LatestId, m.Id);
        if (m.IsAuthor) MyUserId = m.AuthorId;
        var alreadyShown = Rows.Any(r => r.Message.Id == m.Id);
        Rows = Reconcile(Rows, m);
        if (!m.IsAuthor && !alreadyShown && !m.IsNotice && !m.IsBeagleAI)
        {
            if (IsVisible)
            {
                MarkReadSoon();
            }
            else
            {
                UnreadCount++;
                var kind = NotifyPolicy.Decide(m, false, Notify, now());
                var sound = NotifyPolicy.PlaysSound(Notify, now());
                if (m.MentionsMe) MentionCount++;
                if (kind == NotifyKind.Mention) Mention?.Invoke(m, sound);
                else if (kind == NotifyKind.NewMessage) NewMessage?.Invoke(m, sound);
            }
        }
        Changed?.Invoke();
    }

    /// <summary>
    /// 送信中の行は、同じ人の保存済みの発言（同じ client_id）でだけ置き換える（src/lib/chat-optimistic.ts の reconcileChat と同じ）。
    /// </summary>
    public static List<ChatRow> Reconcile(List<ChatRow> rows, ChatMessage m)
    {
        bool IsTwin(ChatRow r) => r.Message.Id < 0 && m.ClientId is not null && r.Message.ClientId == m.ClientId && m.IsAuthor;
        var existing = rows.FindIndex(r => r.Message.Id == m.Id);
        if (existing >= 0)
        {
            var twin = rows.FirstOrDefault(IsTwin);
            var next = rows.Where(r => !IsTwin(r)).ToList();
            var j = next.FindIndex(r => r.Message.Id == m.Id);
            var reactions = next[j].Message.Reactions;
            next[j] = next[j] with { Message = m with { Reactions = m.Reactions ?? reactions }, State = RowState.Sent };
            if (twin is not null) next[j] = next[j] with { Key = twin.Key };
            return next;
        }
        var i = rows.FindIndex(IsTwin);
        if (i >= 0)
        {
            var next = rows.ToList();
            next[i] = next[i] with { Message = m, State = RowState.Sent };
            return next;
        }
        return [.. rows, new ChatRow(m)];
    }

    /// <summary>読み直す（つながったとき・ほかの端末で途中まで読んだとき）。送信中・失敗の行は残す。</summary>
    public async Task ReloadAsync()
    {
        try
        {
            var page = await api.ChatAsync();
            LatestId = Math.Max(LatestId, page.LatestId ?? 0);
            if (page.LastReadId is { } c) ReadCursor = Math.Max(ReadCursor ?? 0, c);
            UnreadCount = IsVisible ? 0 : page.UnreadCount;
            MentionCount = IsVisible ? 0 : Math.Min(MentionCount, UnreadCount);
            if (page.Messages.FirstOrDefault(m => m.IsAuthor) is { } mine) MyUserId = mine.AuthorId;
            var keys = Rows.Where(r => r.Message.Id > 0).GroupBy(r => r.Message.Id).ToDictionary(g => g.Key, g => g.First().Key);
            var next = page.Messages.Select(m => keys.TryGetValue(m.Id, out var k) ? new ChatRow(m) { Key = k } : new ChatRow(m)).ToList();
            next.AddRange(Rows.Where(r => r.Message.Id < 0));
            Rows = next;
            HasLoaded = true;
            if (IsVisible) MarkReadSoon();
            try { OnlineCount = (await api.SummaryAsync()).OnlineCount; } catch (Exception) { }
        }
        catch (ApiException e) when (e.IsUnauthorized) { SignOut(); }
        catch (Exception) { Connection = Connection.Offline; }
        Changed?.Invoke();
    }

    // MARK: - 送る

    /// <summary>写真を JPEG にする（長辺 maxSide・品質 0.8）。App が Windows の部品で用意する。</summary>
    public Func<byte[], int, Task<byte[]>>? PrepareJpeg { get; set; }

    private readonly Dictionary<string, OutgoingPhotos> outgoing = [];

    /// <summary>送信中の写真（client_id ごと）。吹き出しのプレビューに使う。</summary>
    public IReadOnlyDictionary<string, OutgoingPhotos> Outgoing => outgoing;

    /// <summary>すぐ仮の行を出して送る。写真は先に上げる。送れなかったら（写真なしで直らない失敗）本文を restore に返す。</summary>
    public Task SendAsync(string raw, IReadOnlyList<byte[]>? photos = null, Action<string>? restore = null)
    {
        var body = raw.Trim();
        if (body.Length == 0 && photos is not { Count: > 0 }) return Task.CompletedTask;
        var clientId = Guid.NewGuid().ToString();
        tempSeq++;
        var pending = new ChatMessage
        {
            Id = -tempSeq, AuthorId = MyUserId, Body = body, CreatedAt = DateTimeOffset.Now,
            IsAuthor = true, ClientId = clientId, Reactions = [],
        };
        if (photos is { Count: > 0 }) outgoing[clientId] = new OutgoingPhotos(photos.ToList());
        Rows = [.. Rows, new ChatRow(pending, RowState.Pending)];
        UnreadCount = 0;
        MentionCount = 0;
        Changed?.Invoke();
        return PostAsync(body, clientId, restore);
    }

    public Task RetryAsync(ChatRow row)
    {
        if (row.Message.ClientId is not { } cid) return Task.CompletedTask;
        SetState(cid, RowState.Pending);
        return PostAsync(row.Message.Body, cid, null);
    }

    public void Discard(ChatRow row)
    {
        Rows.RemoveAll(r => r.Message.Id < 0 && r.Message.ClientId == row.Message.ClientId);
        if (row.Message.ClientId is { } cid) outgoing.Remove(cid);
        Changed?.Invoke();
    }

    private async Task PostAsync(string body, string clientId, Action<string>? restore)
    {
        outgoing.TryGetValue(clientId, out var photos);
        try
        {
            var urls = new List<string>();
            if (photos is not null)
            {
                if (photos.Urls is { } done) urls = done;
                else
                {
                    var side = Limits.ImageMaxSide;
                    var jpegs = new List<byte[]>();
                    foreach (var p in photos.Originals) jpegs.Add(PrepareJpeg is null ? p : await PrepareJpeg(p, side));
                    urls = (await api.UploadAsync(jpegs)).Urls;
                    photos.Urls = urls;
                }
            }
            var m = await api.SendAsync(body, clientId, urls);
            MyUserId = m.AuthorId ?? MyUserId;
            LatestId = Math.Max(LatestId, m.Id);
            Rows = Reconcile(Rows, m);
            outgoing.Remove(clientId);
        }
        catch (ApiException e) when (e.IsPermanent && photos is null)
        {
            Rows.RemoveAll(r => r.Message.Id < 0 && r.Message.ClientId == clientId);
            restore?.Invoke(body);
            if (e.IsUnauthorized) SignOut();
        }
        catch (Exception e)
        {
            // 写真つきは吹き出しを残す（再送・取り消す）。写真をなくさない。
            if (e is ApiException { IsUnauthorized: true }) SignOut();
            SetState(clientId, RowState.Failed);
        }
        Changed?.Invoke();
    }

    private void SetState(string clientId, RowState state)
    {
        var i = Rows.FindIndex(r => r.Message.Id < 0 && r.Message.ClientId == clientId);
        if (i >= 0) Rows[i] = Rows[i] with { State = state };
        Changed?.Invoke();
    }

    /// <summary>自分の発言を直す（24 時間以内）。だめなら元に戻して false。</summary>
    public async Task<bool> EditAsync(long id, string body)
    {
        var i = Rows.FindIndex(r => r.Message.Id == id);
        if (i < 0 || body.Trim().Length == 0) return false;
        var old = Rows[i].Message;
        Rows[i] = Rows[i] with { Message = old with { Body = body.Trim(), Edited = true } };
        Changed?.Invoke();
        try
        {
            var m = await api.EditAsync(id, body.Trim());
            var j = Rows.FindIndex(r => r.Message.Id == id);
            if (j >= 0) Rows[j] = Rows[j] with { Message = Rows[j].Message with { Body = m.Body, Edited = m.Edited, EditedAt = m.EditedAt } };
            return true;
        }
        catch (Exception)
        {
            var j = Rows.FindIndex(r => r.Message.Id == id);
            if (j >= 0) Rows[j] = Rows[j] with { Message = old };
            return false;
        }
        finally { Changed?.Invoke(); }
    }

    /// <summary>リアクションをすぐ切り替え、サーバの答えで置き換える（だめなら戻す）。</summary>
    public async Task ToggleReactionAsync(long id, string emoji)
    {
        var i = Rows.FindIndex(r => r.Message.Id == id);
        if (id <= 0 || i < 0) return;
        var old = Rows[i].Message.Reactions ?? [];
        Rows[i] = Rows[i] with { Message = Rows[i].Message with { Reactions = Toggled(old, emoji) } };
        Changed?.Invoke();
        try
        {
            var r = await api.ReactAsync(id, emoji);
            SetReactions(id, r.Reactions);
        }
        catch (Exception) { SetReactions(id, old); }
    }

    private void SetReactions(long id, List<Reaction> list)
    {
        var j = Rows.FindIndex(r => r.Message.Id == id);
        if (j >= 0) Rows[j] = Rows[j] with { Message = Rows[j].Message with { Reactions = list } };
        Changed?.Invoke();
    }

    public static List<Reaction> Toggled(List<Reaction> list, string emoji)
    {
        var next = list.ToList();
        var i = next.FindIndex(r => r.Emoji == emoji);
        if (i < 0) next.Add(new Reaction { Emoji = emoji, Count = 1, Mine = true });
        else if (next[i].Mine)
        {
            var c = next[i].Count - 1;
            if (c <= 0) next.RemoveAt(i);
            else next[i] = next[i] with { Count = c, Mine = false };
        }
        else next[i] = next[i] with { Count = next[i].Count + 1, Mine = true };
        return next;
    }

    public ChatMessage? LastOwnMessage => Rows.LastOrDefault(r => r.Message.IsAuthor && r.Message.Id > 0)?.Message;

    /// <summary>最近話した人（メンションの候補の順番に使う、新しい順）。</summary>
    public List<string> RecentSpeakers() =>
        Rows.AsEnumerable().Reverse().Select(r => r.Message.AuthorName).OfType<string>().Distinct().Take(30).ToList();

    // MARK: - 既読

    private async Task ReadElsewhereAsync(long? upTo)
    {
        if (upTo is { } c) ReadCursor = Math.Max(ReadCursor ?? 0, c);
        if (upTo is null || upTo >= LatestId)
        {
            UnreadCount = 0;
            MentionCount = 0;
            Changed?.Invoke();
        }
        else
        {
            await ReloadAsync(); // 途中まで読んだ: 残りの数はサーバが知っている
        }
    }

    /// <summary>見えているあいだ: 数をすぐ 0 にし、0.4 秒まとめてから既読を送る。</summary>
    private void MarkReadSoon()
    {
        UnreadCount = 0;
        MentionCount = 0;
        if (ReadCursor is not null) ReadCursor = Math.Max(ReadCursor.Value, LatestId);
        if (!(Capabilities?.Chat.MarkRead ?? true) || LatestId <= 0) return;
        readCts?.Cancel();
        var cts = readCts = new CancellationTokenSource();
        var upTo = LatestId;
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(400, cts.Token);
                await api.MarkReadAsync(upTo, cts.Token);
            }
            catch (Exception) { }
        });
    }
}

/// <summary>送信中の写真（元の画像と、上げたあとの URL）。</summary>
public sealed class OutgoingPhotos(List<byte[]> originals)
{
    public List<byte[]> Originals { get; } = originals;
    public List<string>? Urls { get; set; }
}
