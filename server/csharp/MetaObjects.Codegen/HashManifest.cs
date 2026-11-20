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
// ADR-0064 Amendment 1: the manifest is one file per model package under
// `.gen-state/.hashes/` (`.root.json` for paths in no package). The in-memory model stays
// flat (path -> entry); only load, save and exists know about the files.
//
// This file is meant to be COMMITTED. It is one hash per generated path — small and
// reviewable — where a full snapshot of previously-generated content would be a second
// copy of everything. A hash is already sufficient to answer the only question the
// write decision needs: is this file byte-for-byte what we wrote?

using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MetaObjects.Meta;

namespace MetaObjects.Codegen;

/// <summary>Reads and writes the per-path hash record of generated output.</summary>
public static class HashManifest
{
    private const string LegacyFileName = ".hashes.json";
    private const string DirName = ".hashes";
    private const string RootFileName = ".root.json";
    private const string IgnoreLine = "!.gen-state/.hashes/";
    private const string LegacyIgnoreLine = "!.gen-state/.hashes.json";

    private static string LegacyPath(string genStateDir) => Path.Combine(genStateDir, LegacyFileName);
    private static string DirPath(string genStateDir) => Path.Combine(genStateDir, DirName);

    /// <summary>A root-level model object: its name and effective package (<c>""</c> for none).</summary>
    public readonly record struct ManifestObject(string Name, string Package);

    /// <summary>The objects a run's placement rule reads: every root-level object of the loaded model.</summary>
    public static IReadOnlyList<ManifestObject> ObjectsOf(MetaRoot root) =>
        root.Objects().Select(o => new ManifestObject(o.Name, NamingRefs.EffectivePackageOf(o))).ToList();

    /// <summary>A package's manifest file name; <c>null</c> is the root manifest.</summary>
    public static string FileNameFor(string? package)
    {
        if (string.IsNullOrEmpty(package)) return RootFileName;
        var sb = new StringBuilder();
        var first = true;
        foreach (var segment in package.Split("::"))
        {
            if (!first) sb.Append('.');
            first = false;
            foreach (var b in Encoding.UTF8.GetBytes(segment))
            {
                var c = (char)b;
                if (b < 0x80 && (char.IsAsciiLetterOrDigit(c) || c is '_' or '-')) sb.Append(c);
                else sb.Append('%').Append(b.ToString("X2"));
            }
        }
        return sb.Append(".json").ToString();
    }

    /// <summary>
    /// The manifest file an entry is filed under (ADR-0064 Amendment 1 section 3): its
    /// <c>sourceNode</c> when it has one, else the object whose name the file's stem begins with.
    /// <c>null</c> when there is no model to ask and no <c>sourceNode</c>: the caller keeps the
    /// entry where it is.
    /// </summary>
    public static string? PlaceFile(string path, JsonElement? entry, IReadOnlyList<ManifestObject>? objects)
    {
        if (entry is { ValueKind: JsonValueKind.Object } e
            && e.TryGetProperty("sourceNode", out var sn) && sn.ValueKind == JsonValueKind.String
            && sn.GetString() is { Length: > 0 } node)
        {
            var dot = node.IndexOf('.');
            var qualified = dot < 0 ? node : node[..dot];
            var cut = qualified.LastIndexOf("::", StringComparison.Ordinal);
            return FileNameFor(cut < 0 ? null : qualified[..cut]);
        }
        if (objects is null) return null;
        var slash = path.LastIndexOfAny(['/', '\\']);
        var baseName = slash < 0 ? path : path[(slash + 1)..];
        var stemDot = baseName.IndexOf('.');
        var stem = stemDot < 0 ? baseName : baseName[..stemDot];
        var stemWords = Words(stem);
        var bestCount = 0;
        var packages = new HashSet<string>(StringComparer.Ordinal);
        foreach (var o in objects)
        {
            var words = Words(o.Name);
            if (words.Count == 0 || words.Count > stemWords.Count) continue;
            if (!words.SequenceEqual(stemWords.Take(words.Count), StringComparer.Ordinal)) continue;
            if (words.Count > bestCount) { bestCount = words.Count; packages.Clear(); }
            if (words.Count == bestCount) packages.Add(o.Package);
        }
        return packages.Count == 1 && packages.First().Length > 0 ? FileNameFor(packages.First()) : RootFileName;
    }

    // Lowercase words: split at '_' and '-', before an uppercase letter after a lowercase letter or digit, and
    // before the last capital of a run followed by a lowercase letter (HTTPServer -> http, server).
    private static List<string> Words(string name)
    {
        static bool Up(char c) => c is >= 'A' and <= 'Z';
        static bool Low(char c) => c is >= 'a' and <= 'z';
        static bool Dig(char c) => c is >= '0' and <= '9';
        var words = new List<string>();
        var cur = new StringBuilder();
        void Flush() { if (cur.Length > 0) { words.Add(cur.ToString()); cur.Clear(); } }
        for (var i = 0; i < name.Length; i++)
        {
            var c = name[i];
            if (c is '_' or '-') { Flush(); continue; }
            if (Up(c) && i > 0)
            {
                var prev = name[i - 1];
                if (Low(prev) || Dig(prev) || (Up(prev) && i + 1 < name.Length && Low(name[i + 1]))) Flush();
            }
            cur.Append(Up(c) ? (char)(c + 32) : c);
        }
        Flush();
        return words;
    }

    private sealed class Loaded
    {
        public Dictionary<string, JsonElement> Raw = new(StringComparer.Ordinal);
        /// <summary>The package file each entry was read from; absent for a legacy entry.</summary>
        public Dictionary<string, string> Origin = new(StringComparer.Ordinal);
        public bool LegacyPresent;
    }

    private static bool LegacyExists(string genStateDir) => File.Exists(LegacyPath(genStateDir));

    private static bool DirHasManifest(string genStateDir) =>
        Directory.Exists(DirPath(genStateDir)) && Directory.EnumerateFiles(DirPath(genStateDir), "*.json").Any();

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
        LegacyExists(genStateDir) || DirHasManifest(genStateDir) || (BatchFor(genStateDir)?.Dirty ?? false);

    /// <summary>Whether a pre-1.3.0 <c>.hashes.json</c> is still on disk: the next write run migrates it.</summary>
    public static bool HasLegacy(string genStateDir) => LegacyExists(genStateDir);

    private sealed class ManifestBatch(Loaded loaded, IReadOnlyList<ManifestObject>? objects)
    {
        public Dictionary<string, JsonElement> Raw = loaded.Raw;
        public readonly Dictionary<string, string> Origin = loaded.Origin;
        public readonly IReadOnlyList<ManifestObject>? Objects = objects;
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
    public static BatchScope Batch(string? genStateDir, IReadOnlyList<ManifestObject>? objects = null)
    {
        if (genStateDir is null) return BatchScope.None;
        var key = Path.GetFullPath(genStateDir);
        lock (Batches)
        {
            if (Batches.ContainsKey(key)) return BatchScope.None;
            Batches[key] = new ManifestBatch(ReadAll(genStateDir), objects);
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
                WriteAll(_genStateDir, batch.Raw, batch.Origin, batch.Objects);
                return;
            }
            try
            {
                WriteAll(_genStateDir, batch.Raw, batch.Origin, batch.Objects);
            }
            catch (Exception)
            {
                // The run is already unwinding an exception; that one is the cause to report.
            }
        }
    }

    private static Dictionary<string, JsonElement> ReadRaw(string genStateDir) =>
        BatchFor(genStateDir)?.Raw ?? ReadAll(genStateDir).Raw;

    private static Dictionary<string, JsonElement>? ReadOne(string path)
    {
        try
        {
            var parsed = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(File.ReadAllText(path));
            return parsed is null ? null : new Dictionary<string, JsonElement>(parsed, StringComparer.Ordinal);
        }
        catch (Exception e) when (e is JsonException or IOException or UnauthorizedAccessException)
        {
            return null; // an unreadable or corrupt file reads as empty: fails closed, replaced on the next write
        }
    }

    // The union: the legacy file underneath, then every file in .hashes/ in file-name order (a package file wins).
    private static Loaded ReadAll(string genStateDir)
    {
        var loaded = new Loaded { LegacyPresent = LegacyExists(genStateDir) };
        if (loaded.LegacyPresent && ReadOne(LegacyPath(genStateDir)) is { } legacy)
            foreach (var (k, v) in legacy) loaded.Raw[k] = v;
        if (Directory.Exists(DirPath(genStateDir)))
        {
            var names = Directory.EnumerateFiles(DirPath(genStateDir), "*.json")
                .Select(Path.GetFileName).OfType<string>().Order(StringComparer.Ordinal);
            foreach (var name in names)
            {
                if (ReadOne(Path.Combine(DirPath(genStateDir), name)) is not { } entries) continue;
                foreach (var (k, v) in entries) { loaded.Raw[k] = v; loaded.Origin[k] = name; }
            }
        }
        return loaded;
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
        WriteAll(genStateDir, next, ReadAll(genStateDir).Origin, null);
    }

    private static string TextOf(Dictionary<string, JsonElement> entries)
    {
        var ordered = new SortedDictionary<string, JsonElement>(entries, StringComparer.Ordinal);
        return JsonSerializer.Serialize(ordered, new JsonSerializerOptions { WriteIndented = true }) + "\n";
    }

    // Files every entry by the placement rule, writes ONLY the files whose bytes changed, deletes package files
    // left empty and the legacy file, keeps .root.json ({}) when no entry exists at all.
    private static void WriteAll(
        string genStateDir, Dictionary<string, JsonElement> raw, Dictionary<string, string> origin,
        IReadOnlyList<ManifestObject>? objects)
    {
        var files = new Dictionary<string, Dictionary<string, JsonElement>>(StringComparer.Ordinal);
        foreach (var (key, value) in raw)
        {
            var file = PlaceFile(key, value, objects)
                ?? (origin.TryGetValue(key, out var kept) ? kept : RootFileName);
            if (!files.TryGetValue(file, out var group)) files[file] = group = new(StringComparer.Ordinal);
            group[key] = value;
        }
        if (files.Count == 0) files[RootFileName] = new(StringComparer.Ordinal);

        var dir = DirPath(genStateDir);
        Directory.CreateDirectory(dir);
        foreach (var (name, entries) in files)
        {
            var path = Path.Combine(dir, name);
            var text = TextOf(entries);
            if (File.Exists(path) && File.ReadAllText(path) == text) continue;
            File.WriteAllText(path, text);
        }
        foreach (var existing in Directory.EnumerateFiles(dir, "*.json").ToList())
            if (!files.ContainsKey(Path.GetFileName(existing))) File.Delete(existing);
        if (LegacyExists(genStateDir)) File.Delete(LegacyPath(genStateDir));
        EnsureIgnoreLine(genStateDir);
    }

    // The scaffold's `.gen-state/*` rule would git-ignore the new directory, so add its negation after the legacy one.
    private static void EnsureIgnoreLine(string genStateDir)
    {
        var path = Path.GetFullPath(Path.Combine(genStateDir, "..", ".gitignore"));
        if (!File.Exists(path)) return;
        var text = File.ReadAllText(path);
        var lines = text.Split('\n').Select(l => l.TrimEnd('\r')).ToList();
        if (!lines.Contains(".gen-state/*") || lines.Contains(IgnoreLine)) return;
        var at = lines.IndexOf(LegacyIgnoreLine);
        if (at >= 0)
        {
            lines.Insert(at + 1, IgnoreLine);
            File.WriteAllText(path, string.Join("\n", lines));
        }
        else File.WriteAllText(path, text + (text.EndsWith('\n') || text.Length == 0 ? "" : "\n") + IgnoreLine + "\n");
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
            // A pre-1.3.0 manifest is migrated by the next write run even when nothing else changed.
            _dirty = LegacyExists(genStateDir);
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
