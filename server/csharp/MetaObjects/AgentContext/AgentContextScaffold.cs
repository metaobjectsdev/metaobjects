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
    /// <param name="GeneratedBy">
    /// The MetaObjects version that last scaffolded this agent context. Used to nudge a
    /// re-scaffold when the installed version moves ahead (the skills/docs ship with the
    /// package, so an upgrade can leave the copied-in context stale). Nullable for
    /// back-compat with manifests written before version tracking existed.
    /// </param>
    public sealed record Manifest(
        int Version,
        string? GeneratedBy,
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
    /// <param name="generatedBy">The MetaObjects version doing the scaffold — stamped into the manifest.</param>
    public static ScaffoldDecision Plan(
        Stack stack,
        IReadOnlyList<AssembledFile> assembled,
        Manifest? prior,
        Func<string, string?> readCurrent,
        string generatedBy)
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
        // Dictionary enumeration order is not contractual; sort ordinally so the printed
        // "no longer applies" notes are deterministic and match the path-sorted manifest.
        var removed = prior is null
            ? new List<string>()
            : prior.Files.Keys.Where(p => !assembledPaths.Contains(p))
                .OrderBy(p => p, StringComparer.Ordinal).ToList();

        var manifest = new Manifest(
            1,
            generatedBy,
            stack.Servers.ToList(),
            stack.Clients.ToList(),
            files);
        return new ScaffoldDecision(writes, conflicts, manifest, removed);
    }

    /// <summary>
    /// A one-line nudge if the scaffolded agent context predates the installed MetaObjects
    /// (so <c>gen</c>/<c>verify</c> can remind the user to refresh the skills after an
    /// upgrade), or <c>null</c> when there is nothing to say — no agent context scaffolded,
    /// or it is in sync. Advisory only: never throws, never blocks, never writes. Pure.
    /// </summary>
    public static string? AgentContextStaleness(Manifest? manifest, string currentVersion)
    {
        if (manifest is null) return null; // no agent context here → nothing to nudge
        // Exact-equality on purpose: ANY drift nudges (a re-scaffold is cheap + idempotent).
        // Don't "fix" this into a semver compare — a prerelease/build-metadata difference is
        // still a reason to refresh, and the nudge is advisory, never a gate.
        if (manifest.GeneratedBy == currentVersion) return null; // in sync
        var from = manifest.GeneratedBy ?? "an older MetaObjects";
        return
            $"MetaObjects agent context was generated by {from}; you're on {currentVersion}. " +
            "Re-run 'dotnet meta agent-docs' to refresh the .claude/skills docs.";
    }
}
