using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using BguruChat.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;

namespace BguruChat.App;

/// <summary>リアクションの 1 つ（押すと切り替え）。</summary>
public sealed class ReactionChip(long messageId, Reaction r)
{
    public long MessageId { get; } = messageId;
    public string Emoji { get; } = r.Emoji;
    public string Label { get; } = $"{r.Emoji} {r.Count}";
    public bool Mine { get; } = r.Mine;
    public string Tooltip { get; } = r.Reactors.Count > 0 ? string.Join("、", r.Reactors) : r.Emoji;
}

/// <summary>チャットの 1 行の見た目（ChatStore の ChatRow から作る。Key が同じなら中身だけ差し替える）。</summary>
public sealed class RowViewModel : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    public string Key { get; }
    public ChatRow Row { get; private set; }

    public RowViewModel(ChatRow row)
    {
        Key = row.Key;
        Row = row;
    }

    public long Id => Row.Message.Id;
    public string Name => Row.Message.AuthorName ?? (Row.Message.IsAuthor ? "わたし" : "");
    public string Body => Row.Message.DisplayBody;
    public string Time => Row.Message.CreatedAt.ToLocalTime().ToString("HH:mm") + (Row.Message.Edited ? "（編集済み）" : "");
    public bool IsMine => Row.Message.IsAuthor;
    public bool IsNotice => Row.Message.IsNotice;
    public bool MentionsMe => Row.Message.MentionsMe;
    public bool HasBody => Body.Length > 0;
    public bool HasImages => Row.Message.Images.Count > 0;
    public string Status => Row.State switch
    {
        RowState.Pending => "送信中…",
        RowState.Failed => "送れませんでした（右クリックで再送・取り消し）",
        _ => "",
    };
    public bool HasStatus => Status.Length > 0;
    public List<ReactionChip> Reactions =>
        (Row.Message.Reactions ?? []).Select(r => new ReactionChip(Row.Message.Id, r)).ToList();
    public bool HasReactions => Row.Message.Reactions is { Count: > 0 };

    private ImageSource? avatar;
    public ImageSource? Avatar { get => avatar; set { avatar = value; Raise(); } }
    public string Initial => Name.Length > 0 ? Name[..1] : "?";

    public ObservableCollection<ImageSource> Images { get; } = [];

    private bool highlighted;
    /// <summary>トーストから開いたときに少し光らせる。</summary>
    public bool Highlighted { get => highlighted; set { highlighted = value; Raise(); Raise(nameof(Background)); } }

    private bool unreadLine;
    /// <summary>「ここから未読」の線をこの行の上に出す。</summary>
    public bool UnreadLine { get => unreadLine; set { unreadLine = value; Raise(); } }

    public Brush? Background =>
        Highlighted ? (Brush)Application.Current.Resources["MentionBackground"]
        : MentionsMe ? (Brush)Application.Current.Resources["MentionBackground"]
        : null;

    /// <summary>中身を差し替える（変わったところを知らせる）。画像が変わったら呼ぶ側が読み直す。</summary>
    public bool Update(ChatRow row)
    {
        var imagesChanged = !row.Message.Images.SequenceEqual(Row.Message.Images);
        Row = row;
        Raise(string.Empty); // すべて
        return imagesChanged;
    }

    private void Raise([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

/// <summary>x:Bind で使う小さな変換。</summary>
public static class Conv
{
    public static Visibility Show(bool v) => v ? Visibility.Visible : Visibility.Collapsed;
    public static Visibility Hide(bool v) => v ? Visibility.Collapsed : Visibility.Visible;
    public static HorizontalAlignment Side(bool mine) => mine ? HorizontalAlignment.Right : HorizontalAlignment.Left;
    public static Visibility NoImage(ImageSource? s) => s is null ? Visibility.Visible : Visibility.Collapsed;
}
