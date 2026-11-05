using BguruChat.Core;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Windows.AppLifecycle;
using Microsoft.Windows.AppNotifications;
using Windows.Networking.Connectivity;

namespace BguruChat.App;

/// <summary>
/// アプリ全体（Mac の AppDelegate にあたる）: 通知領域のビーグル・パネル・ログイン・トースト・設定をつなぐ。
/// 窓を全部閉じても終わらない（終了はメニューから）。
/// </summary>
public partial class App : Application
{
    public static App? Instance { get; private set; }

    private readonly DispatcherQueue ui;
    private readonly AppSettings settings = AppSettings.Load();
    private readonly Toasts toasts = new();
    private readonly NewMessageBundle bundle = new();
    private readonly HashSet<long> shownMentions = [];
    private TrayIcon? tray;
    private PanelWindow? panel;
    private LoginWindow? login;
    private ApiClient? api;
    private ChatStore? store;
    private MediaCache? media;
    private CancellationTokenSource? session;
    private CancellationTokenSource? bundleDebounce;
    private ToastAction? pendingToast;

    public App()
    {
        Instance = this;
        InitializeComponent();
        ui = DispatcherQueue.GetForCurrentThread();
        DispatcherShutdownMode = DispatcherShutdownMode.OnExplicitShutdown;
        UnhandledException += (_, e) => { e.Handled = true; Log("unhandled: " + e.Exception); };
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        toasts.Invoked += a => ui.TryEnqueue(() => HandleToast(a));
        toasts.Register();
        tray = new TrayIcon { BuildMenu = BuildTrayMenu };
        tray.Clicked += () => ui.TryEnqueue(TogglePanel);
        tray.HotKeyPressed += () => ui.TryEnqueue(TogglePanel);
        tray.SetHotKey(settings.HotKey);
        Startup.Apply(settings.StartWithWindows);
        NetworkInformation.NetworkStatusChanged += _ => ui.TryEnqueue(() => store?.Wake());

        var activated = AppInstance.GetCurrent().GetActivatedEventArgs();
        if (activated.Kind == ExtendedActivationKind.AppNotification && activated.Data is AppNotificationActivatedEventArgs n)
            pendingToast = Toasts.Parse(n.Arguments, n.UserInput);
        var background = Environment.GetCommandLineArgs().Contains("--background");

        if (TokenStore.Load() is { } token)
        {
            StartSession(token);
            if (pendingToast is { } t) { pendingToast = null; HandleToast(t); }
            else if (!background) panel?.ShowPanel();
        }
        else
        {
            ShowLogin();
        }
        UpdateTray();
    }

    /// <summary>2 つ目の起動（スタートメニューから・閉じていたときのトースト）を受け取った。</summary>
    public void OnActivatedFromElsewhere(AppActivationArguments e)
    {
        ui.TryEnqueue(() =>
        {
            if (e.Kind == ExtendedActivationKind.AppNotification && e.Data is AppNotificationActivatedEventArgs n)
                HandleToast(Toasts.Parse(n.Arguments, n.UserInput));
            else if (store is null) ShowLogin();
            else panel?.ShowPanel();
        });
    }

    // MARK: - ログイン・ログアウト

    private void ShowLogin()
    {
        if (login is not null) { login.Activate(); return; }
        login = new LoginWindow();
        login.SignedIn += token =>
        {
            TokenStore.Save(token);
            StartSession(token);
            panel?.ShowPanel();
        };
        login.Closed += (_, _) => login = null;
        login.Activate();
    }

    private void StartSession(string token)
    {
        StopSession();
        api = new ApiClient(token, AppInfo.Version);
        media = new MediaCache(api);
        store = new ChatStore(api, new ApiEventSource(api))
        {
            Notify = settings.Notify,
            PrepareJpeg = Jpeg.PrepareAsync,
        };
        store.Changed += UpdateTray;
        store.Mention += OnMention;
        store.NewMessage += OnNewMessage;
        store.ReadElsewhere += OnReadElsewhere;
        store.SignedOutChanged += () => ui.TryEnqueue(() => SignOut(revoke: false));
        panel ??= CreatePanel();
        panel.ChatView.Attach(store, media, () => panel.Handle);
        session = new CancellationTokenSource();
        _ = store.RunAsync(session.Token);
        UpdateTray();
    }

    private PanelWindow CreatePanel()
    {
        var p = new PanelWindow();
        p.ChatView.BuildMenu = BuildPanelMenu;
        p.VisibilityChanged += shown =>
        {
            if (store is null) return;
            var cursorBefore = store.ReadCursor;
            store.IsVisible = shown;
            if (shown)
            {
                ClearChatToasts();
                p.ChatView.OnShown(cursorBefore);
            }
        };
        return p;
    }

    private void StopSession()
    {
        session?.Cancel();
        session = null;
        panel?.ChatView.Detach();
        panel?.HidePanel();
        api?.Dispose();
        api = null;
        store = null;
        media = null;
        bundle.Clear();
        shownMentions.Clear();
    }

    /// <summary>ログアウト。自分で選んだときはサーバの鍵も取り消す。鍵が無効になっていたときは取り消さない。</summary>
    private async void SignOut(bool revoke)
    {
        if (revoke && api is { } a)
        {
            try { await a.RevokeSelfAsync(); } catch (Exception) { }
        }
        StopSession();
        TokenStore.Delete();
        toasts.RemoveAll();
        UpdateTray();
        ShowLogin();
    }

    // MARK: - パネル・ビーグル

    private void TogglePanel()
    {
        if (store is null) { ShowLogin(); return; }
        panel?.Toggle();
    }

    private void UpdateTray()
    {
        if (tray is null) return;
        if (store is null)
        {
            tray.Update(false, "B-guru Chat — ログインしてください");
            return;
        }
        var unread = store.UnreadCount;
        var tip = unread == 0 ? "B-guru Chat" : store.MentionCount > 0 ? $"B-guru Chat — 未読 {unread}（@{store.MentionCount}）" : $"B-guru Chat — 未読 {unread}";
        if (store.Connection == Connection.Offline) tip += "（オフライン）";
        tray.Update(unread > 0, tip);
    }

    // MARK: - 通知

    private void OnMention(ChatMessage m, bool sound)
    {
        shownMentions.Add(m.Id);
        toasts.ShowMention(m, sound);
    }

    /// <summary>ほかの新着は 1 つにまとめ、0.4 秒まとめてから出す（まとまりの最初の 1 件だけ音）。</summary>
    private bool bundleSound;

    private async void OnNewMessage(ChatMessage m, bool sound)
    {
        if (bundle.Add(m) && sound) bundleSound = true;
        bundleDebounce?.Cancel();
        var cts = bundleDebounce = new CancellationTokenSource();
        try { await Task.Delay(400, cts.Token); }
        catch (OperationCanceledException) { return; } // 次の新着がまとめて出す
        if (bundle.Count == 0 || bundle.NewestId is not { } newest) return;
        toasts.ShowBundle(bundle, newest, bundleSound);
        bundleSound = false;
    }

    private void OnReadElsewhere(string scope, long? upTo)
    {
        if (scope != "chat") return;
        if (upTo is null)
        {
            ClearChatToasts();
            return;
        }
        foreach (var id in shownMentions.Where(id => id <= upTo).ToList())
        {
            toasts.Remove($"chat-{id}");
            shownMentions.Remove(id);
        }
        if (bundle.ClearIfCovered(upTo.Value)) toasts.Remove(NewMessageBundle.Tag);
    }

    private void ClearChatToasts()
    {
        bundle.Clear();
        toasts.Remove(NewMessageBundle.Tag);
        foreach (var id in shownMentions) toasts.Remove($"chat-{id}");
        shownMentions.Clear();
    }

    private void HandleToast(ToastAction a)
    {
        if (store is null) { pendingToast = a; ShowLogin(); return; }
        switch (a.Action)
        {
            case "reply" when !string.IsNullOrWhiteSpace(a.ReplyText):
                _ = store.SendAsync(a.ReplyText!);
                break;
            case "heart" when a.MessageId > 0:
                _ = store.ToggleReactionAsync(a.MessageId, "❤️");
                break;
            default:
                panel?.ShowPanel();
                if (a.MessageId > 0) panel?.ChatView.Reveal(a.MessageId);
                break;
        }
    }

    // MARK: - メニュー

    private IReadOnlyList<TrayMenuItem> BuildTrayMenu()
    {
        if (store is null)
            return [new("ログイン…", ShowLogin), TrayMenuItem.Separator, new("終了", Quit)];
        return
        [
            new("チャットを開く\tCtrl+Alt+B", () => panel?.ShowPanel()),
            new("B-guru をブラウザで開く", OpenWeb),
            TrayMenuItem.Separator,
            new("通知", Children:
            [
                new("すべての新着", () => SetNotifyMode(NotifyMode.All), settings.NotifyMode == NotifyMode.All),
                new("メンションだけ", () => SetNotifyMode(NotifyMode.Mentions), settings.NotifyMode == NotifyMode.Mentions),
                TrayMenuItem.Separator,
                new("静かな時間（0:00〜7:00）は知らせない", ToggleQuietHours, settings.QuietHours),
            ]),
            new("Windows の起動時に開始", ToggleStartup, settings.StartWithWindows),
            new("Ctrl+Alt+B でパネルを開閉", ToggleHotKey, settings.HotKey),
            TrayMenuItem.Separator,
            new($"B-guru Chat {AppInfo.Version}", Enabled: false),
            new("ログアウト", () => SignOut(revoke: true)),
            new("終了", Quit),
        ];
    }

    /// <summary>パネルの ⋯ のメニュー（通知領域のメニューと同じ中身）。</summary>
    private MenuFlyout BuildPanelMenu()
    {
        var flyout = new MenuFlyout();
        void Add(IReadOnlyList<TrayMenuItem> items, IList<MenuFlyoutItemBase> target)
        {
            foreach (var it in items)
            {
                if (it.IsSeparator) { target.Add(new MenuFlyoutSeparator()); continue; }
                if (it.Children is { Count: > 0 } kids)
                {
                    var sub = new MenuFlyoutSubItem { Text = it.Text };
                    Add(kids, sub.Items);
                    target.Add(sub);
                    continue;
                }
                var text = it.Text.Split('\t')[0];
                MenuFlyoutItem item = it.Checked ? new ToggleMenuFlyoutItem { Text = text, IsChecked = true } : new MenuFlyoutItem { Text = text };
                item.IsEnabled = it.Enabled;
                if (it.Action is { } action) item.Click += (_, _) => action();
                target.Add(item);
            }
        }
        Add(BuildTrayMenu(), flyout.Items);
        return flyout;
    }

    private void SetNotifyMode(NotifyMode mode)
    {
        settings.NotifyMode = mode;
        SaveSettings();
    }

    private void ToggleQuietHours()
    {
        settings.QuietHours = !settings.QuietHours;
        SaveSettings();
    }

    private void ToggleStartup()
    {
        settings.StartWithWindows = !settings.StartWithWindows;
        Startup.Apply(settings.StartWithWindows);
        SaveSettings();
    }

    private void ToggleHotKey()
    {
        settings.HotKey = !settings.HotKey;
        tray?.SetHotKey(settings.HotKey);
        SaveSettings();
    }

    private void SaveSettings()
    {
        settings.Save();
        if (store is not null) store.Notify = settings.Notify;
    }

    private static void OpenWeb() => _ = Windows.System.Launcher.LaunchUriAsync(ApiClient.DefaultBase);

    private void Quit()
    {
        session?.Cancel();
        tray?.Dispose();
        tray = null;
        toasts.Dispose();
        Exit();
    }

    internal static void Log(string text)
    {
        try { File.AppendAllText(Path.Combine(AppPaths.Root, "log.txt"), $"{DateTime.Now:O} {text}\n"); }
        catch (IOException) { }
    }
}
