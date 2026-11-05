namespace BguruChat.Core;

public enum NotifyMode { All, Mentions }

/// <summary>通知の設定（Mac の AppSettings と同じ既定: すべて・静かな時間あり）。</summary>
public sealed record NotifySettings(NotifyMode Mode = NotifyMode.All, bool QuietHours = true);

/// <summary>新着をどう知らせるか（App.swift の mention / newMessage と同じ決まり）。</summary>
public enum NotifyKind { None, Mention, NewMessage }

public static class NotifyPolicy
{
    /// <summary>静かな時間（手元の時刻で 0:00〜7:00）。</summary>
    public static bool IsQuiet(DateTime local, bool enabled) => enabled && local.Hour < 7;

    /// <summary>
    /// 新しく届いた 1 件を知らせるか。自分の・notice・beagle_ai はしない。パネルが見えているなら知らせず既読にする（呼ぶ側）。
    /// メンションはいつでも（静かな時間は音なし）、それ以外は「すべて」で静かな時間でないときだけ。
    /// </summary>
    public static NotifyKind Decide(ChatMessage m, bool panelVisible, NotifySettings s, DateTime local)
    {
        if (m.IsAuthor || m.IsNotice || m.IsBeagleAI || m.IsPending || panelVisible) return NotifyKind.None;
        if (m.MentionsMe) return NotifyKind.Mention;
        if (s.Mode != NotifyMode.All || IsQuiet(local, s.QuietHours)) return NotifyKind.None;
        return NotifyKind.NewMessage;
    }

    /// <summary>音を鳴らすか（静かな時間は鳴らさない）。</summary>
    public static bool PlaysSound(NotifySettings s, DateTime local) => !IsQuiet(local, s.QuietHours);
}

/// <summary>
/// 「ほかの新着」を 1 つの通知にまとめる（App.swift の chat-new と同じ: "名前: 本文\n（ほか N 件の新着）"、最初の 1 件だけ音）。
/// パネルを開いた・既読が届いたら消す。
/// </summary>
public sealed class NewMessageBundle
{
    public const string Tag = "chat-new";
    private readonly List<ChatMessage> items = [];

    public int Count => items.Count;
    public long? NewestId => items.Count == 0 ? null : items[^1].Id;

    /// <summary>1 件足し、音を鳴らすか（まとまりの最初の 1 件だけ）を返す。</summary>
    public bool Add(ChatMessage m)
    {
        items.Add(m);
        return items.Count == 1;
    }

    public (string Title, string Body) Text()
    {
        var last = items[^1];
        var body = $"{last.AuthorName ?? "だれか"}: {Preview(last)}";
        if (items.Count > 1) body += $"\n（ほか {items.Count - 1} 件の新着）";
        return ("B-guru チャット", body);
    }

    public void Clear() => items.Clear();

    /// <summary>既読が up_to まで届いた: まとめの最新がそこまでなら消す（消したら true）。</summary>
    public bool ClearIfCovered(long upTo)
    {
        if (NewestId is { } n && n <= upTo) { items.Clear(); return true; }
        return false;
    }

    public static string Preview(ChatMessage m)
    {
        var b = m.DisplayBody.Trim();
        if (b.Length == 0 && m.Images.Count > 0) return "📷 写真";
        return b.Length > 120 ? b[..120] + "…" : b;
    }
}
