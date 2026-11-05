using BguruChat.Core;
using Microsoft.UI.Xaml;
using Microsoft.Web.WebView2.Core;
using Windows.Graphics;

namespace BguruChat.App;

/// <summary>
/// ログイン（native/shared/LoginView.swift と同じ流れ）: WebView2 で B-guru にログインしてもらい、
/// 「このアプリを接続」で POST /api/agent/token（Web のセッションの Cookie つき）→ アプリの鍵。
/// WebView2 のデータは使い捨ての場所に置き、閉じたら消す（Web のログインはこの PC に残さない）。
/// </summary>
public sealed partial class LoginWindow : Window
{
    private readonly Uri baseUri = ApiClient.DefaultBase;
    private readonly string dataDir = Path.Combine(Path.GetTempPath(), "BguruChat-login-" + Guid.NewGuid().ToString("N"));

    /// <summary>鍵を受け取った。</summary>
    public event Action<string>? SignedIn;

    public LoginWindow()
    {
        InitializeComponent();
        AppWindow.SetIcon(AppPaths.Asset("app.ico"));
        AppWindow.Resize(new SizeInt32(560, 820));
        Closed += (_, _) => Cleanup();
        _ = InitAsync();
    }

    private async Task InitAsync()
    {
        try
        {
            var env = await CoreWebView2Environment.CreateWithOptionsAsync(null, dataDir, new CoreWebView2EnvironmentOptions());
            await Web.EnsureCoreWebView2Async(env);
            var core = Web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.NavigationStarting += (sender, e) =>
            {
                // B-guru の中だけ。ほかのリンクはふだんのブラウザで
                if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var u) && !IsOurs(u) && u.Scheme is "http" or "https" or "mailto")
                {
                    e.Cancel = true;
                    _ = Windows.System.Launcher.LaunchUriAsync(u);
                }
            };
            core.NewWindowRequested += (sender, e) =>
            {
                e.Handled = true;
                if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var u))
                {
                    if (IsOurs(u)) core.Navigate(u.ToString());
                    else _ = Windows.System.Launcher.LaunchUriAsync(u);
                }
            };
            core.Navigate(baseUri.ToString());
        }
        catch (Exception ex)
        {
            ShowError("ログインの画面を開けませんでした（WebView2 が必要です）: " + ex.Message);
        }
    }

    private bool IsOurs(Uri u) =>
        u.Scheme == baseUri.Scheme && string.Equals(u.Host, baseUri.Host, StringComparison.OrdinalIgnoreCase) && u.Port == baseUri.Port;

    private async void Connect_Click(object sender, RoutedEventArgs e)
    {
        if (Web.CoreWebView2 is null) return;
        ConnectButton.IsEnabled = false;
        Busy.IsActive = true;
        ErrorText.Visibility = Visibility.Collapsed;
        SettingsLink.Visibility = Visibility.Collapsed;
        try
        {
            var cookies = await Web.CoreWebView2.CookieManager.GetCookiesAsync(baseUri.ToString());
            var header = string.Join("; ", cookies.Select(c => $"{c.Name}={c.Value}"));
            if (header.Length == 0)
            {
                ShowError("先に下の画面でログインしてください。");
                return;
            }
            var result = await ApiClient.IssueTokenAsync(header, Environment.MachineName, AppInfo.Version, baseUri);
            SignedIn?.Invoke(result.Token);
            Close();
        }
        catch (ApiException ex)
        {
            if (ApiClient.IsTokenLimit(ex))
            {
                ShowError(ex.Message);
                SettingsLink.Visibility = Visibility.Visible;
            }
            else if (ex.Status == 401) ShowError("先に下の画面でログインしてください。");
            else if (ex.Code == "membership_ended") ShowError("会員の期間が終わっています。");
            else ShowError($"接続できませんでした（{ex.Message}）");
        }
        catch (Exception ex)
        {
            ShowError($"接続できませんでした（{ex.Message}）");
        }
        finally
        {
            ConnectButton.IsEnabled = true;
            Busy.IsActive = false;
        }
    }

    private void ShowError(string text)
    {
        ErrorText.Text = text;
        ErrorText.Visibility = Visibility.Visible;
    }

    private void Cleanup()
    {
        try { Web.Close(); } catch (Exception) { }
        // WebView2 の処理が終わってから消す
        _ = Task.Run(async () =>
        {
            for (var i = 0; i < 10; i++)
            {
                try { if (Directory.Exists(dataDir)) Directory.Delete(dataDir, true); return; }
                catch (IOException) { await Task.Delay(500); }
                catch (UnauthorizedAccessException) { await Task.Delay(500); }
            }
        });
    }
}
