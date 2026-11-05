using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace BguruChat.App;

/// <summary>
/// 起動: 1 つだけ動かす。2 つ目を起動したら（スタートメニュー・トースト）、動いている方に渡して自分は終わる。
/// </summary>
public static class Program
{
    public const string InstanceKey = "fm.backspace.bguru.chat";

    [STAThread]
    public static int Main(string[] args)
    {
        WinRT.ComWrappersSupport.InitializeComWrappers();
        if (RedirectIfRunning()) return 0;
        Application.Start(_ =>
        {
            var ctx = new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread());
            SynchronizationContext.SetSynchronizationContext(ctx);
            _ = new App();
        });
        return 0;
    }

    private static bool RedirectIfRunning()
    {
        var main = AppInstance.FindOrRegisterForKey(InstanceKey);
        if (main.IsCurrent)
        {
            main.Activated += (_, e) => App.Instance?.OnActivatedFromElsewhere(e);
            return false;
        }
        var args = AppInstance.GetCurrent().GetActivatedEventArgs();
        // STA のスレッドで待つと止まることがあるので、別のスレッドで渡しきる
        Task.Run(() => main.RedirectActivationToAsync(args).AsTask().Wait()).Wait();
        return true;
    }
}
