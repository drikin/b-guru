using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Windows.Graphics;

namespace BguruChat.App;

/// <summary>
/// 通知領域のビーグルから開くパネル（Mac のメニューバーのパネルにあたる）。枠なし・いつも手前・タスクバーに出さない。
/// タスクバーのある画面の作業領域の右下（タスクバーが上・左にあればそちら側）に出し、ほかを押したら隠す。
/// </summary>
public sealed partial class PanelWindow : Window
{
    private const int WidthDip = 400, HeightDip = 640, MarginDip = 12;
    private DateTime shownAt;
    private DateTime autoHiddenAt;

    public ChatView ChatView => Chat;
    public bool IsShown { get; private set; }
    public event Action<bool>? VisibilityChanged;

    public nint Handle => WinRT.Interop.WindowNative.GetWindowHandle(this);

    public PanelWindow()
    {
        InitializeComponent();
        Title = "B-guru Chat";
        if (AppWindow.Presenter is OverlappedPresenter p)
        {
            p.SetBorderAndTitleBar(true, false);
            p.IsResizable = false;
            p.IsMaximizable = false;
            p.IsMinimizable = false;
            p.IsAlwaysOnTop = true;
        }
        AppWindow.IsShownInSwitchers = false;
        AppWindow.SetIcon(AppPaths.Asset("app.ico"));
        Activated += OnActivated;
        AppWindow.Closing += (_, e) => { e.Cancel = true; HidePanel(); }; // Alt+F4 でも隠すだけ
    }

    private void OnActivated(object sender, WindowActivatedEventArgs e)
    {
        // ほかを押した（開いた直後のクリックの名残は無視）
        if (e.WindowActivationState == WindowActivationState.Deactivated && IsShown
            && DateTime.UtcNow - shownAt > TimeSpan.FromMilliseconds(300))
        {
            HidePanel();
            autoHiddenAt = DateTime.UtcNow;
        }
    }

    /// <summary>ビーグルを押した: 開閉。開いているときにビーグルを押すと、先に「ほかを押した」で隠れるので、その直後なら開き直さない。</summary>
    public void Toggle()
    {
        if (IsShown) HidePanel();
        else if (DateTime.UtcNow - autoHiddenAt > TimeSpan.FromMilliseconds(400)) ShowPanel();
    }

    public void ShowPanel()
    {
        Place();
        AppWindow.Show();
        Activate();
        Native.SetForegroundWindow(Handle);
        shownAt = DateTime.UtcNow;
        if (!IsShown)
        {
            IsShown = true;
            VisibilityChanged?.Invoke(true);
        }
    }

    public void HidePanel()
    {
        if (!IsShown) return;
        AppWindow.Hide();
        IsShown = false;
        VisibilityChanged?.Invoke(false);
    }

    /// <summary>タスクバーの側の角に寄せる（作業領域 = タスクバーを除いた所）。</summary>
    private void Place()
    {
        Native.GetCursorPos(out var cursor);
        var area = DisplayArea.GetFromPoint(new PointInt32(cursor.X, cursor.Y), DisplayAreaFallback.Primary);
        var work = area.WorkArea;
        var outer = area.OuterBounds;
        var scale = Native.GetDpiForWindow(Handle) / 96.0;
        if (scale <= 0) scale = 1;
        var w = (int)(WidthDip * scale);
        var h = (int)Math.Min(HeightDip * scale, work.Height - 2 * MarginDip * scale);
        var m = (int)(MarginDip * scale);
        var taskbarTop = work.Y > outer.Y;
        var taskbarLeft = work.X > outer.X;
        var x = taskbarLeft ? work.X + m : work.X + work.Width - w - m;
        var y = taskbarTop ? work.Y + m : work.Y + work.Height - h - m;
        AppWindow.MoveAndResize(new RectInt32(x, y, w, h));
    }
}
