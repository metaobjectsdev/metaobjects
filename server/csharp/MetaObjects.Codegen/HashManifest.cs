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
    public static bool Exists(string genStateDir) =>
        File.Exists(PathFor(genStateDir)) || (BatchFor(genStateDir)?.Dirty ?? false);

    private sealed class ManifestBatch(Dictionary<string, JsonElement> raw)
    {
        public Dictionary<string, JsonElement> Raw = raw;
        public bool Dirty;
    }

    // One in-memory manifest per gen-state dir while a run is in progress. Without it every
    // recorded file re-read and re-wrote the whole manifest, so a run of N files wrote it N
    // times. Mirrors codegen-ts's withManifestBatch, Python's manifest_batch and Java's
    // per-run save.
    private static readonly Dictionary<string, ManifestBatch> Batches = new(StringComparer.Ordinal);

    private static ManifestBatch? BatchFor(string genStateDir)
    {
        lock (Batches) return Batches.GetValueOrDefault(Path.GetFullPath(genStateDir));
    }

    /// <summary>
    /// Hold the manifest in memory until the returned handle is disposed, then write it at
    /// most once. A nested batch for the same directory joins the outer one. The write
    /// happens even when the run throws: every file recorded so far IS on disk, and dropping
    /// its record would make the next run refuse output it wrote itself. Call
    /// <see cref="BatchScope.Complete"/> when the run succeeds: a scope disposed without it is
    /// unwinding an exception, and a failed manifest write then must not replace that
    /// exception, so it is swallowed.
    /// </summary>
    public static BatchScope Batch(string? genStateDir)
    {
        if (genStateDir is null) return BatchScope.None;
        var key = Path.GetFullPath(genStateDir);
        lock (Batches)
        {
            if (Batches.ContainsKey(key)) return BatchScope.None;
            Batches[key] = new ManifestBatch(ReadFile(genStateDir));
        }
        return new BatchScope(genStateDir, key);
    }

    /// <summary>The handle <see cref="Batch"/> returns; disposing it writes the manifest.</summary>
    public sealed class BatchScope : IDisposable
    {
        internal static readonly BatchScope None = new(null, null);

        private readonly string? _genStateDir;
        private readonly string? _key;
        private bool _completed;
        private bool _disposed;

        internal BatchScope(string? genStateDir, string? key)
        {
            _genStateDir = genStateDir;
            _key = key;
        }

        /// <summary>Mark the run as finished normally, so a failed write is reported.</summary>
        public void Complete() => _completed = true;

        public void Dispose()
        {
            if (_disposed || _key is null || _genStateDir is null) return;
            _disposed = true;
            ManifestBatch batch;
            lock (Batches)
            {
                batch = Batches[_key];
                Batches.Remove(_key);
            }
            if (!batch.Dirty) return;
            if (_completed)
            {
                WriteFile(_genStateDir, batch.Raw);
                return;
            }
            try
            {
                WriteFile(_genStateDir, batch.Raw);
            }
            catch (Exception)
            {
                // The run is already unwinding an exception; that one is the cause to report.
            }
        }
    }

    private static Dictionary<string, JsonElement> ReadRaw(string genStateDir) =>
        BatchFor(genStateDir)?.Raw ?? ReadFile(genStateDir);

    private static Dictionary<string, JsonElement> ReadFile(string genStateDir)
    {
        var path = PathFor(genStateDir);
        if (!File.Exists(path)) return new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        try
        {
            var parsed = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(File.ReadAllText(path));
            return parsed is null
                ? new Dictionary<string, JsonElement>(StringComparer.Ordinal)
                : new Dictionary<string, JsonElement>(parsed, StringComparer.Ordinal);
        }
        catch (Exception e) when (e is JsonException or IOException or UnauthorizedAccessException)
        {
            return new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        }
    }

    private static string? EntryHash(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString(),
        JsonValueKind.Object when value.TryGetProperty("hash", out var h) && h.ValueKind == JsonValueKind.String
            => h.GetString(),
        _ => null,
    };

    /// <summary>Load the manifest; an absent or corrupt one reads as EMPTY, which fails
    /// closed (every file then refuses rather than being assumed ours). An object-valued
    /// entry written by another port reads as its <c>hash</c> field.</summary>
    public static Dictionary<string, string> Load(string genStateDir)
    {
        var hashes = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (key, value) in ReadRaw(genStateDir))
            if (EntryHash(value) is { } hash) hashes[key] = hash;
        return hashes;
    }

    /// <summary>Persist the manifest with SORTED keys.
    /// <para>
    /// Sorted because the file is committed: insertion order would make the diff — and
    /// any merge conflict between two people who both regenerated — depend on which
    /// generator happened to run first.
    /// </para>
    /// <para>
    /// An entry that is currently an object keeps its other fields; only its
    /// <c>hash</c> is replaced.
    /// </para></summary>
    public static void Save(string genStateDir, Dictionary<string, string> hashes)
    {
        var raw = ReadRaw(genStateDir);
        var next = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var (key, hash) in hashes)
        {
            if (raw.TryGetValue(key, out var existing) && existing.ValueKind == JsonValueKind.Object)
            {
                var entry = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var prop in existing.EnumerateObject()) entry[prop.Name] = prop.Value;
                entry["hash"] = hash;
                next[key] = JsonSerializer.SerializeToElement(entry);
            }
            else next[key] = JsonSerializer.SerializeToElement(hash);
        }
        if (BatchFor(genStateDir) is { } batch)
        {
            batch.Raw = next;
            batch.Dirty = true;
            return;
        }
        WriteFile(genStateDir, next);
    }

    private static void WriteFile(string genStateDir, Dictionary<string, JsonElement> raw)
    {
        Directory.CreateDirectory(genStateDir);
        var ordered = new SortedDictionary<string, JsonElement>(raw, StringComparer.Ordinal);
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
        var hash = ContentHash(content);
        var staleLegacy = legacyRelPath is not null
            && !string.Equals(legacyRelPath, relPath, StringComparison.Ordinal)
            && hashes.ContainsKey(legacyRelPath);
        // Already recorded exactly so: an unchanged file does not rewrite the manifest.
        if (!staleLegacy && hashes.TryGetValue(relPath, out var recorded) && recorded == hash) return;
        hashes[relPath] = hash;
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

    /// <summary>Whether we recorded writing <paramref name="relPath"/> at all, whatever it holds now.</summary>
    public static bool IsRecorded(string genStateDir, string relPath, string? legacyRelPath = null) =>
        Recorded(genStateDir, relPath, legacyRelPath) is not null;

    /// <summary>
    /// ADR-0064 — one run's view of the manifest: loaded ONCE, updated in memory, saved ONCE and
    /// only when an entry was added, changed or removed. A run that changes nothing leaves the
    /// file (and its timestamp) alone, and a run over N files no longer rewrites it N times.
    /// The bytes written are exactly <see cref="Save"/>'s.
    /// </summary>
    public sealed class Session
    {
        private readonly string _genStateDir;
        private readonly Dictionary<string, string> _hashes;
        private bool _dirty;

        public Session(string genStateDir)
        {
            _genStateDir = genStateDir;
            _hashes = Load(genStateDir);
        }

        /// <summary>The in-memory entries, for a reader that needs the whole set.</summary>
        public IReadOnlyDictionary<string, string> Entries => _hashes;

        /// <summary>Record that <paramref name="relPath"/> holds <paramref name="content"/>, dropping the legacy key.</summary>
        public void Record(string relPath, string content, string? legacyRelPath = null)
        {
            var hash = ContentHash(content);
            if (!_hashes.TryGetValue(relPath, out var prior) || prior != hash)
            {
                _hashes[relPath] = hash;
                _dirty = true;
            }
            if (legacyRelPath is not null && !string.Equals(legacyRelPath, relPath, StringComparison.Ordinal)
                && _hashes.Remove(legacyRelPath))
                _dirty = true;
        }

        private string? Recorded(string relPath, string? legacyRelPath)
        {
            if (_hashes.TryGetValue(relPath, out var recorded)) return recorded;
            if (legacyRelPath is not null && _hashes.TryGetValue(legacyRelPath, out var legacy)) return legacy;
            return null;
        }

        /// <summary>See <see cref="HashManifest.IsPristine"/>.</summary>
        public bool IsPristine(string relPath, string current, string? legacyRelPath = null) =>
            Recorded(relPath, legacyRelPath) == ContentHash(current);

        /// <summary>See <see cref="HashManifest.IsRecorded"/>.</summary>
        public bool IsRecorded(string relPath, string? legacyRelPath = null) =>
            Recorded(relPath, legacyRelPath) is not null;

        /// <summary>Write the manifest when something changed since it was loaded or last saved.</summary>
        public void Save()
        {
            if (!_dirty) return;
            HashManifest.Save(_genStateDir, _hashes);
            _dirty = false;
        }

        /// <summary>Re-read the manifest after something else (the orphan sweep) saved it.</summary>
        public void Reload()
        {
            _hashes.Clear();
            foreach (var (k, v) in Load(_genStateDir)) _hashes[k] = v;
            _dirty = false;
        }
    }
}
