// The codegen hash manifest — how a run tells its own output from a hand edit.
//
// Mirrors codegen-ts's `.gen-state/.hashes.json` and Python's overwrite_policy, using
// the same algorithm — sha-256 hex of the UTF-8 content — so the same file content
// hashes identically on every port.
//
// The KEYS deliberately do not match across ports, and a manifest is NOT portable
// between them. TS keys by path relative to the PROJECT ROOT because it supports
// multiple output targets; C# and Python key relative to their single out dir. An
// earlier version of this comment claimed a conformance fixture could compare two
// ports' manifests directly — it cannot, and the claim was never true.
//
// One consequence worth knowing: because the key here is out-dir-relative, running gen
// twice with different out dirs against ONE gen-state dir collides two distinct files
// onto one key. Point each out dir at its own gen-state dir, or use the TS toolchain,
// which is project-rooted and does not have the ambiguity.
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

    /// <summary>Record that <paramref name="relPath"/> was written with this content.</summary>
    public static void Record(string genStateDir, string relPath, string content)
    {
        var hashes = Load(genStateDir);
        hashes[relPath] = ContentHash(content);
        Save(genStateDir, hashes);
    }

    /// <summary>
    /// Whether the file is byte-for-byte what we recorded writing. FAILS CLOSED —
    /// <c>false</c> when it cannot be proven.
    /// </summary>
    public static bool IsPristine(string genStateDir, string relPath, string current) =>
        Load(genStateDir).TryGetValue(relPath, out var recorded) && recorded == ContentHash(current);
}
