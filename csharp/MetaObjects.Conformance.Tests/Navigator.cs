// Navigator.cs — port of typescript/packages/metadata/test/conformance/navigator.ts.
//
// Interprets a script.json navigate path over the typed MetaData tree.
// A path segment is either `type:name` or `type[subType]` for nameless nodes.

using System.Text.RegularExpressions;
using MetaObjects.Meta;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// Walks a <see cref="MetaData"/> tree along a sequence of path segments.
/// </summary>
public static class Navigator
{
    private static readonly Regex BracketPattern =
        new(@"^([a-z]+)\[([a-zA-Z]+)\]$", RegexOptions.Compiled);

    /// <summary>
    /// Walk <paramref name="root"/>.Children() matching each path segment.
    /// Returns the resolved node, or <see langword="null"/> if any segment misses.
    /// An empty path returns <paramref name="root"/> itself (identity case).
    /// </summary>
    public static MetaData? Navigate(MetaData root, IReadOnlyList<string> path)
    {
        MetaData current = root;
        foreach (var segment in path)
        {
            var next = current.Children().FirstOrDefault(c => MatchSegment(c, segment));
            if (next is null) return null;
            current = next;
        }
        return current;
    }

    private static bool MatchSegment(MetaData node, string segment)
    {
        var bracketMatch = BracketPattern.Match(segment);
        if (bracketMatch.Success)
        {
            return node.Type == bracketMatch.Groups[1].Value &&
                   node.SubType == bracketMatch.Groups[2].Value;
        }

        var colonIdx = segment.IndexOf(':');
        if (colonIdx == -1) return false;

        return node.Type == segment[..colonIdx] &&
               node.Name == segment[(colonIdx + 1)..];
    }
}
