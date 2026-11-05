using System.Runtime.InteropServices;
using static BguruChat.App.Native;

namespace BguruChat.App;

/// <summary>右クリックのメニューの 1 項目。</summary>
public sealed record TrayMenuItem(string Text, Action? Action = null, bool Checked = false, bool Enabled = true,
    IReadOnlyList<TrayMenuItem>? Children = null)
{
    public static readonly TrayMenuItem Separator = new("-");
    public bool IsSeparator => Text == "-";
}

/// <summary>
/// 通知領域（タスクバー右下）のビーグル。Mac のメニューバーのビーグルにあたる。
/// 左クリックでパネルを開閉、右クリックでメニュー。エクスプローラーが再起動したら（TaskbarCreated）出し直す。
/// 見えない窓を 1 つ作って、アイコンとホットキー（Ctrl+Alt+B）の知らせを受ける。
/// </summary>
public sealed class TrayIcon : IDisposable
{
    private const int CallbackMessage = WM_APP + 1;
    private const int HotKeyId = 1;
    private readonly WndProc proc; // GC に回収されないように持っておく
    private readonly nint hwnd;
    private readonly uint taskbarCreated;
    private nint iconNormal, iconUnread;
    private bool unread;
    private string tip = "B-guru Chat";
    private bool added;

    public event Action? Clicked;
    public event Action? HotKeyPressed;
    /// <summary>右クリックのたびに作る（その時の状態でチェックをつける）。</summary>
    public Func<IReadOnlyList<TrayMenuItem>>? BuildMenu { get; set; }

    public TrayIcon()
    {
        proc = WindowProc;
        var cls = new WNDCLASSEX
        {
            cbSize = (uint)Marshal.SizeOf<WNDCLASSEX>(),
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(proc),
            hInstance = GetModuleHandle(null),
            lpszClassName = "BguruChatTrayWindow",
        };
        RegisterClassEx(ref cls);
        hwnd = CreateWindowEx(0, cls.lpszClassName, "B-guru Chat", 0, 0, 0, 0, 0, 0, 0, cls.hInstance, 0);
        taskbarCreated = RegisterWindowMessage("TaskbarCreated");
        LoadIcons();
        Add();
    }

    private void LoadIcons()
    {
        var size = GetSystemMetrics(49); // SM_CXSMICON（DPI に合わせた小さいアイコン）
        iconNormal = LoadImage(0, AppPaths.Asset("tray.ico"), IMAGE_ICON, size, size, LR_LOADFROMFILE);
        iconUnread = LoadImage(0, AppPaths.Asset("tray-unread.ico"), IMAGE_ICON, size, size, LR_LOADFROMFILE);
    }

    private NOTIFYICONDATA Data(uint flags) => new()
    {
        cbSize = (uint)Marshal.SizeOf<NOTIFYICONDATA>(),
        hWnd = hwnd,
        uID = 1,
        uFlags = flags,
        uCallbackMessage = CallbackMessage,
        hIcon = unread ? iconUnread : iconNormal,
        szTip = tip.Length > 127 ? tip[..127] : tip,
        szInfo = "",
        szInfoTitle = "",
        uVersion = NOTIFYICON_VERSION_4,
    };

    private void Add()
    {
        var d = Data(NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP);
        added = Shell_NotifyIcon(NIM_ADD, ref d);
        Shell_NotifyIcon(NIM_SETVERSION, ref d);
    }

    /// <summary>未読の印（赤い点）とツールチップ（「B-guru Chat — 未読 3（@1）」）。</summary>
    public void Update(bool hasUnread, string tooltip)
    {
        if (unread == hasUnread && tip == tooltip && added) return;
        unread = hasUnread;
        tip = tooltip;
        var d = Data(NIF_ICON | NIF_TIP | NIF_SHOWTIP);
        if (!Shell_NotifyIcon(NIM_MODIFY, ref d)) Add();
    }

    /// <summary>Ctrl+Alt+B（ほかのアプリが使っていたら false）。</summary>
    public bool SetHotKey(bool on)
    {
        UnregisterHotKey(hwnd, HotKeyId);
        return !on || RegisterHotKey(hwnd, HotKeyId, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 0x42 /* B */);
    }

    private nint WindowProc(nint h, uint msg, nint wParam, nint lParam)
    {
        if (msg == CallbackMessage)
        {
            switch (LowWord(lParam))
            {
                case NIN_SELECT:
                case NIN_KEYSELECT:
                case WM_LBUTTONUP:
                    Clicked?.Invoke();
                    break;
                case WM_CONTEXTMENU:
                case WM_RBUTTONUP:
                    ShowMenu();
                    break;
            }
            return 0;
        }
        if (msg == WM_HOTKEY && wParam == HotKeyId)
        {
            HotKeyPressed?.Invoke();
            return 0;
        }
        if (msg == taskbarCreated && taskbarCreated != 0)
        {
            added = false;
            Add(); // エクスプローラーが再起動した
            return 0;
        }
        return DefWindowProc(h, msg, wParam, lParam);
    }

    private void ShowMenu()
    {
        if (BuildMenu?.Invoke() is not { Count: > 0 } items) return;
        var actions = new Dictionary<int, Action>();
        var menus = new List<nint>();
        var next = 1;
        nint Build(IReadOnlyList<TrayMenuItem> list)
        {
            var m = CreatePopupMenu();
            menus.Add(m);
            foreach (var it in list)
            {
                if (it.IsSeparator) { AppendMenu(m, MF_SEPARATOR, 0, null); continue; }
                var flags = MF_STRING | (it.Checked ? MF_CHECKED : 0) | (it.Enabled ? 0 : MF_GRAYED);
                if (it.Children is { Count: > 0 } kids)
                {
                    AppendMenu(m, flags | MF_POPUP, (nuint)Build(kids), it.Text);
                    continue;
                }
                var id = next++;
                if (it.Action is not null) actions[id] = it.Action;
                AppendMenu(m, flags, (nuint)id, it.Text);
            }
            return m;
        }
        var root = Build(items);
        GetCursorPos(out var p);
        SetForegroundWindow(hwnd); // メニューの外をクリックしたら閉じるように
        var chosen = TrackPopupMenuEx(root, TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_BOTTOMALIGN, p.X, p.Y, hwnd, 0);
        PostMessage(hwnd, 0, 0, 0);
        DestroyMenu(root); // 子のメニューも一緒に消える
        if (chosen > 0 && actions.TryGetValue(chosen, out var action)) action();
    }

    public void Dispose()
    {
        var d = Data(0);
        Shell_NotifyIcon(NIM_DELETE, ref d);
        UnregisterHotKey(hwnd, HotKeyId);
        if (iconNormal != 0) DestroyIcon(iconNormal);
        if (iconUnread != 0) DestroyIcon(iconUnread);
        DestroyWindow(hwnd);
    }
}
