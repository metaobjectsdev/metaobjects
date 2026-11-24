// Deterministic, logic-less render: (template + payload + provider) -> string.
//
// Ported from typescript/packages/render/src/render.ts. Partials are inlined by
// tag scan BEFORE the Mustache pass (deterministic whitespace + path-based cycle/
// depth detection, independent of any lib partial loader); escaping is engine-
// owned (the format escaper is installed as Stubble's encoding function, the
// equivalent of overriding mustache.js's Mustache.escape). `{{{x}}}` bypasses it.
//
// The render-time `verify` guard (FR-004 Plan #3) is wired: a request carrying the payload field
// tree verifies the resolved body before it renders, and a mismatch throws RenderException.

using System.Collections;
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
public static class Renderer
{
    private const int MaxDepth = 32;

    // Resolve `{{> group/source }}` partials by inlining their text, recursively,
    // BEFORE Mustache parses — giving deterministic whitespace and true, path-based
    // cycle/depth detection. Partial tags are located by the shared scanner
    // (MustacheTags), so one written inside a comment is not a partial.
    private static string Expand(string text, IProvider provider, IReadOnlyList<string> path, string? inlinedAs = null)
    {
        List<MustacheTag> tags;
        try { tags = MustacheTags.Scan(text); }
        catch (MustacheSyntaxException e) { throw new RenderException($"template syntax error: {e.Message}"); }
        if (MustacheTags.DelimiterConflict(tags, inlinedAs) is not null)
            throw new RenderException("a template that uses partials cannot also change delimiters ({{=<% %>=}})");
        var partials = tags.Where(t => t.Kind == MustacheTagKind.Partial).ToList();
        if (partials.Count == 0) return text;
        var sb = new System.Text.StringBuilder();
        int pos = 0;
        foreach (var tag in partials)
        {
            string reference = tag.Value;
            if (path.Contains(reference))
                throw new RenderException($"partial cycle: {string.Join(" -> ", path.Append(reference))}");
            if (path.Count >= MaxDepth)
                throw new RenderException($"partial depth exceeded {MaxDepth}: {reference}");
            string? t = provider.Resolve(reference);
            if (t is null)
                throw new RenderException($"unresolved partial: {reference}");
            var next = new List<string>(path) { reference };
            sb.Append(text, pos, tag.Start - pos).Append(Expand(t, provider, next, reference));
            pos = tag.End;
        }
        return sb.Append(text, pos, text.Length - pos).ToString();
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
            .Configure(settings => settings
                .SetEncodingFunction(v => escaper(v))
                .AddValueGetter(PayloadAccessors.ViewType, PayloadAccessors.ViewLookup))
            .Build();

        // Derived `has<Field>` accessors are part of the payload contract, not of the
        // caller's object — see PayloadAccessors. Injected here so a `{{#hasFoo}}` section
        // resolves the same way it does against a generated JVM payload record.
        object? view = PayloadAccessors.WithDerivedAccessors(request.Payload);
        FailOnMissingVariable(expanded, view);
        string result = stubble.Render(expanded, view);

        if (request.MaxChars is int cap && result.Length > cap)
            throw new RenderException(
                $"render exceeded maxChars budget: {result.Length} > {cap}");

        return result;
    }

    // A variable tag whose name is ABSENT from the payload (on no frame of the context stack) is a
    // missing variable and raises the message the opt-in verify gate uses, so a typo like
    // `{{nmae}}` fails on every render path. A value that is present but null renders empty.
    // Walks the template the way the engine renders it: a section pushes its value (each element of
    // a list), an inverted section or a falsy section's body is only checked when it renders.
    private static void FailOnMissingVariable(string template, object? payload)
    {
        List<MustacheTag> tags;
        try { tags = MustacheTags.Scan(template); }
        catch (MustacheSyntaxException) { return; } // the engine reports a malformed template itself
        CheckTags(tags, 0, tags.Count, [payload]);
    }

    private static void CheckTags(List<MustacheTag> tags, int from, int to, List<object?> stack)
    {
        for (int i = from; i < to; i++)
        {
            var tag = tags[i];
            switch (tag.Kind)
            {
                case MustacheTagKind.Name or MustacheTagKind.Triple or MustacheTagKind.Amp:
                    if (!TryResolve(stack, tag.Value, out _))
                        throw new RenderException($"render verify failed: {MetaObjects.Render.Verify.ERR_VAR_NOT_ON_PAYLOAD} ({tag.Value})");
                    break;
                case MustacheTagKind.Section or MustacheTagKind.Inverted:
                    int depth = 1, close = i + 1;
                    for (; close < to; close++)
                    {
                        if (tags[close].Kind is MustacheTagKind.Section or MustacheTagKind.Inverted) depth++;
                        else if (tags[close].Kind == MustacheTagKind.Close && --depth == 0) break;
                    }
                    bool found = TryResolve(stack, tag.Value, out object? value);
                    if (tag.Kind == MustacheTagKind.Inverted)
                    {
                        if (!found || IsFalsy(value)) CheckTags(tags, i + 1, close, stack);
                    }
                    else if (found && !IsFalsy(value) && value is not Delegate)
                    {
                        if (value is System.Collections.IEnumerable seq and not string and not System.Collections.IDictionary)
                        {
                            foreach (var item in seq)
                                CheckTags(tags, i + 1, close, [.. stack, item]);
                        }
                        else CheckTags(tags, i + 1, close, [.. stack, value]);
                    }
                    i = close;
                    break;
            }
        }
    }

    private static bool IsFalsy(object? v) => v switch
    {
        null => true,
        bool b => !b,
        string s => s.Length == 0,
        // JavaScript falsiness, as mustache.js reads it: 0 and NaN are falsy.
        int or long or short or sbyte or byte or uint or ulong or ushort => Convert.ToDecimal(v) == 0m,
        double d => d == 0 || double.IsNaN(d),
        float f => f == 0 || float.IsNaN(f),
        decimal m => m == 0m,
        System.Collections.IDictionary => false,
        System.Collections.IEnumerable seq => !seq.GetEnumerator().MoveNext(),
        _ => false,
    };

    /// <summary>Mustache's name lookup, as mustache.js does it: the WHOLE (possibly dotted) name is
    /// tried against each context from the innermost outward, and the first context on which the full
    /// path resolves wins. A context that has the first segment but not the rest is skipped, not a
    /// stop; a path that descends through a null does not resolve there.</summary>
    private static bool TryResolve(List<object?> stack, string name, out object? value)
    {
        value = null;
        if (name == ".") { value = stack[^1]; return true; }
        string[] segs = name.Split('.');
        for (int i = stack.Count - 1; i >= 0; i--)
        {
            if (TryWalk(stack[i], segs, out value)) return true;
        }
        return false;
    }

    private static bool TryWalk(object? ctx, string[] segs, out object? value)
    {
        value = ctx;
        foreach (string seg in segs)
        {
            if (!TryProperty(value, seg, out value)) return false;
        }
        return true;
    }

    // One property read, as JavaScript finds it: a payload member, or a list's `length`.
    private static bool TryProperty(object? ctx, string key, out object? value)
    {
        if (PayloadAccessors.TryLookup(ctx, key, out value)) return true;
        if (key == LengthProperty && ctx is ICollection list and not IDictionary)
        {
            value = list.Count;
            return true;
        }
        return false;
    }

    private const string LengthProperty = "length";
}
