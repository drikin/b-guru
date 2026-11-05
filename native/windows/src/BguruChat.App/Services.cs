using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BguruChat.Core;
using Microsoft.Win32;

namespace BguruChat.App;

/// <summary>この PC のアプリのデータの置き場所（%LOCALAPPDATA%\BguruChat）。</summary>
public static class AppPaths
{
    public static string Root
    {
        get
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BguruChat");
            Directory.CreateDirectory(dir);
            return dir;
        }
    }

    public static string Asset(string name) => Path.Combine(AppContext.BaseDirectory, "Assets", name);
}

/// <summary>
/// アプリの鍵（bga_…）を保存する。Windows の DPAPI（このユーザーだけが戻せる）で暗号化してファイルに置く。
/// Mac のキーチェーン・Android の Keystore にあたる。
/// </summary>
public static class TokenStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("fm.backspace.bguru.chat/agent-token");
    private static string FilePath => Path.Combine(AppPaths.Root, "token.bin");

    public static string? Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return null;
            var plain = ProtectedData.Unprotect(File.ReadAllBytes(FilePath), Entropy, DataProtectionScope.CurrentUser);
            var token = Encoding.UTF8.GetString(plain);
            return token.StartsWith("bga_", StringComparison.Ordinal) ? token : null;
        }
        catch (CryptographicException) { return null; }
        catch (IOException) { return null; }
    }

    public static void Save(string token)
    {
        var data = ProtectedData.Protect(Encoding.UTF8.GetBytes(token), Entropy, DataProtectionScope.CurrentUser);
        File.WriteAllBytes(FilePath, data);
    }

    public static void Delete()
    {
        try { File.Delete(FilePath); } catch (IOException) { }
    }
}

/// <summary>設定（この PC だけ。settings.json）。</summary>
public sealed class AppSettings
{
    public NotifyMode NotifyMode { get; set; } = NotifyMode.All;
    public bool QuietHours { get; set; } = true;
    public bool StartWithWindows { get; set; } = true;
    /// <summary>Ctrl+Alt+B でパネルを開閉（Mac の ⌃⌥B と同じ）。</summary>
    public bool HotKey { get; set; } = true;

    public NotifySettings Notify => new(NotifyMode, QuietHours);

    private static string FilePath => Path.Combine(AppPaths.Root, "settings.json");
    private static readonly JsonSerializerOptions Options = new() { WriteIndented = true };

    public static AppSettings Load()
    {
        try
        {
            if (File.Exists(FilePath))
                return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(FilePath), Options) ?? new AppSettings();
        }
        catch (JsonException) { }
        catch (IOException) { }
        return new AppSettings();
    }

    public void Save()
    {
        try { File.WriteAllText(FilePath, JsonSerializer.Serialize(this, Options)); }
        catch (IOException) { }
    }
}

/// <summary>Windows の起動時に始める（HKCU の Run。管理者の許可はいらない）。</summary>
public static class Startup
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string Name = "BguruChat";

    public static void Apply(bool on)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true) ?? Registry.CurrentUser.CreateSubKey(RunKey);
            if (on && Environment.ProcessPath is { } exe) key.SetValue(Name, $"\"{exe}\" --background");
            else key.DeleteValue(Name, throwOnMissingValue: false);
        }
        catch (UnauthorizedAccessException) { }
        catch (IOException) { }
    }
}

/// <summary>アプリの版（csproj の Version）。</summary>
public static class AppInfo
{
    public static string Version =>
        typeof(AppInfo).Assembly.GetName().Version is { } v ? $"{v.Major}.{v.Minor}.{v.Build}" : "0.0.0";
}
