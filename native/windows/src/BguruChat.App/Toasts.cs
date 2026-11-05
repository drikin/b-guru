using BguruChat.Core;
using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;

namespace BguruChat.App;

/// <summary>トーストを押した・返信した・❤️ を押した。</summary>
public sealed record ToastAction(string Action, long MessageId, string? ReplyText);

/// <summary>
/// Windows のトースト通知（Mac の UNUserNotification にあたる）。メンションは 1 件ずつ（chat-&lt;id&gt;）、
/// ほかの新着は 1 つにまとめて上書き（chat-new）。返信と ❤️ のボタンつき。既読になったら消す。
/// </summary>
public sealed class Toasts : IDisposable
{
    private const string Group = "chat";
    private bool registered;

    /// <summary>トーストが押された（UI のスレッドとは限らない）。</summary>
    public event Action<ToastAction>? Invoked;

    public void Register()
    {
        try
        {
            AppNotificationManager.Default.NotificationInvoked += (_, e) => Invoked?.Invoke(Parse(e.Arguments, e.UserInput));
            AppNotificationManager.Default.Register();
            registered = true;
        }
        catch (Exception) { registered = false; } // 通知が使えない環境でもアプリは動かす
    }

    /// <summary>起動のきっかけがトーストだったとき（アプリが閉じていた）。</summary>
    public static ToastAction Parse(IDictionary<string, string> args, IDictionary<string, string>? input)
    {
        args.TryGetValue("action", out var action);
        args.TryGetValue("id", out var idText);
        long.TryParse(idText, out var id);
        string? reply = null;
        if (input is not null && input.TryGetValue("reply", out var r)) reply = r;
        return new ToastAction(action ?? "open", id, reply);
    }

    public void ShowMention(ChatMessage m, bool sound) =>
        Show($"chat-{m.Id}", $"{m.AuthorName ?? "だれか"} がメンションしました", NewMessageBundle.Preview(m), m.Id, sound, withReply: true);

    public void ShowBundle(NewMessageBundle bundle, long newestId, bool sound)
    {
        var (title, body) = bundle.Text();
        Show(NewMessageBundle.Tag, title, body, newestId, sound, withReply: true);
    }

    private void Show(string tag, string title, string body, long id, bool sound, bool withReply)
    {
        if (!registered) return;
        try
        {
            var b = new AppNotificationBuilder()
                .AddArgument("action", "open")
                .AddArgument("id", id.ToString())
                .AddText(title)
                .AddText(body)
                .SetTag(tag)
                .SetGroup(Group);
            if (withReply)
            {
                b.AddTextBox("reply", "返信を入力", "");
                b.AddButton(new AppNotificationButton("送信").AddArgument("action", "reply").AddArgument("id", id.ToString()).SetInputId("reply"));
                b.AddButton(new AppNotificationButton("❤️").AddArgument("action", "heart").AddArgument("id", id.ToString()));
            }
            if (!sound) b.MuteAudio();
            AppNotificationManager.Default.Show(b.BuildNotification());
        }
        catch (Exception) { }
    }

    public async void Remove(string tag)
    {
        if (!registered) return;
        try { await AppNotificationManager.Default.RemoveByTagAndGroupAsync(tag, Group); } catch (Exception) { }
    }

    public async void RemoveAll()
    {
        if (!registered) return;
        try { await AppNotificationManager.Default.RemoveAllAsync(); } catch (Exception) { }
    }

    public void Dispose()
    {
        if (!registered) return;
        try { AppNotificationManager.Default.Unregister(); } catch (Exception) { }
    }
}
