// FR5a / ADR-0009 — Canonical JSONPath builder.
//
// Construction rules (cross-port-aligned; every port emits this canonical form
// byte-identically):
//   - Root is `$`.
//   - Object keys matching ^[A-Za-z_][A-Za-z0-9_]*$ use dot notation: `.foo`.
//   - All other keys use single-quoted bracket form: `['my-key']`, `['@attr']`.
//   - Array indices use bracket form: `[N]`.
//   - No trailing dots, no whitespace.

using System.Text;
using System.Text.RegularExpressions;

namespace MetaObjects.Source;

/// <summary>
/// Shared identifier regex for dot-vs-bracket key dispatch. Used by both
/// <see cref="JsonPathBuilder"/> and the <see cref="JsonPath"/> static helpers.
/// </summary>
internal static class JsonPathRegex
{
    public static readonly Regex Ident =
        new("^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);
}

/// <summary>
/// Builds the canonical JSONPath string for a node as the parser walks the
/// JSON tree. Push a key or index when descending; pop when returning.
///
/// <para>
/// Mirrors <c>JsonPathBuilder</c> in
/// <c>typescript/packages/metadata/src/json-path.ts</c>.
/// </para>
/// </summary>
public sealed class JsonPathBuilder
{
    private readonly List<Segment> _segments = new();

    /// <summary>Push an object key segment (e.g. <c>.foo</c> or <c>['my-key']</c>).</summary>
    public void PushKey(string key) => _segments.Add(new Segment(SegmentKind.Key, key, 0));

    /// <summary>Push an array-index segment (e.g. <c>[2]</c>).</summary>
    public void PushIndex(int idx) => _segments.Add(new Segment(SegmentKind.Index, null, idx));

    /// <summary>Pop the most recently pushed segment.</summary>
    public void Pop()
    {
        if (_segments.Count > 0) _segments.RemoveAt(_segments.Count - 1);
    }

    /// <summary>Number of segments currently on the stack (root is segment 0; not counted).</summary>
    public int Depth => _segments.Count;

    /// <summary>
    /// ADR-0055 — capture the current stack so a declaration deferred out of the
    /// walk can be re-seeded when it is applied. By then the walk that built this
    /// path has unwound, so an error raised at application time would otherwise
    /// carry the wrong path (or none).
    /// </summary>
    public Capture Snapshot() => new(_segments.ToArray());

    /// <summary>ADR-0055 — re-seed this builder from a <see cref="Snapshot"/>.</summary>
    public void Restore(Capture capture)
    {
        _segments.Clear();
        _segments.AddRange(capture.Segments);
    }

    /// <summary>ADR-0055 — an opaque capture of a builder's stack.</summary>
    public sealed class Capture
    {
        internal Segment[] Segments { get; }
        internal Capture(Segment[] segments) => Segments = segments;
    }

    /// <summary>
    /// Render the current stack as a canonical JSONPath string.
    /// </summary>
    public override string ToString()
    {
        // ~8 chars per segment is a reasonable starting cap.
        var sb = new StringBuilder(_segments.Count * 8 + 1);
        sb.Append('$');
        foreach (var seg in _segments)
        {
            if (seg.Kind == SegmentKind.Index)
            {
                sb.Append('[').Append(seg.Index).Append(']');
            }
            else
            {
                string key = seg.Key!;
                if (JsonPathRegex.Ident.IsMatch(key))
                {
                    sb.Append('.').Append(key);
                }
                else
                {
                    sb.Append("['").Append(key.Replace("'", "\\'")).Append("']");
                }
            }
        }
        return sb.ToString();
    }

    // internal (not private) so the public ADR-0055 Capture can hold an array of
    // these in an internal member without CS0053.
    internal enum SegmentKind { Key, Index }

    internal readonly record struct Segment(SegmentKind Kind, string? Key, int Index);
}

/// <summary>
/// Static helpers for one-shot JSONPath rendering when a builder is overkill.
/// </summary>
public static class JsonPath
{
    /// <summary>
    /// Render a single object-key segment as it would appear in canonical form,
    /// without the leading <c>$</c> — i.e. <c>.foo</c> or <c>['my-key']</c>.
    /// </summary>
    public static string SegmentForKey(string key)
    {
        return JsonPathRegex.Ident.IsMatch(key)
            ? $".{key}"
            : $"['{key.Replace("'", "\\'")}']";
    }

    /// <summary>
    /// Render a single array-index segment: <c>[N]</c>.
    /// </summary>
    public static string SegmentForIndex(int idx) => $"[{idx}]";
}
