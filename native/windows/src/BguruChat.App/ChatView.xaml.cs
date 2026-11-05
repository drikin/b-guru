using System.Collections.ObjectModel;
using System.Diagnostics;
using BguruChat.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage.Pickers;
using Windows.System;

namespace BguruChat.App;

/// <summary>
/// チャットの画面（パネルの中身）。決め方は ChatStore、ここは見せ方と入力だけ。
/// 一覧は Key ごとに差し替えるので、新着でスクロールの位置が飛ばない。一番下にいるときだけ新着で下へ付いていく。
/// </summary>
public sealed partial class ChatView : UserControl
{
    public ObservableCollection<RowViewModel> Rows { get; } = [];

    private ChatStore? store;
    private MediaCache? media;
    private Func<nint>? windowHandle;
    private readonly List<byte[]> attachments = [];
    private long? editingId;
    private static readonly string[] QuickReactions = ["❤️", "👍", "😂", "🙏", "🎉", "👀"];

    /// <summary>メニュー（⋯）の中身。App が作る（通知の設定・ログアウトなど）。</summary>
    public Func<MenuFlyout>? BuildMenu { get; set; }

    public ChatView()
    {
        InitializeComponent();
    }

    public void Attach(ChatStore s, MediaCache m, Func<nint> hwnd)
    {
        store = s;
        media = m;
        windowHandle = hwnd;
        store.Changed += Sync;
        Sync();
    }

    public void Detach()
    {
        if (store is not null) store.Changed -= Sync;
        store = null;
        Rows.Clear();
    }

    // MARK: - 一覧

    private bool IsNearBottom()
    {
        if (FindScrollViewer(List) is not { } sv) return true;
        return sv.VerticalOffset >= sv.ScrollableHeight - 48;
    }

    private static ScrollViewer? FindScrollViewer(DependencyObject root)
    {
        if (root is ScrollViewer sv) return sv;
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(root); i++)
            if (FindScrollViewer(VisualTreeHelper.GetChild(root, i)) is { } found) return found;
        return null;
    }

    private void Sync()
    {
        if (store is null) return;
        var stick = IsNearBottom();
        var added = false;
        var target = store.Rows;
        var wanted = target.Select(r => r.Key).ToHashSet();
        for (var i = Rows.Count - 1; i >= 0; i--)
            if (!wanted.Contains(Rows[i].Key)) Rows.RemoveAt(i);
        for (var i = 0; i < target.Count; i++)
        {
            var row = target[i];
            if (i < Rows.Count && Rows[i].Key == row.Key)
            {
                if (!ReferenceEquals(Rows[i].Row, row) && Rows[i].Update(row)) LoadImages(Rows[i]);
                continue;
            }
            var existing = Rows.Skip(i).FirstOrDefault(r => r.Key == row.Key);
            if (existing is not null)
            {
                Rows.Move(Rows.IndexOf(existing), i);
                if (existing.Update(row)) LoadImages(existing);
                continue;
            }
            var vm = new RowViewModel(row);
            Rows.Insert(i, vm);
            LoadAvatar(vm);
            LoadImages(vm);
            added = true;
        }
        UpdateStatus();
        if (added && stick && Rows.Count > 0) List.ScrollIntoView(Rows[^1]);
    }

    private void UpdateStatus()
    {
        if (store is null) return;
        StatusText.Text = store.Connection switch
        {
            Connection.Live => store.OnlineCount > 0 ? $"🟢 {store.OnlineCount} 人" : "",
            Connection.Connecting => "つないでいます…",
            _ => "オフライン（つなぎ直しています）",
        };
    }

    private async void LoadAvatar(RowViewModel vm)
    {
        if (media is null || vm.Row.Message.Avatar is not { } a) return;
        vm.Avatar = await media.GetAsync(a, 64);
    }

    private async void LoadImages(RowViewModel vm)
    {
        if (media is null) return;
        vm.Images.Clear();
        foreach (var path in vm.Row.Message.Images)
            if (await media.GetAsync(path, 480) is { } img) vm.Images.Add(img);
        if (IsNearBottom() && Rows.Count > 0 && Rows[^1] == vm) List.ScrollIntoView(vm);
    }

    /// <summary>パネルを開いた: 「ここから未読」の線を引き、未読の始まり（なければ一番下）へ。</summary>
    public void OnShown(long? readCursorBefore)
    {
        foreach (var r in Rows) r.UnreadLine = false;
        RowViewModel? first = null;
        if (readCursorBefore is { } c)
            first = Rows.FirstOrDefault(r => r.Id > c && !r.IsMine && !r.IsNotice);
        if (first is not null)
        {
            first.UnreadLine = true;
            List.ScrollIntoView(first, ScrollIntoViewAlignment.Leading);
        }
        else if (Rows.Count > 0) List.ScrollIntoView(Rows[^1]);
        Composer.Focus(FocusState.Programmatic);
    }

    /// <summary>トーストから: その発言へ行って少し光らせる。</summary>
    public async void Reveal(long id)
    {
        var vm = Rows.FirstOrDefault(r => r.Id == id);
        if (vm is null) return;
        List.ScrollIntoView(vm, ScrollIntoViewAlignment.Leading);
        vm.Highlighted = true;
        await Task.Delay(1600);
        vm.Highlighted = false;
    }

    // MARK: - 右クリック

    private void Row_RightTapped(object sender, RightTappedRoutedEventArgs e)
    {
        if (store is null || sender is not FrameworkElement fe || fe.Tag is not string key) return;
        var vm = Rows.FirstOrDefault(r => r.Key == key);
        if (vm is null) return;
        var menu = new MenuFlyout();
        var m = vm.Row.Message;
        if (vm.Row.State == RowState.Failed)
        {
            menu.Items.Add(Item("再送", () => _ = store.RetryAsync(vm.Row)));
            menu.Items.Add(Item("取り消す", () => store.Discard(vm.Row)));
        }
        else if (m.Id > 0 && !m.IsNotice)
        {
            if (store.Limits.Reactions)
            {
                var sub = new MenuFlyoutSubItem { Text = "リアクション" };
                foreach (var emoji in QuickReactions) sub.Items.Add(Item(emoji, () => _ = store.ToggleReactionAsync(m.Id, emoji)));
                menu.Items.Add(sub);
            }
            if (m.AuthorName is { Length: > 0 } name && !m.IsAuthor)
                menu.Items.Add(Item($"@{name} に返信", () => InsertMention(name)));
            if (m.IsAuthor && store.Limits.CanEditOwn && m.CreatedAt > DateTimeOffset.Now.AddHours(-24))
                menu.Items.Add(Item("編集", () => BeginEdit(m)));
            menu.Items.Add(Item("本文をコピー", () => Copy(m.DisplayBody)));
        }
        if (menu.Items.Count > 0) menu.ShowAt(fe, e.GetPosition(fe));
        e.Handled = true;
    }

    private static MenuFlyoutItem Item(string text, Action action)
    {
        var i = new MenuFlyoutItem { Text = text };
        i.Click += (_, _) => action();
        return i;
    }

    private static void Copy(string text)
    {
        var p = new DataPackage();
        p.SetText(text);
        Clipboard.SetContent(p);
    }

    private void Reaction_Click(object sender, RoutedEventArgs e)
    {
        if (store is not null && sender is FrameworkElement { Tag: ReactionChip chip })
            _ = store.ToggleReactionAsync(chip.MessageId, chip.Emoji);
    }

    /// <summary>
    /// 画像を押した: 元の大きさで、Windows の写真アプリなどで開く（鍵が要るので一度ファイルにする）。
    /// 名前と拡張子はこちらで決める（サーバの値のまま ShellExecute しない。チャットの画像は jpg・png・webp・gif だけ）。
    /// </summary>
    private async void Image_Tapped(object sender, TappedRoutedEventArgs e)
    {
        try
        {
            if (media is null || sender is not Image img) return;
            var vm = Rows.FirstOrDefault(r => r.Images.Contains(img.Source));
            if (vm is null) return;
            var index = vm.Images.IndexOf(img.Source);
            if (index < 0 || index >= vm.Row.Message.Images.Count) return;
            var path = vm.Row.Message.Images[index];
            var m = System.Text.RegularExpressions.Regex.Match(path, @"^/api/media/chat-[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp|gif)$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (!m.Success) return;
            if (await media.GetBytesAsync(path) is not { } bytes) return;
            var name = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(path)))[..16];
            var dir = Path.Combine(Path.GetTempPath(), "BguruChat");
            Directory.CreateDirectory(dir);
            var file = Path.Combine(dir, $"{name}.{m.Groups[1].Value.ToLowerInvariant()}");
            await File.WriteAllBytesAsync(file, bytes);
            Process.Start(new ProcessStartInfo(file) { UseShellExecute = true });
        }
        catch (Exception ex) { App.Log("image open: " + ex.Message); }
    }

    private void MenuButton_Click(object sender, RoutedEventArgs e)
    {
        if (BuildMenu?.Invoke() is { } menu) menu.ShowAt(MenuButton);
    }

    // MARK: - 入力

    private void Composer_PreviewKeyDown(object sender, KeyRoutedEventArgs e)
    {
        var shift = Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift)
            .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
        if (e.Key == VirtualKey.Enter && !shift)
        {
            if (Suggestions.Visibility == Visibility.Visible && Suggestions.SelectedItem is Member pick)
            {
                Pick(pick);
            }
            else
            {
                Send();
            }
            e.Handled = true;
        }
        else if (e.Key == VirtualKey.Escape)
        {
            if (Suggestions.Visibility == Visibility.Visible) Suggestions.Visibility = Visibility.Collapsed;
            else if (editingId is not null) CancelEdit();
            else return;
            e.Handled = true;
        }
        else if (Suggestions.Visibility == Visibility.Visible && e.Key is VirtualKey.Up or VirtualKey.Down)
        {
            var n = Suggestions.Items.Count;
            if (n == 0) return;
            var i = Suggestions.SelectedIndex + (e.Key == VirtualKey.Down ? 1 : -1);
            Suggestions.SelectedIndex = (i + n) % n;
            e.Handled = true;
        }
        else if (e.Key == VirtualKey.Up && Composer.Text.Length == 0 && store?.LastOwnMessage is { } last
                 && store.Limits.CanEditOwn && last.CreatedAt > DateTimeOffset.Now.AddHours(-24))
        {
            BeginEdit(last); // ↑ で自分の最後の発言を直す（Mac と同じ）
            e.Handled = true;
        }
    }

    private void Composer_TextChanged(object sender, TextChangedEventArgs e)
    {
        if (store is null) return;
        var before = Composer.Text[..Math.Min(Composer.SelectionStart, Composer.Text.Length)];
        if (Mention.ActiveQuery(before) is { } q)
        {
            var list = Mention.Candidates(store.Members, q.Query, store.RecentSpeakers());
            Suggestions.ItemsSource = list;
            Suggestions.Visibility = list.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
            if (list.Count > 0) Suggestions.SelectedIndex = 0;
        }
        else
        {
            Suggestions.Visibility = Visibility.Collapsed;
        }
    }

    private void Suggestions_ItemClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is Member m) Pick(m);
    }

    private void Pick(Member m)
    {
        var caret = Math.Min(Composer.SelectionStart, Composer.Text.Length);
        var before = Composer.Text[..caret];
        var after = Composer.Text[caret..];
        var done = Mention.Complete(before, m.Name);
        Composer.Text = done + after;
        Composer.SelectionStart = done.Length;
        Suggestions.Visibility = Visibility.Collapsed;
        Composer.Focus(FocusState.Programmatic);
    }

    private void InsertMention(string name)
    {
        var token = Mention.Token(name);
        Composer.Text = token + Composer.Text;
        Composer.SelectionStart = Composer.Text.Length;
        Composer.Focus(FocusState.Programmatic);
    }

    /// <summary>ほかから（トーストの返信の代わりに開いたときなど）入力欄に文字を入れる。</summary>
    public void Prefill(string text)
    {
        Composer.Text = text;
        Composer.SelectionStart = text.Length;
        Composer.Focus(FocusState.Programmatic);
    }

    private void BeginEdit(ChatMessage m)
    {
        editingId = m.Id;
        Composer.Text = m.Body;
        Composer.SelectionStart = m.Body.Length;
        Composer.PlaceholderText = "編集中（Esc でやめる）";
        Composer.Header = "発言を編集";
        Composer.Focus(FocusState.Programmatic);
    }

    private void CancelEdit()
    {
        editingId = null;
        Composer.Text = "";
        Composer.Header = null;
        Composer.PlaceholderText = "メッセージ（Enter で送信・Shift+Enter で改行）";
    }

    private void SendButton_Click(object sender, RoutedEventArgs e) => Send();

    private async void Send()
    {
        if (store is null) return;
        var text = Composer.Text;
        if (editingId is { } id)
        {
            CancelEdit();
            if (!await store.EditAsync(id, text)) Prefill(text);
            return;
        }
        if (text.Trim().Length == 0 && attachments.Count == 0) return;
        if (text.Trim().Length > store.Limits.MaxBody)
        {
            StatusText.Text = $"{store.Limits.MaxBody} 字までです";
            return;
        }
        var photos = attachments.Count > 0 ? attachments.ToList() : null;
        Composer.Text = "";
        ClearAttachments();
        if (Rows.Count > 0) List.ScrollIntoView(Rows[^1]);
        await store.SendAsync(text, photos, restore: Prefill);
        if (Rows.Count > 0) List.ScrollIntoView(Rows[^1]);
    }

    // MARK: - 写真

    private async void PhotoButton_Click(object sender, RoutedEventArgs e)
    {
        if (windowHandle is null) return;
        var picker = new FileOpenPicker { SuggestedStartLocation = PickerLocationId.PicturesLibrary, ViewMode = PickerViewMode.Thumbnail };
        foreach (var ext in new[] { ".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic" }) picker.FileTypeFilter.Add(ext);
        WinRT.Interop.InitializeWithWindow.Initialize(picker, windowHandle());
        var files = await picker.PickMultipleFilesAsync();
        foreach (var f in files)
        {
            using var s = await f.OpenReadAsync();
            AddAttachment(await Jpeg.ReadAllAsync(s));
        }
    }

    private async void Composer_Paste(object sender, TextControlPasteEventArgs e)
    {
        var content = Clipboard.GetContent();
        if (!content.Contains(StandardDataFormats.Bitmap)) return; // 文字はふつうに貼る
        e.Handled = true;
        var reference = await content.GetBitmapAsync();
        using var s = await reference.OpenReadAsync();
        AddAttachment(await Jpeg.ReadAllAsync(s));
    }

    private void AddAttachment(byte[] bytes)
    {
        var max = store?.Limits.MaxImages ?? 4;
        if (attachments.Count >= max || !(store?.Limits.Images ?? true)) return;
        attachments.Add(bytes);
        RenderAttachments();
    }

    private void ClearAttachments()
    {
        attachments.Clear();
        RenderAttachments();
    }

    private async void RenderAttachments()
    {
        AttachmentsView.Items.Clear();
        for (var i = 0; i < attachments.Count; i++)
        {
            var index = i;
            var bmp = new Microsoft.UI.Xaml.Media.Imaging.BitmapImage { DecodePixelHeight = 120 };
            using (var ms = new Windows.Storage.Streams.InMemoryRandomAccessStream())
            {
                await ms.WriteAsync(System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions.AsBuffer(attachments[i]));
                ms.Seek(0);
                await bmp.SetSourceAsync(ms);
            }
            var remove = new Button { Content = "✕", Padding = new Thickness(4, 0, 4, 0), HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top };
            remove.Click += (_, _) => { attachments.RemoveAt(index); RenderAttachments(); };
            var cell = new Grid { Width = 64, Height = 64, CornerRadius = new CornerRadius(6) };
            cell.Children.Add(new Image { Source = bmp, Stretch = Stretch.UniformToFill });
            cell.Children.Add(remove);
            AttachmentsView.Items.Add(cell);
        }
        AttachmentsView.Visibility = attachments.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
    }
}
