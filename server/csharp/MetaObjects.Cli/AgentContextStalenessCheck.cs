// AgentContextStalenessCheck — the side-effecting half of the agent-context staleness
// nudge (the pure decision lives in MetaObjects.AgentContext.AgentContextScaffold).
//
// Port of the TS cli lib (version.ts + agent-context-staleness.ts): read the installed
// MetaObjects version from the assembly, read the consumer's sidecar manifest if present,
// and print ONE advisory line to stderr when the scaffolded agent context predates this
// build. Advisory only — never throws, never blocks, never writes, never changes the exit
// code. A missing/corrupt manifest is silently ignored (this is a reminder, not a gate).

using System.Reflection;
using System.Text.Json;
using MetaObjects.AgentContext;

namespace MetaObjects.Cli;

/// <summary>Reads the manifest + installed version and emits the staleness nudge (advisory).</summary>
public static class AgentContextStalenessCheck
{
    /// <summary>
    /// The installed MetaObjects version, read from the assembly (the
    /// <c>AssemblyInformationalVersion</c>, falling back to the assembly version), with a
    /// safe <c>"0.0.0"</c> fallback when neither is present. Never a hardcoded literal.
    /// </summary>
    public static string CurrentVersion()
    {
        var asm = typeof(AgentContextScaffold).Assembly;
        var info = asm.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (!string.IsNullOrEmpty(info)) return info;
        var ver = asm.GetName().Version?.ToString();
        return string.IsNullOrEmpty(ver) ? "0.0.0" : ver;
    }

    /// <summary>
    /// If a scaffolded MetaObjects agent context under <paramref name="cwd"/> predates this
    /// build, write a one-line nudge to stderr. Never throws — an absent or corrupt manifest
    /// is silently ignored. Advisory: the caller's exit code is unaffected.
    /// </summary>
    public static void WarnIfStale(string cwd)
    {
        try
        {
            var path = Path.Combine(cwd, AgentContextScaffold.ManifestPath);
            if (!File.Exists(path)) return; // no agent context here → nothing to nudge

            AgentContextScaffold.Manifest? manifest;
            try
            {
                manifest = ReadManifest(path);
            }
            catch
            {
                return; // unreadable / corrupt — say nothing
            }

            var msg = AgentContextScaffold.AgentContextStaleness(manifest, CurrentVersion());
            if (msg is not null) Console.Error.WriteLine(msg);
        }
        catch
        {
            // Belt-and-suspenders: an advisory must never break the command it rides on.
        }
    }

    private static AgentContextScaffold.Manifest? ReadManifest(string path)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var root = doc.RootElement;
        // Only generatedBy is load-bearing for the decision; the rest is read for fidelity.
        var version = root.TryGetProperty("version", out var v) && v.ValueKind == JsonValueKind.Number
            ? v.GetInt32() : 1;
        var generatedBy = root.TryGetProperty("generatedBy", out var g) ? g.GetString() : null;
        return new AgentContextScaffold.Manifest(
            version, generatedBy, Array.Empty<string>(), Array.Empty<string>(),
            new Dictionary<string, string>());
    }
}
