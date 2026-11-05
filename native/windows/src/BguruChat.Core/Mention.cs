namespace BguruChat.Core;

/// <summary>@メンション（native/shared/Mention.swift・src/lib/chat-mention.ts と同じ書き方: "@name " か "@[First Last] "）。</summary>
public static class Mention
{
    public static string Token(string name) => name.Any(char.IsWhiteSpace) ? $"@[{name}] " : $"@{name} ";

    /// <summary>小文字にし、空白（全角も）をすべて除く。</summary>
    public static string Norm(string s) => new(s.ToLowerInvariant().Where(c => !char.IsWhiteSpace(c) && c != '　').ToArray());

    /// <summary>末尾で入力中の "@query"（先頭か空白の後の @、そのあと空白なし。"@[" は "]" まで）。なければ null。</summary>
    public static (int Start, string Query)? ActiveQuery(string text)
    {
        var at = text.LastIndexOf('@');
        if (at < 0) return null;
        if (at > 0 && !char.IsWhiteSpace(text[at - 1])) return null;
        var rest = text[(at + 1)..];
        if (rest.StartsWith('['))
        {
            rest = rest[1..];
            return rest.Contains(']') ? null : (at, rest);
        }
        return rest.Any(char.IsWhiteSpace) ? null : (at, rest);
    }

    /// <summary>末尾の "@query" を、その人のトークンに置き換える。</summary>
    public static string Complete(string text, string name) =>
        ActiveQuery(text) is { } q ? text[..q.Start] + Token(name) : text + Token(name);

    /// <summary>候補（名前に含む人、前方一致を先に、最近チャットで話した人を先に）。</summary>
    public static List<Member> Candidates(IEnumerable<Member> members, string query, IReadOnlyList<string> recent, int limit = 6)
    {
        var q = Norm(query);
        var rank = new Dictionary<string, int>();
        for (var i = 0; i < recent.Count; i++) rank.TryAdd(recent[i], i);
        return members
            .Where(m => q.Length == 0 || Norm(m.Name).Contains(q, StringComparison.Ordinal))
            .OrderBy(m => Norm(m.Name).StartsWith(q, StringComparison.Ordinal) ? 0 : 1)
            .ThenBy(m => rank.TryGetValue(m.Name, out var r) ? r : int.MaxValue)
            .ThenBy(m => m.Name, StringComparer.Ordinal)
            .Take(limit)
            .ToList();
    }
}
