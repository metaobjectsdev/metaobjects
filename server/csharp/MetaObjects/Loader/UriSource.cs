// UriSource — a metadata source backed by a URI.
//
// Supports file://, http://, and https:// schemes. Format defaults to
// extension-derived (.yaml/.yml → YAML, else JSON); the caller may override
// by passing an explicit MetaDataFormat.
//
// Part of the cross-language MetaDataSource roster (see
// docs/superpowers/specs/2026-05-25-cross-language-loader-architecture-unification.md).

using System.Net.Http;

namespace MetaObjects.Loader;

/// <summary>
/// A URI-backed metadata source. Supports <c>file://</c>, <c>http://</c>, and
/// <c>https://</c> schemes. Format defaults to extension-derived; pass an
/// explicit <see cref="MetaDataFormat"/> to override.
/// </summary>
public sealed class UriSource : IMetaDataSource
{
    private static readonly HttpClient _http = new();

    /// <summary>The backing URI.</summary>
    public Uri Uri { get; }

    public string Id { get; }

    public MetaDataFormat Format { get; }

    public UriSource(Uri uri, MetaDataFormat? format = null)
    {
        Uri = uri ?? throw new ArgumentNullException(nameof(uri));
        Id = uri.ToString();
        Format = format ?? MetaDataFormats.InferFromExtension(uri.AbsolutePath);
    }

    public string Read()
    {
        if (Uri.IsFile)
        {
            return File.ReadAllText(Uri.LocalPath);
        }

        if (Uri.Scheme == "http" || Uri.Scheme == "https")
        {
            using HttpResponseMessage resp = _http.GetAsync(Uri).GetAwaiter().GetResult();
            resp.EnsureSuccessStatusCode();
            return resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        }

        throw new NotSupportedException($"Unsupported URI scheme '{Uri.Scheme}' on {Uri}");
    }
}
