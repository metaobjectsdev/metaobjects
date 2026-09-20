// The codegen hash manifest — how a run tells its own output from a hand edit.
//
// Mirrors codegen-ts's `.gen-state/.hashes.json` and Python's overwrite_policy, using
// the same algorithm — sha-256 hex of the UTF-8 content — so the same file content
// hashes identically on every port.
//
// The KEYS deliberately do not match across ports, and a manifest is NOT portable
// between them — but all three now key by path relative to the PROJECT ROOT (TS because
// it supports multiple output targets; Python and C# because the manifest is ANCHORED on
// the project, so an out-dir-relative key made two runs with different --out collide on
// one entry). An earlier version of this comment claimed a conformance fixture could
// compare two ports' manifests directly — it cannot, and the claim was never true.
//
// Why the re-key: the gen-state dir is DERIVED from the project, not configured, so the
// advice this comment used to give ("point each out dir at its own gen-state dir") was
// never followable. With one shared key, generating a second port into a second --out
// recorded ITS content under the same entry, and the first out dir's hand-edited file
// then read as pristine on the next run — the edit destroyed by a run in a different
// directory. Keys are project-root-relative when the caller names a project; the
// out-dir-relative spelling is still READ as a legacy key so an existing manifest keeps
// working, and is dropped as each file converges on the new one.
//
// This file is meant to be COMMITTED. It is one hash per generated path — small and
// reviewable — where a full snapshot of previously-generated content would be a second
// copy of everything. A hash is already sufficient to answer the only question the
// write decision needs: is this file byte-for-byte what we wrote?

using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace MetaObjects.Codegen;

/// <summary>Reads and writes the per-path hash record of generated output.</summary>
public static class HashManifest
{
    private const string FileName = ".hashes.json";

    private static string PathFor(string genStateDir) => Path.Combine(genStateDir, FileName);

    /// <summary>sha-256 hex of <paramref name="content"/>.</summary>
    public static string ContentHash(string content) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant();

    /// <summary>
    /// Whether this project has a manifest AT ALL — distinct from "the manifest has no
    /// entry for this path". A project with no manifest predates the manifest being
    /// committed, so every refusal in it shares one cause and deserves one instruction
    /// rather than one warning per file.
    /// </summary>
    public static bool Exists(string genStateDir) => File.Exists(PathFor(genStateDir));

    /// <summary>Load the manifest; an absent or corrupt one reads as EMPTY, which fails
    /// closed (every file then refuses rather than being assumed ours).</summary>
    public static Dictionary<string, string> Load(string genStateDir)
    {
        var path = PathFor(genStateDir);
        if (!File.Exists(path)) return new Dictionary<string, string>(StringComparer.Ordinal);
        try
        {
            var parsed = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(path));
            return parsed is null
                ? new Dictionary<string, string>(StringComparer.Ordinal)
                : new Dictionary<string, string>(parsed, StringComparer.Ordinal);
        }
        catch (Exception e) when (e is JsonException or IOException or UnauthorizedAccessException)
        {
            return new Dictionary<string, string>(StringComparer.Ordinal);
        }
    }

    /// <summary>Persist the manifest with SORTED keys.
    /// <para>
    /// Sorted because the file is committed: insertion order would make the diff — and
    /// any merge conflict between two people who both regenerated — depend on which
    /// generator happened to run first.
    /// </para></summary>
    public static void Save(string genStateDir, Dictionary<string, string> hashes)
    {
        Directory.CreateDirectory(genStateDir);
        var ordered = new SortedDictionary<string, string>(hashes, StringComparer.Ordinal);
        var json = JsonSerializer.Serialize(ordered, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(PathFor(genStateDir), json + "\n");
    }

    /// <summary>Record that <paramref name="relPath"/> was written with this content.
    /// <para>
    /// <paramref name="legacyRelPath"/> is the OUT-DIR-relative key the same file may be
    /// recorded under from before keys became project-root-relative. It is REMOVED here,
    /// so a manifest converges on one spelling per file as that file is regenerated
    /// rather than carrying both forever.
    /// </para></summary>
    public static void Record(
        string genStateDir, string relPath, string content, string? legacyRelPath = null)
    {
        var hashes = Load(genStateDir);
        hashes[relPath] = ContentHash(content);
        if (legacyRelPath is not null && !string.Equals(legacyRelPath, relPath, StringComparison.Ordinal))
            hashes.Remove(legacyRelPath);
        Save(genStateDir, hashes);
    }

    /// <summary>
    /// The hash recorded when we last wrote <paramref name="relPath"/>, or <c>null</c> if
    /// never. Falls back to <paramref name="legacyRelPath"/> — the out-dir-relative key
    /// predating the re-key — so an adopter's committed manifest keeps working instead of
    /// turning every file into a refusal on upgrade.
    /// </summary>
    private static string? Recorded(string genStateDir, string relPath, string? legacyRelPath)
    {
        var hashes = Load(genStateDir);
        if (hashes.TryGetValue(relPath, out var recorded)) return recorded;
        if (legacyRelPath is not null && hashes.TryGetValue(legacyRelPath, out var legacy)) return legacy;
        return null;
    }

    /// <summary>
    /// Whether the file is byte-for-byte what we recorded writing. FAILS CLOSED —
    /// <c>false</c> when it cannot be proven.
    /// </summary>
    public static bool IsPristine(
        string genStateDir, string relPath, string current, string? legacyRelPath = null) =>
        Recorded(genStateDir, relPath, legacyRelPath) == ContentHash(current);
}
