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
/// </summary>
public static class MetaEndpoint
{
    /// <summary>The endpoint path, mounted under the host's API prefix. A cross-port
    /// contract value — one browser read-model works against every backend.</summary>
    public const string MetaRoutePath = "/_meta";

    /// <summary>The response body: the model as EFFECTIVE canonical JSON, so a browser
    /// reading it never has to resolve <c>extends</c> itself.</summary>
    public static string MetaJson(MetaData root) => SerializerJson.CanonicalSerializeEffective(root);
}
