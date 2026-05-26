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
    private static readonly Regex IdentRe =
        new("^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);

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
                if (IdentRe.IsMatch(key))
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

    private enum SegmentKind { Key, Index }

    private readonly record struct Segment(SegmentKind Kind, string? Key, int Index);
}

/// <summary>
/// Static helpers for one-shot JSONPath rendering when a builder is overkill.
/// </summary>
public static class JsonPath
{
    private static readonly Regex IdentRe =
        new("^[A-Za-z_][A-Za-z0-9_]*$", RegexOptions.Compiled);

    /// <summary>
    /// Render a single object-key segment as it would appear in canonical form,
    /// without the leading <c>$</c> — i.e. <c>.foo</c> or <c>['my-key']</c>.
    /// </summary>
    public static string SegmentForKey(string key)
    {
        return IdentRe.IsMatch(key)
            ? $".{key}"
            : $"['{key.Replace("'", "\\'")}']";
    }

    /// <summary>
    /// Render a single array-index segment: <c>[N]</c>.
    /// </summary>
    public static string SegmentForIndex(int idx) => $"[{idx}]";
}
