// AgentContextScaffold — scaffold planning + sidecar manifest for the writer.
//
// Port of server/typescript/packages/sdk/src/agent-context/scaffold.ts (and the Java
// AgentContextScaffold / Python metaobjects.agent_context.scaffold). Pure: all
// filesystem access is via a readCurrent callback so the planning logic is testable
// without touching disk.
//
// A file is safe to overwrite iff it is absent, or its on-disk sha256 still equals
// the hash the prior manifest recorded (the user hasn't hand-edited it). A
// hand-edited file is preserved — the fresh contents go to <path>.new instead.

using System.Security.Cryptography;
using System.Text;

namespace MetaObjects.AgentContext;

/// <summary>Scaffold planning + sidecar manifest for the agent-context writer.</summary>
public static class AgentContextScaffold
{
    /// <summary>Consumer-relative path of the sidecar manifest that tracks scaffolded files.</summary>
    public const string ManifestPath = ".metaobjects/.agent-context.json";

    /// <summary>A file to (over)write at its own path.</summary>
    public sealed record Write(string Path, string Contents);

    /// <summary>A hand-edited file: write the fresh contents to <c>NewPath</c>, keep the original.</summary>
    public sealed record Conflict(string Path, string NewPath, string Contents);

    /// <summary>Tracks what the assembler last wrote, so re-runs can detect hand-edits.</summary>
    public sealed record Manifest(
        int Version,
        IReadOnlyList<string> Servers,
        IReadOnlyList<string> Clients,
        IReadOnlyDictionary<string, string> Files);

    /// <summary>The outcome of planning a (re-)scaffold.</summary>
    public sealed record ScaffoldDecision(
        IReadOnlyList<Write> Writes,
        IReadOnlyList<Conflict> Conflicts,
        Manifest Manifest,
        IReadOnlyList<string> Removed);

    /// <summary>sha256 hex of the UTF-8 bytes of <paramref name="s"/> (matches the TS/Java/Python digest).</summary>
    public static string HashContents(string s)
    {
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(s));
        return Convert.ToHexString(digest).ToLowerInvariant();
    }

    /// <summary>
    /// Decide what to write for a (re-)scaffold. Pure: filesystem access is via the
    /// <paramref name="readCurrent"/> function (returns on-disk contents, or <c>null</c> if absent).
    /// </summary>
    public static ScaffoldDecision Plan(
        Stack stack,
        IReadOnlyList<AssembledFile> assembled,
        Manifest? prior,
        Func<string, string?> readCurrent)
    {
        var writes = new List<Write>();
        var conflicts = new List<Conflict>();
        var files = new Dictionary<string, string>();

        foreach (var f in assembled)
        {
            files[f.Path] = HashContents(f.Contents);
            var current = readCurrent(f.Path);
            if (current is null)
            {
                writes.Add(new Write(f.Path, f.Contents));
                continue;
            }
            var priorHash = prior?.Files.GetValueOrDefault(f.Path);
            if (priorHash is not null && HashContents(current) == priorHash)
            {
                writes.Add(new Write(f.Path, f.Contents)); // unmodified → refresh
            }
            else
            {
                conflicts.Add(new Conflict(f.Path, $"{f.Path}.new", f.Contents));
            }
        }

        var assembledPaths = assembled.Select(f => f.Path).ToHashSet();
        var removed = prior is null
            ? new List<string>()
            : prior.Files.Keys.Where(p => !assembledPaths.Contains(p)).ToList();

        var manifest = new Manifest(
            1,
            stack.Servers.ToList(),
            stack.Clients.ToList(),
            files);
        return new ScaffoldDecision(writes, conflicts, manifest, removed);
    }
}
