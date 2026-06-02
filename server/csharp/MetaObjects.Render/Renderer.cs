// Deterministic, logic-less render: (template + payload + provider) -> string.
//
// Ported from typescript/packages/render/src/render.ts. Partials are inlined by
// regex BEFORE the Mustache pass (deterministic whitespace + path-based cycle/
// depth detection, independent of any lib partial loader); escaping is engine-
// owned (the format escaper is installed as Stubble's encoding function, the
// equivalent of overriding mustache.js's Mustache.escape). `{{{x}}}` bypasses it.
//
// The render-time `verify` guard (FR-004 Plan #3) is intentionally not wired yet.

using System.Text.RegularExpressions;
using Stubble.Core.Builders;
using Stubble.Core.Settings;

namespace MetaObjects.Render;

/// <summary>Thrown when a render fails (unresolved ref/partial, partial cycle, depth limit).</summary>
public sealed class RenderException(string message) : Exception(message);

/// <summary>A single render request: (template | ref) + payload + provider + format.</summary>
public sealed record RenderRequest
{
    /// <summary>Inline template text. Mutually exclusive with <see cref="Ref"/>.</summary>
    public string? Template { get; init; }
    /// <summary>A <c>group/source</c> reference resolved via <see cref="Provider"/>.</summary>
    public string? Ref { get; init; }
    /// <summary>The render payload (a plain object/array graph; pre-format primitives).</summary>
    public required object? Payload { get; init; }
    public required IProvider Provider { get; init; }
    /// <summary>Output format; drives escaping. Defaults to "text" (raw).</summary>
    public string Format { get; init; } = Escapers.FORMAT_TEXT;
    /// <summary>
    /// Fail-closed guard for dynamic/generated text: when given a payload field
    /// tree, the RESOLVED template is verified before rendering and a drifted
    /// variant throws — instead of silently rendering nothing.
    /// </summary>
    public IReadOnlyList<PayloadField>? Verify { get; init; }
    /// <summary>
    /// Output budget in characters. Rendered length is data-dependent (only knowable
    /// after rendering), so this is a render-time guard: a result longer than
    /// <see cref="MaxChars"/> throws. Null = no guard. (Token budgets are out of
    /// scope — model-specific tokenizer.) Mirrors TS <c>RenderOptions.maxChars</c>.
    /// </summary>
    public int? MaxChars { get; init; }
}

/// <summary>The logic-less, deterministic MetaObjects render engine.</summary>
public static partial class Renderer
{
    private const int MaxDepth = 32;

    [GeneratedRegex(@"\{\{>\s*([^}\s]+)\s*\}\}")]
    private static partial Regex PartialPattern();

    // Resolve `{{> group/source }}` partials by inlining their text, recursively,
    // BEFORE Mustache parses — giving deterministic whitespace and true, path-based
    // cycle/depth detection.
    private static string Expand(string text, IProvider provider, IReadOnlyList<string> path)
    {
        return PartialPattern().Replace(text, match =>
        {
            string reference = match.Groups[1].Value;
            if (path.Contains(reference))
                throw new RenderException($"partial cycle: {string.Join(" -> ", path.Append(reference))}");
            if (path.Count >= MaxDepth)
                throw new RenderException($"partial depth exceeded {MaxDepth}: {reference}");
            string? t = provider.Resolve(reference);
            if (t is null)
                throw new RenderException($"unresolved partial: {reference}");
            var next = new List<string>(path) { reference };
            return Expand(t, provider, next);
        });
    }

    /// <summary>Deterministic, logic-less render of a template against a payload.</summary>
    public static string Render(RenderRequest request)
    {
        string? body = request.Template
            ?? (request.Ref is not null ? request.Provider.Resolve(request.Ref) : null);
        if (body is null)
            throw new RenderException($"unresolved ref: {request.Ref ?? "(none)"}");

        if (request.Verify is not null)
        {
            var drift = MetaObjects.Render.Verify
                .Check(body, request.Verify, new VerifyOptions { Provider = request.Provider })
                .Where(e => e.Code != MetaObjects.Render.Verify.ERR_REQUIRED_SLOT_UNUSED)
                .ToList();
            if (drift.Count > 0)
                throw new RenderException(
                    "render verify failed: " +
                    string.Join(", ", drift.Select(e => $"{e.Code} ({e.Path})")));
        }

        var startPath = request.Ref is not null ? new[] { request.Ref } : [];
        string expanded = Expand(body, request.Provider, startPath);

        var escaper = Escapers.For(request.Format);
        var stubble = new StubbleBuilder()
            .Configure(settings => settings.SetEncodingFunction(v => escaper(v)))
            .Build();

        string result = stubble.Render(expanded, request.Payload);

        if (request.MaxChars is int cap && result.Length > cap)
            throw new RenderException(
                $"render exceeded maxChars budget: {result.Length} > {cap}");

        return result;
    }
}
