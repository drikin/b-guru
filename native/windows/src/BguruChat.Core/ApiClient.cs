using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace BguruChat.Core;

/// <summary>チャットで使うサーバの呼び出し（テストでは偽物に差し替える）。</summary>
public interface IChatApi
{
    Task<Capabilities> CapabilitiesAsync(CancellationToken ct = default);
    Task<ChatPage> ChatAsync(int limit = 100, CancellationToken ct = default);
    Task<ChatMessage> SendAsync(string body, string clientId, IReadOnlyList<string>? images, CancellationToken ct = default);
    Task<ChatMessage> EditAsync(long id, string body, CancellationToken ct = default);
    Task<ReactionsResult> ReactAsync(long id, string emoji, CancellationToken ct = default);
    Task<ReadResult> MarkReadAsync(long lastReadId, CancellationToken ct = default);
    Task<UploadResult> UploadAsync(IReadOnlyList<byte[]> jpegs, CancellationToken ct = default);
    Task<List<Member>> MembersAsync(CancellationToken ct = default);
    Task<List<CustomEmoji>> EmojisAsync(CancellationToken ct = default);
    Task<SummaryResult> SummaryAsync(CancellationToken ct = default);
}

/// <summary>/api/agent/* を Bearer の鍵で呼ぶ（native/shared/APIClient.swift と同じ）。</summary>
public sealed class ApiClient : IChatApi, IDisposable
{
    public static readonly Uri DefaultBase = new("https://bsm.backspace.fm");

    private readonly HttpClient http;
    public Uri BaseUri { get; }
    public string Token { get; }

    /// <summary>UA は BguruChatWindows/&lt;版&gt;（iOS は BguruChatMac/ を名乗るので別の接頭辞）。</summary>
    public static string UserAgent(string version) => $"BguruChatWindows/{version}";

    public ApiClient(string token, string version, Uri? baseUri = null, HttpMessageHandler? handler = null)
    {
        Token = token;
        BaseUri = baseUri ?? DefaultBase;
        http = handler is null ? new HttpClient() : new HttpClient(handler);
        http.BaseAddress = BaseUri;
        http.Timeout = TimeSpan.FromSeconds(30);
        http.DefaultRequestHeaders.UserAgent.ParseAdd(UserAgent(version));
        http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
    }

    public void Dispose() => http.Dispose();

    /// <summary>相対のパス（/api/media/… やアバター）を絶対の URL に。</summary>
    public Uri Absolute(string pathOrUrl) =>
        Uri.TryCreate(pathOrUrl, UriKind.Absolute, out var u) && u.Scheme is "http" or "https" ? u : new Uri(BaseUri, pathOrUrl);

    /// <summary>この URL に鍵をつけてよいか（自分のホストだけ）。</summary>
    public bool IsOwnHost(Uri u) =>
        u.Scheme == BaseUri.Scheme && string.Equals(u.Host, BaseUri.Host, StringComparison.OrdinalIgnoreCase) && u.Port == BaseUri.Port;

    /// <summary>自分のホストの画像を鍵つきで読む（/api/media/* は鍵が要る）。ほかのホストは鍵なし。</summary>
    public async Task<byte[]> GetBytesAsync(Uri url, CancellationToken ct = default)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        using var resp = await SendRawAsync(req, ct).ConfigureAwait(false);
        return await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
    }

    public Task<Capabilities> CapabilitiesAsync(CancellationToken ct = default) => GetAsync<Capabilities>("/api/agent/capabilities", ct);
    public Task<ChatPage> ChatAsync(int limit = 100, CancellationToken ct = default) => GetAsync<ChatPage>($"/api/agent/chat?limit={limit}&include=reactions", ct);
    public Task<SummaryResult> SummaryAsync(CancellationToken ct = default) => GetAsync<SummaryResult>("/api/agent/summary", ct);
    public async Task<List<Member>> MembersAsync(CancellationToken ct = default) => (await GetAsync<MembersResult>("/api/agent/members", ct).ConfigureAwait(false)).Members;
    public async Task<List<CustomEmoji>> EmojisAsync(CancellationToken ct = default) => (await GetAsync<EmojisResult>("/api/agent/emojis", ct).ConfigureAwait(false)).Emojis;

    public async Task<ChatMessage> SendAsync(string body, string clientId, IReadOnlyList<string>? images, CancellationToken ct = default)
    {
        var payload = new Dictionary<string, object?> { ["body"] = body, ["client_id"] = clientId };
        if (images is { Count: > 0 }) payload["images"] = images;
        var env = await SendJsonAsync<MessageEnvelope>(HttpMethod.Post, "/api/agent/chat", payload, ct).ConfigureAwait(false);
        return env.Message ?? throw new ApiException(500, null, "message がない");
    }

    public async Task<ChatMessage> EditAsync(long id, string body, CancellationToken ct = default)
    {
        var env = await SendJsonAsync<MessageEnvelope>(HttpMethod.Patch, $"/api/agent/chat/{id}", new { body }, ct).ConfigureAwait(false);
        return env.Message ?? throw new ApiException(500, null, "message がない");
    }

    public Task<ReactionsResult> ReactAsync(long id, string emoji, CancellationToken ct = default) =>
        SendJsonAsync<ReactionsResult>(HttpMethod.Post, $"/api/agent/chat/{id}/reactions", new { emoji }, ct);

    public Task<ReadResult> MarkReadAsync(long lastReadId, CancellationToken ct = default) =>
        SendJsonAsync<ReadResult>(HttpMethod.Post, "/api/agent/chat/read", new { last_read_id = lastReadId }, ct);

    /// <summary>画像を上げる（multipart、欄の名前は images、120 秒）。</summary>
    public async Task<UploadResult> UploadAsync(IReadOnlyList<byte[]> jpegs, CancellationToken ct = default)
    {
        using var form = new MultipartFormDataContent();
        for (var i = 0; i < jpegs.Count; i++)
        {
            var part = new ByteArrayContent(jpegs[i]);
            part.Headers.ContentType = new MediaTypeHeaderValue("image/jpeg");
            form.Add(part, "images", $"photo{i}.jpg");
        }
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(120));
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/agent/chat/upload") { Content = form };
        using var resp = await SendRawAsync(req, cts.Token, longTimeout: true).ConfigureAwait(false);
        return await ReadAsync<UploadResult>(resp, cts.Token).ConfigureAwait(false);
    }

    /// <summary>自分でログアウト（この鍵を取り消す）。</summary>
    public async Task RevokeSelfAsync(CancellationToken ct = default)
    {
        using var req = new HttpRequestMessage(HttpMethod.Delete, "/api/agent/token/self");
        using var _ = await SendRawAsync(req, ct).ConfigureAwait(false);
    }

    /// <summary>ストリーム（SSE）を開く。呼ぶ側が読み終わったら Dispose する。</summary>
    public async Task<HttpResponseMessage> OpenStreamAsync(CancellationToken ct)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, "/api/agent/stream");
        req.Headers.Accept.Clear();
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        return await SendRawAsync(req, ct, headersOnly: true, longTimeout: true).ConfigureAwait(false);
    }

    private async Task<T> GetAsync<T>(string path, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, path);
        using var resp = await SendRawAsync(req, ct).ConfigureAwait(false);
        return await ReadAsync<T>(resp, ct).ConfigureAwait(false);
    }

    private async Task<T> SendJsonAsync<T>(HttpMethod method, string path, object body, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(method, path) { Content = JsonContent.Create(body, options: Json.Options) };
        using var resp = await SendRawAsync(req, ct).ConfigureAwait(false);
        return await ReadAsync<T>(resp, ct).ConfigureAwait(false);
    }

    private static async Task<T> ReadAsync<T>(HttpResponseMessage resp, CancellationToken ct) =>
        await resp.Content.ReadFromJsonAsync<T>(Json.Options, ct).ConfigureAwait(false)
        ?? throw new ApiException((int)resp.StatusCode, null, "空の応答");

    private HttpClient? longClient;

    /// <summary>鍵は要求ごとに、自分のホスト宛てのときだけつける（ほかのホストの画像などには渡さない）。</summary>
    private async Task<HttpResponseMessage> SendRawAsync(HttpRequestMessage req, CancellationToken ct,
        bool headersOnly = false, bool longTimeout = false)
    {
        var target = req.RequestUri is null ? BaseUri : req.RequestUri.IsAbsoluteUri ? req.RequestUri : new Uri(BaseUri, req.RequestUri);
        if (IsOwnHost(target)) req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        var client = http;
        if (longTimeout)
        {
            // ストリーム・アップロードは 30 秒で切らない（ストリームの無言は LiveStream が 70 秒で見る）
            longClient ??= CloneForLongRequests();
            client = longClient;
        }
        var resp = await client.SendAsync(req, headersOnly ? HttpCompletionOption.ResponseHeadersRead : HttpCompletionOption.ResponseContentRead, ct)
            .ConfigureAwait(false);
        if (resp.IsSuccessStatusCode) return resp;
        using (resp)
        {
            ApiErrorBody? err = null;
            try { err = await resp.Content.ReadFromJsonAsync<ApiErrorBody>(Json.Options, ct).ConfigureAwait(false); }
            catch (JsonException) { }
            catch (NotSupportedException) { }
            throw new ApiException((int)resp.StatusCode, err?.Code, err?.Error, err?.Hint);
        }
    }

    private HttpClient CloneForLongRequests()
    {
        var c = new HttpClient { BaseAddress = BaseUri, Timeout = Timeout.InfiniteTimeSpan };
        foreach (var h in http.DefaultRequestHeaders) c.DefaultRequestHeaders.TryAddWithoutValidation(h.Key, h.Value);
        return c;
    }

    /// <summary>
    /// ログイン: WebView2 の Web のセッション（Cookie）から、このアプリの鍵を受け取る（POST /api/agent/token）。
    /// 400「本まで」= 鍵の上限、403 membership_ended。
    /// </summary>
    public static async Task<TokenResult> IssueTokenAsync(string cookieHeader, string deviceName, string version,
        Uri? baseUri = null, HttpMessageHandler? handler = null, CancellationToken ct = default)
    {
        var b = baseUri ?? DefaultBase;
        // Cookie は手で付ける（Cookie の入れ物を使うと手で付けた Cookie が送られないことがある）
        using var http = handler is null ? new HttpClient(new HttpClientHandler { UseCookies = false }) : new HttpClient(handler);
        http.Timeout = TimeSpan.FromSeconds(30);
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri(b, "/api/agent/token"));
        req.Headers.UserAgent.ParseAdd(UserAgent(version));
        req.Headers.TryAddWithoutValidation("Cookie", cookieHeader);
        req.Headers.TryAddWithoutValidation("Origin", b.GetLeftPart(UriPartial.Authority));
        req.Content = JsonContent.Create(new
        {
            device_name = DeviceName(deviceName),
            scopes = new[] { "read", "read_state", "chat", "post", "voice" },
            replace_same_device = true,
        }, options: Json.Options);
        using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
        if (resp.StatusCode == HttpStatusCode.Created || resp.IsSuccessStatusCode)
            return await resp.Content.ReadFromJsonAsync<TokenResult>(Json.Options, ct).ConfigureAwait(false)
                   ?? throw new ApiException((int)resp.StatusCode, null, "空の応答");
        ApiErrorBody? err = null;
        try { err = await resp.Content.ReadFromJsonAsync<ApiErrorBody>(Json.Options, ct).ConfigureAwait(false); }
        catch (JsonException) { }
        throw new ApiException((int)resp.StatusCode, err?.Code, err?.Error, err?.Hint);
    }

    /// <summary>端末名（100 字まで。同じ端末の古い鍵は replace_same_device で取り消される）。</summary>
    public static string DeviceName(string machine)
    {
        var name = $"B-guru Chat (Windows) {machine}".Trim();
        return name.Length <= 100 ? name : name[..100];
    }

    /// <summary>鍵の上限（10 本）に当たったか。</summary>
    public static bool IsTokenLimit(ApiException e) => e.Status == 400 && e.Message.Contains("本まで", StringComparison.Ordinal);
}
