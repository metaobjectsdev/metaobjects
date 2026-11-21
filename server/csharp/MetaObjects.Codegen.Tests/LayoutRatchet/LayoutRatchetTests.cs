// The layout ratchet (ADR-0063): generator source never types layout; the writer does.
//
// Three parts:
//   1. the analyzer's own cases: layout it must catch, and writer-based code it must pass;
//   2. the scope rule: which files are generator source, by rule and not by list;
//   3. the ratchet over the real project: every file with hand-typed layout is on the allowlist
//      with a reason, every allowlisted file still needs its entry, and the allowlist only shrinks.

using System.Diagnostics;
using System.Text.Json;
using Xunit;

namespace MetaObjects.Codegen.Tests.LayoutRatchet;

public class LayoutRatchetTests
{
    private static List<FindingKind> Kinds(string source) =>
        LayoutAnalyzer.Analyze(source).Select(f => f.Kind).OrderBy(k => k).ToList();

    // ── 1. the analyzer ──────────────────────────────────────────────────────────────────

    public static TheoryData<string, string, FindingKind[]> Caught => new()
    {
        { "a newline escape in a string", """var s = "a\nb";""", [FindingKind.NewlineLiteral] },
        { "a unicode newline escape", """var s = "a\u000ab";""", [FindingKind.NewlineLiteral] },
        { "a carriage return", """var s = "a\r";""", [FindingKind.NewlineLiteral] },
        { "a newline char", """sb.Append('\n');""", [FindingKind.NewlineLiteral] },
        { "a verbatim string that spans lines", "var s = @\"a\nb\";", [FindingKind.NewlineLiteral] },
        { "a line break inside an interpolated string", "var s = $\"{a}\\n{b}\";", [FindingKind.NewlineLiteral] },
        { "a string that starts with two spaces", """rows.Add("  " + name);""", [FindingKind.IndentLiteral] },
        { "a string that starts with a tab", """rows.Add("\tx");""", [FindingKind.IndentLiteral] },
        { "an interpolated string that starts with an indentation run", "rows.Add($\"    {name};\");", [FindingKind.IndentLiteral] },
        { "a join on a newline literal", """var s = string.Join("\n", xs);""", [FindingKind.NewlineJoin, FindingKind.NewlineLiteral] },
        { "a join on Environment.NewLine", "var s = string.Join(Environment.NewLine, xs);", [FindingKind.EnvironmentNewline, FindingKind.NewlineJoin] },
        { "a StringBuilder line", """sb.AppendLine("class A");""", [FindingKind.AppendLine] },
        { "Environment.NewLine", "sb.Append(Environment.NewLine);", [FindingKind.EnvironmentNewline] },
        { "new string of spaces", "var pad = new string(' ', depth * 4);", [FindingKind.IndentRepeat] },
        { "Enumerable.Repeat of spaces", """var pad = string.Concat(Enumerable.Repeat("  ", depth));""", [FindingKind.IndentRepeat, FindingKind.IndentLiteral] },
        { "PadLeft on an empty string", """var pad = "".PadLeft(depth * 2);""", [FindingKind.IndentRepeat] },
    };

    [Theory]
    [MemberData(nameof(Caught))]
    public void The_analyzer_catches_hand_typed_layout(string name, string source, FindingKind[] expected)
    {
        _ = name;
        Assert.Equal(expected.OrderBy(k => k).ToList(), Kinds(source));
    }

    [Fact]
    public void A_newline_hidden_behind_a_same_file_constant_is_caught_where_it_is_used()
    {
        var found = LayoutAnalyzer.Analyze("const string NL = \"\\n\";\nvar s = string.Join(NL, xs);\n");
        Assert.Equal([(FindingKind.NewlineLiteral, 1), (FindingKind.NewlineJoin, 2)], found.Select(f => (f.Kind, f.Line)).ToArray());
    }

    [Fact]
    public void The_constant_may_be_built_from_other_constants()
    {
        var source = "const string NL = \"\\n\";\nconst string SEP = \",\" + NL;\nvar a = string.Join(SEP, xs);\n";
        Assert.Equal([3], LayoutAnalyzer.Analyze(source).Where(f => f.Kind == FindingKind.NewlineJoin).Select(f => f.Line).ToArray());
    }

    [Fact]
    public void An_indentation_unit_hidden_behind_a_constant_is_caught_at_the_repeat()
    {
        Assert.Equal([FindingKind.IndentRepeat], Kinds("const string UNIT = \" \";\nvar pad = new string(' ', 4); var q = string.Concat(Enumerable.Repeat(UNIT, 4));").Take(1));
    }

    [Fact]
    public void Findings_carry_the_line_and_column_of_the_node()
    {
        var f = Assert.Single(LayoutAnalyzer.Analyze("var a = 1;\n  var s = \"x\\ny\";\n"));
        Assert.Equal((2, 11), (f.Line, f.Column));
    }

    public static TheoryData<string> Passed => new()
    {
        "w.Line(\"public class A\"); w.Line(\"{\");",
        "using (w.Braced(\"public class A\")) { w.Line(\"int X;\"); }",
        "// a comment may say \"a\\nb\" and sb.AppendLine(\"x\")\nvar x = 1;",
        "var parts = text.Split('\\n');",
        "var parts = text.Split(\"\\r\\n\");",
        "var has = text.Contains(\"\\n\");",
        "var cleaned = text.Replace(\"\\n\", \" \");",
        "var m = new Regex(\"a\\n\");",
        "w.Text(\"\"\"\n    fixed\n      code\n    \"\"\");",
        "var name = nameof(Foo);",
        "var s = string.Join(\", \", xs);",
        "var s = $\"{a} and {b}\";",
        "[Obsolete(\"a\\nb\")] class A { }",
    };

    [Theory]
    [MemberData(nameof(Passed))]
    public void The_analyzer_passes_code_that_leaves_layout_to_the_writer(string source) =>
        Assert.Empty(LayoutAnalyzer.Analyze(source));

    // ── 2. the scope rule ────────────────────────────────────────────────────────────────

    [Theory]
    [InlineData("MetaObjects.Codegen/Generators/NamesGenerator.cs", true)]
    [InlineData("MetaObjects.Codegen/CSharpNaming.cs", true)]
    [InlineData("MetaObjects.Codegen/Writer/CodeWriter.cs", false)]
    [InlineData("MetaObjects.Codegen/Writer/CsWriter.cs", false)]
    [InlineData("MetaObjects.Codegen/Runtime/FilterParser.cs", false)]
    [InlineData("MetaObjects.Codegen/Docs/XmlDocBuilder.cs", false)]
    [InlineData("MetaObjects.Codegen/ApiDocs/CSharpApiDocsRenderer.cs", false)]
    [InlineData("MetaObjects.Codegen/obj/Debug/net8.0/A.cs", false)]
    [InlineData("MetaObjects.Codegen.Tests/WriterConformanceTests.cs", false)]
    [InlineData("MetaObjects.Cli/Program.cs", false)]
    [InlineData("MetaObjects.Codegen/README.md", false)]
    public void Scope_is_decided_by_rule(string path, bool scanned) => Assert.Equal(scanned, LayoutAnalyzer.IsGeneratorSource(path));

    // ── 3. the ratchet over the real project ─────────────────────────────────────────────

    private sealed record Allowlist(Dictionary<string, string> Unconverted, Dictionary<string, string> Exempt);

    private static string Csharp => Path.Combine(CorpusPaths.RepoRoot(), "server", "csharp");

    private static string AllowlistPath => Path.Combine(Csharp, "MetaObjects.Codegen.Tests", "LayoutRatchet", "allowlist.json");

    private static Allowlist ReadAllowlist(string json)
    {
        using var doc = JsonDocument.Parse(json);
        Dictionary<string, string> Section(string name) =>
            doc.RootElement.TryGetProperty(name, out var e)
                ? e.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString()!, StringComparer.Ordinal)
                : new Dictionary<string, string>(StringComparer.Ordinal);
        return new Allowlist(Section("unconverted"), Section("exempt"));
    }

    private static readonly Lazy<Allowlist> Current = new(() => ReadAllowlist(File.ReadAllText(AllowlistPath)));

    private static Dictionary<string, string> Entries =>
        Current.Value.Unconverted.Concat(Current.Value.Exempt).ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.Ordinal);

    private static readonly Lazy<SortedDictionary<string, IReadOnlyList<Finding>>> Findings = new(() =>
    {
        var found = new SortedDictionary<string, IReadOnlyList<Finding>>(StringComparer.Ordinal);
        var root = Path.Combine(Csharp, LayoutAnalyzer.ScannedProject);
        foreach (var file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(Csharp, file).Replace('\\', '/');
            if (LayoutAnalyzer.IsGeneratorSource(rel)) found[rel] = LayoutAnalyzer.Analyze(File.ReadAllText(file));
        }
        return found;
    });

    [Fact]
    public void It_reads_the_generator_project()
    {
        Assert.Contains(Findings.Value.Keys, k => k.StartsWith("MetaObjects.Codegen/Generators/", StringComparison.Ordinal));
        Assert.DoesNotContain(Findings.Value.Keys, k => k.Contains("/Writer/", StringComparison.Ordinal));
    }

    [Fact]
    public void No_generator_source_types_layout_unless_its_file_is_allowlisted()
    {
        var offenders = Findings.Value
            .Where(kv => kv.Value.Count > 0 && !Entries.ContainsKey(kv.Key))
            .Select(kv => string.Join('\n', new[] { kv.Key }.Concat(kv.Value.Take(5).Select(f => $"  {f.Line}:{f.Column} {f.Kind} {f.Excerpt}"))))
            .ToList();
        Assert.True(offenders.Count == 0,
            "Write these lines through CsWriter (Writer/) instead of typing line breaks or indentation. " +
            "A file is never added to the allowlist: it only shrinks.\n" + string.Join('\n', offenders));
    }

    [Fact]
    public void Every_allowlisted_file_still_needs_its_entry()
    {
        var stale = Entries.Keys.Where(f => !Findings.Value.TryGetValue(f, out var found) || found.Count == 0).ToList();
        Assert.True(stale.Count == 0, "these files no longer type layout (or no longer exist): remove their allowlist entries: " + string.Join(", ", stale));
    }

    [Fact]
    public void Every_allowlisted_path_is_generator_source_that_exists()
    {
        foreach (var file in Entries.Keys)
        {
            Assert.True(LayoutAnalyzer.IsGeneratorSource(file), $"{file} is not in the ratchet's scope");
            Assert.True(File.Exists(Path.Combine(Csharp, file)), $"{file} does not exist");
        }
    }

    [Fact]
    public void Every_entry_carries_a_written_reason()
    {
        foreach (var (file, reason) in Entries) Assert.True(reason.Length > 40, $"{file} needs a reason");
    }

    [Fact]
    public void A_file_is_either_unconverted_or_exempt_never_both_and_each_list_is_sorted()
    {
        Assert.Empty(Current.Value.Unconverted.Keys.Where(Current.Value.Exempt.ContainsKey));
        foreach (var list in new[] { Current.Value.Unconverted, Current.Value.Exempt })
            Assert.Equal(list.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList(), list.Keys.ToList());
    }

    [Fact]
    public void Growth_is_an_added_entry_or_an_unconverted_file_relabelled_exempt_removal_is_not()
    {
        var before = new Allowlist(new() { ["a.cs"] = "r", ["b.cs"] = "r" }, new() { ["c.cs"] = "r" });
        Assert.Empty(Growth(before, new Allowlist(new() { ["a.cs"] = "r" }, new())));
        Assert.Equal(["added d.cs"], Growth(before, new Allowlist(new() { ["a.cs"] = "r", ["d.cs"] = "r" }, new() { ["c.cs"] = "r" })));
        Assert.Equal(["relabelled b.cs as exempt"], Growth(before, new Allowlist(new() { ["a.cs"] = "r" }, new() { ["b.cs"] = "r", ["c.cs"] = "r" })));
    }

    // The allowlist may only shrink. Compared with the copy at the merge base of every
    // integration branch this checkout knows: an entry that is not there was added here. Skipped
    // (and quiet) when git or those refs are unavailable, as in an export or a shallow clone, and
    // for the branch that introduces the allowlist, which has no earlier copy to compare with.
    [Fact]
    public void The_allowlist_only_shrinks()
    {
        foreach (var (reference, before) in MergeBaseAllowlists())
        {
            var grown = Growth(before, Current.Value);
            Assert.True(grown.Count == 0, $"the allowlist grew since the merge base with {reference}; convert the file to the writer instead: {string.Join(", ", grown)}");
        }
    }

    private static List<string> Growth(Allowlist before, Allowlist now)
    {
        var had = before.Unconverted.Keys.Concat(before.Exempt.Keys).ToHashSet(StringComparer.Ordinal);
        return now.Unconverted.Keys.Concat(now.Exempt.Keys).Where(f => !had.Contains(f)).Select(f => $"added {f}")
            .Concat(now.Exempt.Keys.Where(before.Unconverted.ContainsKey).Select(f => $"relabelled {f} as exempt"))
            .ToList();
    }

    private static List<(string Ref, Allowlist List)> MergeBaseAllowlists()
    {
        var repo = CorpusPaths.RepoRoot();
        var rel = Path.GetRelativePath(repo, AllowlistPath).Replace('\\', '/');
        var refs = Git(repo, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/main", "refs/remotes/origin/release/");
        var found = new List<(string, Allowlist)>();
        if (string.IsNullOrWhiteSpace(refs)) return found;
        foreach (var reference in refs.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
        {
            var baseSha = Git(repo, "merge-base", "HEAD", reference)?.Trim();
            if (string.IsNullOrEmpty(baseSha)) continue;
            var text = Git(repo, "show", $"{baseSha}:{rel}");
            if (text is not null) found.Add((reference, ReadAllowlist(text)));
        }
        return found;
    }

    private static string? Git(string repo, params string[] args)
    {
        var info = new ProcessStartInfo("git") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        info.ArgumentList.Add("-C");
        info.ArgumentList.Add(repo);
        foreach (var a in args) info.ArgumentList.Add(a);
        try
        {
            using var p = Process.Start(info);
            if (p is null) return null;
            var output = p.StandardOutput.ReadToEnd();
            p.StandardError.ReadToEnd();
            p.WaitForExit();
            return p.ExitCode == 0 ? output : null;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return null;
        }
    }
}
