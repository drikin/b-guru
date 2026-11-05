using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;

namespace BguruChat.Core;

/// <summary>ストリームの 1 件（event: 名前、data: 1 行の JSON）。</summary>
public sealed record ServerEvent(string Name, string Data)
{
    public T? As<T>() => JsonSerializer.Deserialize<T>(Data, Json.Options);
}

/// <summary>
/// SSE の行を読んでイベントにする（native/shared/LiveStream.swift と同じ）。空行で区切る。
/// ":" で始まる行は heartbeat。data: が完全な JSON になった時点でも出す（区切りの空行が来ない実装への備え）。
/// </summary>
public sealed class SseParser
{
    private string name = "message";
    private readonly StringBuilder data = new();

    /// <summary>1 行を渡す（改行は含めない）。イベントができたら返す。</summary>
    public ServerEvent? Feed(string line)
    {
        if (line.Length == 0) return Flush();
        if (line[0] == ':') return null;
        if (line.StartsWith("event:", StringComparison.Ordinal))
        {
            name = line[6..].Trim();
            return null;
        }
        if (line.StartsWith("data:", StringComparison.Ordinal))
        {
            if (data.Length > 0) data.Append('\n');
            data.Append(line[5..].Trim());
            var s = data.ToString();
            if (s.EndsWith('}') && IsCompleteJson(s)) return Flush();
        }
        return null;
    }

    private ServerEvent? Flush()
    {
        ServerEvent? ev = data.Length > 0 ? new ServerEvent(name, data.ToString()) : null;
        name = "message";
        data.Clear();
        return ev;
    }

    private static bool IsCompleteJson(string s)
    {
        try
        {
            using var _ = JsonDocument.Parse(s);
            return true;
        }
        catch (JsonException) { return false; }
    }
}

/// <summary>
/// 再接続の待ち時間: 1 秒から倍々・最大 30 秒・±20%。10 秒以上つながっていたら 1 秒に戻す（ChatStore.swift と同じ）。
/// </summary>
public sealed class Backoff(Func<double>? random = null)
{
    public static readonly TimeSpan Min = TimeSpan.FromSeconds(1);
    public static readonly TimeSpan Max = TimeSpan.FromSeconds(30);
    public static readonly TimeSpan HealthyAfter = TimeSpan.FromSeconds(10);

    private readonly Func<double> random = random ?? Random.Shared.NextDouble;
    private TimeSpan current = Min;

    /// <summary>切れたあとに呼ぶ。connected = その接続が続いた時間（つながらなかったら 0）。</summary>
    public TimeSpan Next(TimeSpan connected)
    {
        if (connected >= HealthyAfter) current = Min;
        var jitter = 0.8 + random() * 0.4;
        var wait = TimeSpan.FromMilliseconds(current.TotalMilliseconds * jitter);
        current = TimeSpan.FromMilliseconds(Math.Min(current.TotalMilliseconds * 2, Max.TotalMilliseconds));
        return wait;
    }

    public void Reset() => current = Min;
}

/// <summary>GET /api/agent/stream を読み続ける。70 秒なにも来なければ切れたとみなす（サーバは 25 秒ごとに heartbeat）。</summary>
public static class LiveStream
{
    public static readonly TimeSpan IdleTimeout = TimeSpan.FromSeconds(70);

    public static async IAsyncEnumerable<ServerEvent> ReadAsync(ApiClient api, [EnumeratorCancellation] CancellationToken ct)
    {
        using var resp = await api.OpenStreamAsync(ct).ConfigureAwait(false);
        await using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var parser = new SseParser();
        while (!ct.IsCancellationRequested)
        {
            using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);
            idle.CancelAfter(IdleTimeout);
            string? line;
            try
            {
                line = await reader.ReadLineAsync(idle.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                throw new TimeoutException("ストリームが 70 秒なにも送ってこない");
            }
            if (line is null) yield break; // サーバが閉じた
            if (parser.Feed(line) is { } ev) yield return ev;
        }
    }
}
