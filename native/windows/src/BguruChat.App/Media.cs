using System.Runtime.InteropServices.WindowsRuntime;
using BguruChat.Core;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace BguruChat.App;

/// <summary>
/// 画像を読む（/api/media/* とアバター）。自分のホストには鍵をつける（ApiClient が決める）。
/// 同じ URL は 1 回だけ読み、作った絵を使い回す（数は上限つき）。
/// </summary>
public sealed class MediaCache(ApiClient api)
{
    private const int Limit = 300;
    private readonly Dictionary<string, Task<ImageSource?>> cache = [];
    private readonly LinkedList<string> order = new();

    public Task<ImageSource?> GetAsync(string? pathOrUrl, int decodeWidth = 0)
    {
        if (string.IsNullOrEmpty(pathOrUrl)) return Task.FromResult<ImageSource?>(null);
        var key = $"{pathOrUrl}#{decodeWidth}";
        if (cache.TryGetValue(key, out var t)) return t;
        t = LoadAsync(pathOrUrl, decodeWidth);
        cache[key] = t;
        order.AddLast(key);
        while (order.Count > Limit)
        {
            cache.Remove(order.First!.Value);
            order.RemoveFirst();
        }
        return t;
    }

    private async Task<ImageSource?> LoadAsync(string pathOrUrl, int decodeWidth)
    {
        try
        {
            var bytes = await api.GetBytesAsync(api.Absolute(pathOrUrl));
            var bmp = new BitmapImage();
            if (decodeWidth > 0) bmp.DecodePixelWidth = decodeWidth;
            using var stream = new InMemoryRandomAccessStream();
            await stream.WriteAsync(bytes.AsBuffer());
            stream.Seek(0);
            await bmp.SetSourceAsync(stream);
            return bmp;
        }
        catch (Exception)
        {
            return null;
        }
    }

    public async Task<byte[]?> GetBytesAsync(string pathOrUrl)
    {
        try { return await api.GetBytesAsync(api.Absolute(pathOrUrl)); }
        catch (Exception) { return null; }
    }
}

/// <summary>送る写真を小さくする（長辺 maxSide px・JPEG 品質 0.8、写真の向きを直す）。ChatStore.PrepareJpeg に渡す。</summary>
public static class Jpeg
{
    public static async Task<byte[]> PrepareAsync(byte[] original, int maxSide)
    {
        using var input = new InMemoryRandomAccessStream();
        await input.WriteAsync(original.AsBuffer());
        input.Seek(0);
        var decoder = await BitmapDecoder.CreateAsync(input);
        var w = decoder.OrientedPixelWidth;
        var h = decoder.OrientedPixelHeight;
        var scale = Math.Min(1.0, (double)maxSide / Math.Max(w, h));
        var transform = new BitmapTransform
        {
            ScaledWidth = (uint)Math.Max(1, Math.Round(decoder.PixelWidth * scale)),
            ScaledHeight = (uint)Math.Max(1, Math.Round(decoder.PixelHeight * scale)),
            InterpolationMode = BitmapInterpolationMode.Fant,
        };
        using var bitmap = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore, transform,
            ExifOrientationMode.RespectExifOrientation, ColorManagementMode.ColorManageToSRgb);
        using var output = new InMemoryRandomAccessStream();
        var options = new BitmapPropertySet { ["ImageQuality"] = new BitmapTypedValue(0.8f, Windows.Foundation.PropertyType.Single) };
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, output, options);
        encoder.SetSoftwareBitmap(bitmap);
        await encoder.FlushAsync();
        var bytes = new byte[output.Size];
        output.Seek(0);
        await output.ReadAsync(bytes.AsBuffer(), (uint)bytes.Length, InputStreamOptions.None);
        return bytes;
    }

    /// <summary>ストリームを全部読む（クリップボードの画像・選んだファイル）。</summary>
    public static async Task<byte[]> ReadAllAsync(IRandomAccessStream s)
    {
        var bytes = new byte[s.Size];
        s.Seek(0);
        await s.ReadAsync(bytes.AsBuffer(), (uint)bytes.Length, InputStreamOptions.None);
        return bytes;
    }
}
