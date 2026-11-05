using System.Text.Json;
using System.Text.Json.Serialization;

namespace BguruChat.Core;

/// <summary>JSON の読み書き（サーバは snake_case）。Swift の convertFromSnakeCase と同じ。</summary>
public static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };
}

/// <summary>チャットのリアクション（src/lib/reactions.ts）。</summary>
public sealed record Reaction
{
    public string Emoji { get; init; } = "";
    public int Count { get; init; }
    public bool Mine { get; init; }
    public List<string> Reactors { get; init; } = [];
}

/// <summary>チャットの 1 件（src/lib/agent-chat.ts の AgentChatMessageDto）。</summary>
public sealed record ChatMessage
{
    public const string PhotoOnlyBody = "📷 写真";

    public long Id { get; init; }
    public string? AuthorId { get; init; }
    public string? AuthorName { get; init; }
    public string? Avatar { get; init; }
    public string Body { get; init; } = "";
    public DateTimeOffset CreatedAt { get; init; }
    public bool Edited { get; init; }
    public DateTimeOffset? EditedAt { get; init; }
    public bool IsAuthor { get; init; }
    public bool MentionsMe { get; init; }
    public string? ClientId { get; init; }
    public List<Reaction>? Reactions { get; init; }
    public List<string> Images { get; init; } = [];
    /// <summary>"notice"（静かな知らせ）・"shogi"・"beagle_ai"、ふつうの発言は null。</summary>
    public string? Kind { get; init; }
    public long? ShogiGameId { get; init; }
    public long? ReplyToId { get; init; }

    /// <summary>送信中の仮の行（id が負）。</summary>
    [JsonIgnore] public bool IsPending => Id < 0;
    [JsonIgnore] public bool IsNotice => Kind == "notice";
    [JsonIgnore] public bool IsBeagleAI => Kind == "beagle_ai";

    /// <summary>見せる本文。写真だけの発言の「📷 写真」は出さない。</summary>
    [JsonIgnore] public string DisplayBody => Images.Count > 0 && Body == PhotoOnlyBody ? "" : Body;
}

public sealed record ChatPage
{
    public int UnreadCount { get; init; }
    public long? LatestId { get; init; }
    public long? LastReadId { get; init; }
    public List<ChatMessage> Messages { get; init; } = [];
}

public sealed record MessageEnvelope
{
    public ChatMessage? Message { get; init; }
}

public sealed record ReactionsResult
{
    public bool Added { get; init; }
    public List<Reaction> Reactions { get; init; } = [];
}

public sealed record ReadResult
{
    public int UnreadCount { get; init; }
    public long? LatestId { get; init; }
}

public sealed record UploadResult
{
    public List<string> Urls { get; init; } = [];
}

public sealed record Member
{
    public string UserId { get; init; } = "";
    public string Name { get; init; } = "";
    public string? Avatar { get; init; }
}

public sealed record MembersResult
{
    public List<Member> Members { get; init; } = [];
}

public sealed record CustomEmoji
{
    public string Name { get; init; } = "";
    public string Url { get; init; } = "";
}

public sealed record EmojisResult
{
    public List<CustomEmoji> Emojis { get; init; } = [];
}

public sealed record SummaryResult
{
    public SummaryCount? Chat { get; init; }
    public SummaryCount? Notifications { get; init; }
    public int OnlineCount { get; init; }
}

public sealed record SummaryCount
{
    public int UnreadCount { get; init; }
    public long? LatestId { get; init; }
}

public sealed record TokenResult
{
    public string Token { get; init; } = "";
    public DateTimeOffset? ExpiresAt { get; init; }
    public string? UserId { get; init; }
}

/// <summary>
/// GET /api/agent/capabilities。形が増えていくので、使うところだけ型にし、ほかは生の JSON のまま持つ。
/// 無い機能は出さない（Models.swift と同じ考え）。
/// </summary>
public sealed record Capabilities
{
    public JsonElement Features { get; init; }

    public JsonElement? Feature(string name) =>
        Features.ValueKind == JsonValueKind.Object && Features.TryGetProperty(name, out var f) ? f : null;

    public bool Has(string feature, string flag)
    {
        if (Feature(feature) is not { } f || f.ValueKind != JsonValueKind.Object) return false;
        return f.TryGetProperty(flag, out var v) && v.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.String => v.GetString()!.Length > 0,
            JsonValueKind.Number => true,
            _ => false,
        };
    }

    public int Int(string feature, string key, int fallback)
    {
        if (Feature(feature) is { ValueKind: JsonValueKind.Object } f && f.TryGetProperty(key, out var v)
            && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n)) return n;
        return fallback;
    }

    public ChatLimits Chat => new(
        MaxBody: Int("chat", "max_body", 1000),
        MaxImages: Int("chat", "max_images", 4),
        ImageMaxSide: Int("chat", "image_max_side", 1280),
        CanSend: Has("chat", "send"),
        CanEditOwn: Has("chat", "edit_own"),
        Reactions: Has("chat", "reactions"),
        CustomEmoji: Has("chat", "custom_emoji"),
        MarkRead: Has("chat", "mark_read"),
        Images: Has("chat", "images"));
}

public sealed record ChatLimits(int MaxBody, int MaxImages, int ImageMaxSide, bool CanSend, bool CanEditOwn,
    bool Reactions, bool CustomEmoji, bool MarkRead, bool Images);

/// <summary>サーバのエラー（{error, code, hint?}）。</summary>
public sealed record ApiErrorBody
{
    public string? Error { get; init; }
    public string? Code { get; init; }
    public string? Hint { get; init; }
}

public class ApiException(int status, string? code, string? message, string? hint = null)
    : Exception(message ?? $"HTTP {status}")
{
    public int Status { get; } = status;
    public string? Code { get; } = code;
    public string? Hint { get; } = hint;

    /// <summary>鍵が無効・期限切れ・会員でなくなった（ログアウトする）。</summary>
    public bool IsUnauthorized => Status == 401 || (Status == 403 && Code == "membership_ended");

    /// <summary>やり直しても通らない（4xx のうち 408・429 以外）。APIClient.swift と同じ。</summary>
    public bool IsPermanent => Status is >= 400 and < 500 and not 408 and not 429;
}
