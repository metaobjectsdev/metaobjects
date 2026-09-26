// ADR-0034 Amendment 3 — eject. How an OWNED generator copy (codegen/generators/<file>)
// compares to the reference `dotnet meta eject` would write today. Line-multiset
// comparison, the same shape as the Python port's owned_status (Counter subtraction) —
// NOT the formatter-canonicalized comparison TS's owned-copy.ts does, since this port
// has no bundled C# formatter to normalise through. "behind" counts reference lines the
// copy lacks (upstream moved); "of your own" counts copy lines the reference lacks
// (your edit). The comparison is against the REWRITTEN reference (EjectableGenerators.
// RewriteForEject applied) — the namespace/using lines eject itself changes are not
// "your edit" and must never show up as drift.

namespace MetaObjects.Cli;

public static class OwnedCopy
{
    public enum Verdict { Identical, Differs }

    public sealed record Comparison(Verdict Verdict, int Behind, int OfYourOwn);

    /// <summary>Where an owned copy lands, relative to the project root. Mirrors the
    /// TS/Python layout (<c>codegen/generators/</c>).</summary>
    public static string OwnedPath(string root, string sourceFileName) =>
        Path.Combine(root, "codegen", "generators", sourceFileName);

    /// <summary>The non-blank line multiset of <paramref name="text"/>, trailing
    /// whitespace and CRLF stripped per line so a checkout's line-ending style never
    /// reads as drift.</summary>
    private static Dictionary<string, int> LineCounts(string text)
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.TrimEnd('\r', ' ', '\t');
            if (line.Length == 0) continue;
            counts[line] = counts.GetValueOrDefault(line) + 1;
        }
        return counts;
    }

    /// <summary>Line-multiset compare <paramref name="owned"/> against <paramref
    /// name="reference"/>.</summary>
    public static Comparison Compare(string owned, string reference)
    {
        var mine = LineCounts(owned);
        var theirs = LineCounts(reference);
        int behind = 0, ofYourOwn = 0;
        foreach (var line in mine.Keys.Concat(theirs.Keys).Distinct(StringComparer.Ordinal))
        {
            var m = mine.GetValueOrDefault(line);
            var r = theirs.GetValueOrDefault(line);
            if (r > m) behind += r - m;
            if (m > r) ofYourOwn += m - r;
        }
        return new Comparison(behind == 0 && ofYourOwn == 0 ? Verdict.Identical : Verdict.Differs, behind, ofYourOwn);
    }

    /// <summary>
    /// <c>"identical"</c> / <c>"DIFFERS: N behind, M of your own"</c>, or <c>null</c> when
    /// <paramref name="entry"/> is not ejectable or nothing is owned at <paramref
    /// name="root"/> yet. What <c>dotnet meta gen --list</c> appends to each entry.
    /// </summary>
    public static string? Status(string root, MetaObjects.Codegen.GeneratorRegistryEntry entry)
    {
        if (entry.SourceFileName is not { } file) return null;
        var path = OwnedPath(root, file);
        if (!File.Exists(path)) return null;

        var mine = File.ReadAllText(path);
        var reference = MetaObjects.Codegen.EjectableGenerators.RewriteForEject(
            MetaObjects.Codegen.EjectableGenerators.ReadSourceFile(file));
        var cmp = Compare(mine, reference);
        return cmp.Verdict == Verdict.Identical
            ? "identical"
            : $"DIFFERS: {cmp.Behind} behind, {cmp.OfYourOwn} of your own";
    }

    /// <summary>
    /// How the owned helper runtime (codegen/runtime/, written by ejecting a generator whose
    /// output imports it) compares to what eject would write today: <c>"identical"</c>, or
    /// one <c>"&lt;file&gt; DIFFERS: N behind, M of your own"</c> / <c>"&lt;file&gt;
    /// missing"</c> clause per file that is not, joined with <c>"; "</c>. <c>null</c> when
    /// nothing is owned there. The comparison is against the REWRITTEN reference, so the
    /// namespace line eject itself changes never reads as your edit. A file you added
    /// yourself is yours and is not reported.
    /// </summary>
    public static string? RuntimeStatus(string root)
    {
        var dir = Path.Combine(root, MetaObjects.Codegen.HelperRuntime.OwnedDirectory);
        if (!Directory.Exists(dir)) return null;
        var clauses = new List<string>();
        foreach (var file in MetaObjects.Codegen.HelperRuntime.Files)
        {
            var path = Path.Combine(dir, file);
            if (!File.Exists(path))
            {
                clauses.Add($"{file} missing");
                continue;
            }
            var cmp = Compare(File.ReadAllText(path), MetaObjects.Codegen.HelperRuntime.OwnedReference(file));
            if (cmp.Verdict == Verdict.Differs)
                clauses.Add($"{file} DIFFERS: {cmp.Behind} behind, {cmp.OfYourOwn} of your own");
        }
        return clauses.Count == 0 ? "identical" : string.Join("; ", clauses);
    }
}
