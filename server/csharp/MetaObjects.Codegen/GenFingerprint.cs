// ADR-0062 — the key of a whole `gen` run and the skip decision built on it.
//
// The key has two halves, both computed AFTER the metadata loads and BEFORE any generator renders
// (this runs in the codegen project's process, where the generator list is built):
//
//   model     the hash of the LOADED model (ModelHash): never of the metadata source files, so a
//             reformatted or re-split file that loads to the same model does not change it
//   identity  one key over small named entries (kind, name, sha-256) describing what generates:
//               engine        the built code of MetaObjects, MetaObjects.Render, MetaObjects.Codegen
//                             and the codegen project's own assembly (owned generators compiled in),
//                             plus the content of every project the codegen project references by
//                             path (a linked or source checkout of the engine)
//               generator     every source file of the codegen project (declared list, options, owned
//                             generators, csproj), bin/ and obj/ aside
//               build-config  Directory.Build.props, Directory.Packages.props, global.json,
//                             nuget.config above it
//               config        every file under the project's `.metaobjects/` (config.json, dependency
//                             lock and snapshots), `.gen-state` aside
//               flag          the output-changing flags: --out, --namespace, --generators,
//                             --template-root, --template-spec, --emit-abstract-shapes, --strict, baseline
//               template      every file under prompts/, templates/, --template-root, and the template spec
//               extra         every path a generator declared in IGenerator.ExtraInputs
//               format        this format's version
//
// Every identity input is computable in the codegen process, which is where the decision runs, so
// nothing is stored beside the two hashes. The key may be wrong only in the safe direction:
// anything in doubt is counted. Timestamps are never an input.

using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MetaObjects.Codegen;

public static class GenFingerprint
{
    /// <summary>Bumped when an entry kind is added or its meaning changes, so an old file never matches.</summary>
    public const int FormatVersion = 3;

    /// <summary>The stored key's file name inside <c>.metaobjects/.gen-state/</c>. One per port.</summary>
    public const string FileName = ".fingerprint-csharp.json";

    /// <summary>One named input: what kind it is, which one, and the SHA-256 of its content.</summary>
    public sealed record Entry(string Kind, string Name, string Sha256);

    /// <summary>The flags that change what gen writes. <c>--force</c> and <c>--full</c> are not among them.</summary>
    public sealed record Options
    {
        public string? OutDir { get; init; }
        public string? Namespace { get; init; }
        public string? Generators { get; init; }
        public string? TemplateRoot { get; init; }
        public string? TemplateSpec { get; init; }
        public bool EmitAbstractShapes { get; init; }
        public bool Strict { get; init; }
        public string Baseline { get; init; } = "default";
    }

    // ------------------------------------------------------------------ hashing

    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static string Sha(string text) => Sha(Encoding.UTF8.GetBytes(text));

    private static string Rel(string projectRoot, string full)
    {
        var rel = Path.GetRelativePath(Path.GetFullPath(projectRoot), Path.GetFullPath(full));
        return (rel.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(rel) ? Path.GetFullPath(full) : rel)
            .Replace(Path.DirectorySeparatorChar, '/');
    }

    private static bool InSkippedDir(string path, params string[] names) =>
        path.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Any(s => names.Contains(s));

    private static IEnumerable<string> FilesUnder(string dir, params string[] skipDirNames)
    {
        if (!Directory.Exists(dir)) return [];
        return Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)
            .Where(f => !InSkippedDir(Path.GetRelativePath(dir, f), skipDirNames))
            .OrderBy(f => f, StringComparer.Ordinal);
    }

    private static IEnumerable<Entry> FileEntries(string kind, string projectRoot, IEnumerable<string> files)
    {
        foreach (var f in files)
        {
            string sha;
            try { sha = Sha(File.ReadAllBytes(f)); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { sha = "unreadable"; }
            yield return new Entry(kind, Rel(projectRoot, f), sha);
        }
    }

    /// <summary>The fold of a set of entries into one key: sha-256 over their sorted lines.</summary>
    public static string Key(IEnumerable<Entry> entries) =>
        Sha(string.Join("\n", entries.Select(e => $"{e.Kind}\t{e.Name}\t{e.Sha256}").Order(StringComparer.Ordinal)));

    // ------------------------------------------------------------------ the identity

    private static readonly Regex ProjectRef = new(
        "<ProjectReference\\s+Include=\"([^\"]+)\"", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly string[] BuildConfigFiles =
        ["Directory.Build.props", "Directory.Build.targets", "Directory.Packages.props", "global.json", "nuget.config", "NuGet.Config"];

    private static bool IsRepoRoot(DirectoryInfo dir) =>
        Directory.Exists(Path.Combine(dir.FullName, ".git")) || File.Exists(Path.Combine(dir.FullName, ".git"));

    /// <summary>The built code that generates: the engine assemblies and the codegen project's own.</summary>
    private static IEnumerable<string> BuiltAssemblies()
    {
        var assemblies = new[]
        {
            typeof(GenFingerprint).Assembly, typeof(MetaObjects.Meta.MetaRoot).Assembly,
            typeof(MetaObjects.Render.RenderException).Assembly, Assembly.GetEntryAssembly(),
        };
        return assemblies.Where(a => a is not null).Select(a => a!.Location)
            .Where(l => l.Length > 0 && File.Exists(l)).Distinct();
    }

    private static IEnumerable<Entry> EngineEntries(string projectRoot)
    {
        foreach (var e in FileEntries("engine", projectRoot, BuiltAssemblies().Order(StringComparer.Ordinal)))
            yield return e;

        // A project the codegen project references by path is a linked or source checkout of the
        // engine: its content is part of the identity, so it changes when its source does.
        var codegen = Path.Combine(projectRoot, "codegen");
        var visited = new HashSet<string>(StringComparer.Ordinal);
        var queue = new Queue<string>(Directory.Exists(codegen)
            ? Directory.EnumerateFiles(codegen, "*.csproj", SearchOption.AllDirectories)
                .Where(f => !InSkippedDir(Path.GetRelativePath(codegen, f), "bin", "obj"))
            : []);
        while (queue.Count > 0)
        {
            var csproj = queue.Dequeue();
            string text;
            try { text = File.ReadAllText(csproj); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { continue; }
            foreach (Match m in ProjectRef.Matches(text))
            {
                var target = Path.GetFullPath(Path.Combine(
                    Path.GetDirectoryName(csproj)!, m.Groups[1].Value.Replace('\\', Path.DirectorySeparatorChar)));
                if (!File.Exists(target) || !visited.Add(target)) continue;
                foreach (var e in FileEntries("engine-source", projectRoot,
                             FilesUnder(Path.GetDirectoryName(target)!, "bin", "obj", ".git", "node_modules")))
                    yield return e;
                queue.Enqueue(target);
            }
        }
    }

    /// <summary>The named entries of what generates: everything of a run except the model.</summary>
    public static IReadOnlyList<Entry> IdentityEntries(
        string projectRoot, string cwd, Options o, IEnumerable<string> extras)
    {
        var entries = new List<Entry> { new("format", "fingerprint", Sha(FormatVersion.ToString())) };

        void Flag(string name, string? value) => entries.Add(new Entry("flag", name, Sha(value ?? "")));
        Flag("out", o.OutDir is null ? null : Path.GetFullPath(Path.Combine(cwd, o.OutDir)));
        Flag("namespace", o.Namespace);
        Flag("generators", o.Generators);
        Flag("template-root", o.TemplateRoot is null ? null : Path.GetFullPath(Path.Combine(cwd, o.TemplateRoot)));
        Flag("template-spec", o.TemplateSpec is null ? null : Path.GetFullPath(Path.Combine(cwd, o.TemplateSpec)));
        Flag("emit-abstract-shapes", o.EmitAbstractShapes ? "true" : "false");
        Flag("strict", o.Strict ? "true" : "false");
        Flag("baseline", o.Baseline);

        // The project's own config: the nearest `.metaobjects/` at or above the project.
        for (var dir = new DirectoryInfo(Path.GetFullPath(projectRoot)); dir is not null; dir = dir.Parent)
        {
            var cfgDir = Path.Combine(dir.FullName, ".metaobjects");
            if (File.Exists(Path.Combine(cfgDir, "config.json")))
            {
                entries.AddRange(FileEntries("config", projectRoot, FilesUnder(cfgDir, ".gen-state")));
                break;
            }
            if (IsRepoRoot(dir)) break;
        }

        entries.AddRange(EngineEntries(projectRoot));
        entries.AddRange(FileEntries("generator", projectRoot,
            FilesUnder(Path.Combine(projectRoot, "codegen"), "bin", "obj")));
        for (var dir = new DirectoryInfo(Path.GetFullPath(projectRoot)); dir is not null; dir = dir.Parent)
        {
            foreach (var name in BuildConfigFiles)
            {
                var f = Path.Combine(dir.FullName, name);
                if (File.Exists(f)) entries.AddRange(FileEntries("build-config", projectRoot, [f]));
            }
            if (IsRepoRoot(dir)) break;
        }

        var templateDirs = new List<string>
        {
            Path.Combine(cwd, CodegenCli.DefaultPromptsDir), Path.Combine(cwd, CodegenCli.LegacyTemplatesDir),
        };
        if (o.TemplateRoot is not null) templateDirs.Add(Path.GetFullPath(Path.Combine(cwd, o.TemplateRoot)));
        foreach (var d in templateDirs.Select(Path.GetFullPath).Distinct())
            entries.AddRange(FileEntries("template", projectRoot, FilesUnder(d)));
        var specPath = o.TemplateSpec is not null
            ? Path.GetFullPath(Path.Combine(cwd, o.TemplateSpec))
            : Path.Combine(projectRoot, CodegenCli.TemplateSpecFileName);
        if (File.Exists(specPath)) entries.AddRange(FileEntries("template", projectRoot, [specPath]));

        foreach (var extra in extras.Distinct(StringComparer.Ordinal))
        {
            var full = Path.GetFullPath(Path.Combine(cwd, extra));
            if (Directory.Exists(full)) entries.AddRange(FileEntries("extra", projectRoot, FilesUnder(full)));
            else if (File.Exists(full)) entries.AddRange(FileEntries("extra", projectRoot, [full]));
            else entries.Add(new Entry("extra", Rel(projectRoot, full), "missing"));
        }
        return entries;
    }

    // ------------------------------------------------------------------ the stored key

    /// <summary>The two halves a successful run stored.</summary>
    public sealed record Stored(
        string Model, string Identity, IReadOnlyDictionary<string, string> Outputs, IReadOnlyList<string> Untracked);

    private static string GenStateDir(string projectRoot) => Path.Combine(projectRoot, ".metaobjects", ".gen-state");
    private static string PathFor(string projectRoot) => Path.Combine(GenStateDir(projectRoot), FileName);

    public static Stored? Read(string projectRoot)
    {
        try
        {
            if (!File.Exists(PathFor(projectRoot))) return null;
            using var doc = JsonDocument.Parse(File.ReadAllText(PathFor(projectRoot)));
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("format", out var f) || f.ValueKind != JsonValueKind.Number || f.GetInt32() != FormatVersion
                || !root.TryGetProperty("model", out var m) || m.ValueKind != JsonValueKind.String
                || !root.TryGetProperty("identity", out var i) || i.ValueKind != JsonValueKind.String
                || !root.TryGetProperty("outputs", out var o) || o.ValueKind != JsonValueKind.Object) return null;
            var outputs = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var prop in o.EnumerateObject())
            {
                if (prop.Value.ValueKind != JsonValueKind.String) return null;
                outputs[prop.Name] = prop.Value.GetString()!;
            }
            var untracked = new List<string>();
            if (root.TryGetProperty("untracked", out var u))
            {
                if (u.ValueKind != JsonValueKind.Array) return null;
                foreach (var item in u.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.String) return null;
                    untracked.Add(item.GetString()!);
                }
            }
            return new Stored(m.GetString()!, i.GetString()!, outputs, untracked);
        }
        catch (Exception e) when (e is JsonException or IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>Forget the stored key: a real run does this before it writes anything.</summary>
    public static void Delete(string projectRoot)
    {
        try { File.Delete(PathFor(projectRoot)); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }

    /// <summary>Store the key of a fully successful run.</summary>
    /// <remarks>
    /// Amendment A: also records <c>outputs</c>, the hash of every manifest-recorded file as the run
    /// left it on disk. When a recorded file is missing no key is stored at all.
    /// </remarks>
    public static void Write(
        string projectRoot, string model, string identity, IEnumerable<string>? untracked = null)
    {
        var outputs = new SortedDictionary<string, string>(StringComparer.Ordinal);
        if (ManifestOf(projectRoot) is { } manifest)
            foreach (var key in manifest.Keys)
            {
                var hash = DiskHash(projectRoot, key);
                if (hash is null) return;
                outputs[key] = hash;
            }
        Directory.CreateDirectory(GenStateDir(projectRoot));
        var json = JsonSerializer.Serialize(
            new
            {
                format = FormatVersion, model, identity, outputs,
                untracked = (untracked ?? []).Order(StringComparer.Ordinal).ToArray(),
            }, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(PathFor(projectRoot), json + "\n");
    }

    private static string? DiskHash(string projectRoot, string key)
    {
        var path = Path.Combine(projectRoot, key);
        try { return File.Exists(path) ? HashManifest.ContentHash(File.ReadAllText(path)) : null; }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return null; }
    }

    // ------------------------------------------------------------------ the decisions

    private static Dictionary<string, string>? ManifestOf(string projectRoot) =>
        HashManifest.Exists(GenStateDir(projectRoot)) ? HashManifest.Load(GenStateDir(projectRoot)) : null;

    private static bool MatchesStored(string projectRoot, string model, string identity) =>
        Read(projectRoot) is { } s && s.Model == model && s.Identity == identity;

    /// <summary>Whether <c>gen</c> may skip rendering: the model and identity match the stored key and
    /// every file the manifest records still hashes to the value the stored run left. The caller has ruled out <c>--force</c>.</summary>
    public static bool CanSkipGen(string projectRoot, string model, string identity)
    {
        if (!MatchesStored(projectRoot, model, identity)) return false;
        if (ManifestOf(projectRoot) is not { } manifest) return false;
        // Amendment A: every recorded file must still be what the stored run left. A missing entry is a mismatch.
        var stored = Read(projectRoot)!;
        return manifest.Keys.All(k => stored.Outputs.TryGetValue(k, out var h) && DiskHash(projectRoot, k) == h)
            && stored.Untracked.All(File.Exists);
    }

    /// <summary>Whether the <c>CI</c> environment variable says this is a CI run.</summary>
    public static bool InCi(Func<string, string?>? getenv = null)
    {
        var v = (getenv ?? Environment.GetEnvironmentVariable)("CI");
        return !string.IsNullOrEmpty(v) && !v.Equals("0", StringComparison.Ordinal)
            && !v.Equals("false", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Whether a LOCAL <c>verify --codegen</c> may answer "no drift" without rendering: not CI, not
    /// <c>--full</c>, the stored key matches, and every manifest file still hashes to its record.
    /// </summary>
    public static bool MayAnswerNoDrift(
        string projectRoot, string model, string identity, bool full, Func<string, string?>? getenv = null)
    {
        if (full || InCi(getenv)) return false;
        if (!MatchesStored(projectRoot, model, identity)) return false;
        if (ManifestOf(projectRoot) is not { } manifest) return false;
        if (!Read(projectRoot)!.Untracked.All(File.Exists)) return false;
        foreach (var (key, recorded) in manifest)
        {
            var path = Path.Combine(projectRoot, key);
            try
            {
                if (!File.Exists(path) || HashManifest.ContentHash(File.ReadAllText(path)) != recorded) return false;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return false; }
        }
        return true;
    }
}
