using System.Text.Json.Nodes;
using MetaObjects.Meta;

namespace MetaObjects;

/// <summary>
/// UI-1 — the metadata API contract.
///
/// C# ships the helper and not a mount: the runtime <c>MetaObjects</c> package
/// references only YamlDotNet, and an ASP.NET FrameworkReference here would put a
/// web dependency on every consumer of the core package. Mount it yourself:
///
/// <code>
/// app.MapGet($"/api{MetaEndpoint.MetaRoutePath}",
///            () => Results.Text(MetaEndpoint.MetaJson(root), "application/json"));
/// </code>
///
/// Guard that route with your own authorization — <c>/_meta</c> publishes the
/// shape of the model (entity and field names, types, validators, layouts),
/// though no row data.
///
/// Beside it, <see cref="MetaDocsRoutePath"/> serves the same model as its docs view, the
/// document the model explorer reads (<c>docs/features/metadata-api.md</c>), under the same
/// opt-in and the same guard. Build one <see cref="Docs"/> per loaded model, keep it, and
/// answer from it:
///
/// <code>
/// var docs = MetaEndpoint.MetaDocs(root);
/// app.MapGet($"/api{MetaEndpoint.MetaDocsRoutePath}", (HttpContext http) =>
/// {
///     http.Response.Headers.ETag = docs.ETag;
///     http.Response.Headers.CacheControl = "no-cache";
///     return docs.Matches(http.Request.Headers.IfNoneMatch)
///         ? Results.StatusCode(304)
///         : Results.Text(docs.Body, "application/json");
/// });
/// </code>
/// </summary>
public static class MetaEndpoint
{
    /// <summary>The endpoint path, mounted under the host's API prefix. A cross-port
    /// contract value — one browser read-model works against every backend.</summary>
    public const string MetaRoutePath = "/_meta";

    /// <summary>The response body: the model as EFFECTIVE canonical JSON, so a browser
    /// reading it never has to resolve <c>extends</c> itself.</summary>
    public static string MetaJson(MetaData root) => SerializerJson.CanonicalSerializeEffective(root);

    /// <summary>The docs view endpoint's path, mounted under the host's API prefix beside
    /// <see cref="MetaRoutePath"/>: a cross-port contract value, so the explorer reads
    /// <c>GET {apiPrefix}/_meta/docs</c> from any backend.</summary>
    public const string MetaDocsRoutePath = MetaRoutePath + "/docs";

    /// <summary>The <c>GET {apiPrefix}/_meta/docs</c> response body: the loaded model's docs view,
    /// built from the model alone, with the routes the application mounts when it passes them
    /// (<c>[{ node, method, path }]</c>).</summary>
    public static string MetaDocsJson(MetaData root, JsonNode? routes = null) =>
        DocsView.Serialize(DocsView.Build(root, null, null, routes));

    /// <summary>The docs view of one loaded model, built once: the model is immutable after load.</summary>
    public static Docs MetaDocs(MetaData root, JsonNode? routes = null) => new(MetaDocsJson(root, routes));

    /// <summary>A built docs view body and its strong <c>ETag</c>.</summary>
    public sealed class Docs
    {
        internal Docs(string body)
        {
            Body = body;
            ETag = MetaDocsETag(body);
        }

        /// <summary>The response body.</summary>
        public string Body { get; }

        /// <summary>The strong ETag to send with it.</summary>
        public string ETag { get; }

        /// <summary>Whether a request's <c>If-None-Match</c> names this body (answer 304).</summary>
        public bool Matches(string? ifNoneMatch) => ETagMatches(ifNoneMatch, ETag);
    }

    /// <summary>A strong ETag for a docs view body: its length and the 32-bit FNV-1a hash of its
    /// UTF-16 code units, both in hex, quoted, the value every port's mount sends. The contract is
    /// only that the tag changes when the body does; a client compares it and never parses it.</summary>
    public static string MetaDocsETag(string body)
    {
        uint h = 0x811c9dc5;
        foreach (char c in body)
        {
            h ^= c;
            h = unchecked(h * 0x01000193);
        }
        return $"\"{body.Length:x}-{h:x8}\"";
    }

    /// <summary>Whether an <c>If-None-Match</c> header value names <paramref name="etag"/>, or is <c>*</c>.
    /// A weak validator (<c>W/</c>) and a comma-separated list are accepted.</summary>
    public static bool ETagMatches(string? ifNoneMatch, string etag)
    {
        if (string.IsNullOrEmpty(ifNoneMatch)) return false;
        foreach (var t in ifNoneMatch.Split(','))
        {
            var v = t.Trim();
            if (v.StartsWith("W/", StringComparison.Ordinal)) v = v[2..];
            if (v == "*" || v == etag) return true;
        }
        return false;
    }
}
