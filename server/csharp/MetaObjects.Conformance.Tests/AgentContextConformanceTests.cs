// AgentContextConformanceTests — the cross-port agent-context BYTE-IDENTITY gate.
//
// For each fixtures/agent-context-conformance/<stack>/ corpus case, assemble the
// consumer files against the repo-root agent-context/ content tree and assert the
// output is byte-identical to the committed expected/<path> goldens — same set of
// paths AND same bytes per file. The goldens are produced by the TypeScript reference
// assembler; passing this proves the C# port reproduces it exactly.
//
// Mirrors the Java AgentContextConformanceTest and the Python reference test, plus the
// render-conformance harness's walk-up-from-AppContext.BaseDirectory repo-root pattern.

using System.Text;
using System.Text.Json;
using MetaObjects.AgentContext;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public sealed class AgentContextConformanceTests
{
    private static readonly string? RepoRoot = ResolveRepoRoot();
    private static readonly string Corpus =
        RepoRoot is null ? "" : Path.Combine(RepoRoot, "fixtures", "agent-context-conformance");
    private static readonly string ContentRootDir =
        RepoRoot is null ? "" : Path.Combine(RepoRoot, "agent-context");

    // Walk up from the test binary's base dir to the directory holding BOTH
    // fixtures/agent-context-conformance/ and agent-context/.
    private static string? ResolveRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "fixtures", "agent-context-conformance"))
                && Directory.Exists(Path.Combine(dir.FullName, "agent-context")))
                return dir.FullName;
            dir = dir.Parent;
        }
        return null;
    }

    public static IEnumerable<object[]> Stacks()
    {
        if (RepoRoot is null || !Directory.Exists(Corpus)) yield break;
        foreach (var dir in Directory.EnumerateDirectories(Corpus)
                     .Where(d => File.Exists(Path.Combine(d, "stack.json")))
                     .OrderBy(d => d, StringComparer.Ordinal))
        {
            yield return new object[] { Path.GetFileName(dir), dir };
        }
    }

    [Theory]
    [MemberData(nameof(Stacks))]
    public void ByteIdentical(string stackName, string caseDir)
    {
        Assert.True(RepoRoot is not null, "could not locate repo root (fixtures + agent-context)");

        var spec = JsonDocument.Parse(File.ReadAllText(Path.Combine(caseDir, "stack.json"))).RootElement;
        var stack = Stack.Of(JsonStrings(spec, "servers"), JsonStrings(spec, "clients"));

        var produced = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        foreach (var f in AgentContextAssembler.Assemble(ContentRootDir, stack))
            produced[f.Path] = Encoding.UTF8.GetBytes(f.Contents);

        var expected = CollectExpected(Path.Combine(caseDir, "expected"));

        Assert.True(
            expected.Keys.OrderBy(k => k, StringComparer.Ordinal)
                .SequenceEqual(produced.Keys.OrderBy(k => k, StringComparer.Ordinal)),
            $"[{stackName}] path set mismatch:\n" +
            $"  expected: {string.Join(", ", expected.Keys.OrderBy(k => k, StringComparer.Ordinal))}\n" +
            $"  produced: {string.Join(", ", produced.Keys.OrderBy(k => k, StringComparer.Ordinal))}");

        foreach (var path in expected.Keys.OrderBy(k => k, StringComparer.Ordinal))
        {
            Assert.True(
                expected[path].AsSpan().SequenceEqual(produced[path]),
                $"[{stackName}] byte mismatch at {path}");
        }
    }

    private static List<string> JsonStrings(JsonElement obj, string key)
    {
        var result = new List<string>();
        if (obj.TryGetProperty(key, out var arr) && arr.ValueKind == JsonValueKind.Array)
            foreach (var e in arr.EnumerateArray())
                result.Add(e.GetString()!);
        return result;
    }

    private static Dictionary<string, byte[]> CollectExpected(string expectedDir)
    {
        var result = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        foreach (var p in Directory.EnumerateFiles(expectedDir, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(expectedDir, p).Replace('\\', '/');
            result[rel] = File.ReadAllBytes(p);
        }
        return result;
    }
}
