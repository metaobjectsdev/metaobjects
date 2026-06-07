// `dotnet meta agent-docs` — scaffold the slim MetaObjects Claude Code agent context
// for C#/.NET adopters, without Node.
//
// Resolves the stack from --server / --client (or defaults to a `csharp` server when a
// *.csproj is present in the output dir), assembles the consumer files against the
// bundled agent-context/ content tree (byte-identical to the TS/Java/Python references),
// and writes them into the output dir (cwd or --out):
//   - each new or manifest-unmodified file is written at its path;
//   - a hand-edited file's fresh contents go to <path>.new (the original is kept);
//   - the always-on import is appended to a root CLAUDE.md/AGENTS.md (idempotent;
//     CLAUDE.md created if neither exists);
//   - a sidecar manifest (.metaobjects/.agent-context.json) records each file's sha256
//     so re-runs detect hand-edits.

using System.Text;
using System.Text.Json;
using System.Text.Encodings.Web;
using MetaObjects.AgentContext;

namespace MetaObjects.Cli;

internal static class AgentDocsCommand
{
    private static readonly string[] RootDocCandidates = { "CLAUDE.md", "AGENTS.md" };
    private const string RootDocImportLine = "@.metaobjects/AGENTS.md";

    public static int Run(string[] rest)
    {
        var servers = new List<string>();
        var clients = new List<string>();
        string? outDir = null;

        for (var i = 0; i < rest.Length; i++)
        {
            var a = rest[i];
            if (a == "--server" && i + 1 < rest.Length) servers.Add(rest[++i]);
            else if (a == "--client" && i + 1 < rest.Length) clients.Add(rest[++i]);
            else if (a == "--out" && i + 1 < rest.Length) outDir = rest[++i];
            else if (a.StartsWith('-'))
            {
                Console.Error.WriteLine($"dotnet meta agent-docs: unknown option \"{a}\"");
                Console.Error.WriteLine("usage: dotnet meta agent-docs [--server <lang>]... [--client <fw>]... [--out <dir>]");
                return 2;
            }
            else
            {
                Console.Error.WriteLine($"dotnet meta agent-docs: unexpected argument \"{a}\"");
                return 2;
            }
        }

        var target = Path.GetFullPath(outDir ?? Directory.GetCurrentDirectory());

        // Detect a C# stack when nothing was specified and a *.csproj is present.
        if (servers.Count == 0 && clients.Count == 0)
        {
            if (Directory.Exists(target) && Directory.EnumerateFiles(target, "*.csproj").Any())
            {
                servers.Add("csharp");
            }
            else
            {
                Console.Error.WriteLine(
                    "dotnet meta agent-docs: no --server/--client given and no *.csproj found to " +
                    "detect a stack. Pass at least one --server or --client.");
                return 2;
            }
        }

        string contentRoot;
        try
        {
            contentRoot = ContentRoot.Resolve(target);
        }
        catch (DirectoryNotFoundException e)
        {
            Console.Error.WriteLine($"dotnet meta agent-docs: {e.Message}");
            return 1;
        }

        var stack = Stack.Of(servers, clients);
        var assembled = AgentContextAssembler.Assemble(contentRoot, stack);

        var manifestPath = Path.Combine(target, AgentContextScaffold.ManifestPath);
        var prior = ReadPriorManifest(manifestPath);

        var decision = AgentContextScaffold.Plan(stack, assembled, prior,
            rel => ReadCurrent(target, rel), AgentContextStalenessCheck.CurrentVersion());

        foreach (var w in decision.Writes)
        {
            WriteFile(Path.Combine(target, w.Path), w.Contents);
            Console.WriteLine($"  wrote {w.Path}");
        }
        foreach (var c in decision.Conflicts)
        {
            WriteFile(Path.Combine(target, c.NewPath), c.Contents);
            Console.WriteLine($"  hand-edited; wrote fresh copy to {c.NewPath} (kept your {c.Path})");
        }
        foreach (var rel in decision.Removed)
        {
            Console.WriteLine($"  note: {rel} no longer applies to this stack (not deleted)");
        }

        WriteManifest(manifestPath, decision.Manifest);

        var wired = WireRootDoc(target);
        if (wired is not null) Console.WriteLine($"  wired {RootDocImportLine} into {wired}");

        Console.WriteLine(
            $"dotnet meta agent-docs: scaffolded {assembled.Count} file(s) for stack " +
            $"[servers={string.Join(",", stack.Servers)}, clients={string.Join(",", stack.Clients)}] into {target}");
        return 0;
    }

    private static AgentContextScaffold.Manifest? ReadPriorManifest(string manifestPath)
    {
        if (!File.Exists(manifestPath)) return null;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(manifestPath));
            var root = doc.RootElement;
            var version = root.TryGetProperty("version", out var v) ? v.GetInt32() : 1;
            var generatedBy = root.TryGetProperty("generatedBy", out var g) ? g.GetString() : null;
            var files = new Dictionary<string, string>();
            if (root.TryGetProperty("files", out var f) && f.ValueKind == JsonValueKind.Object)
                foreach (var prop in f.EnumerateObject())
                    files[prop.Name] = prop.Value.GetString() ?? "";
            return new AgentContextScaffold.Manifest(version, generatedBy, JsonStrings(root, "servers"),
                JsonStrings(root, "clients"), files);
        }
        catch (JsonException)
        {
            // Corrupt sidecar → treat as a fresh scaffold.
            Console.Error.WriteLine($"  warning: ignoring corrupt manifest at {manifestPath}");
            return null;
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

    private static string? ReadCurrent(string outDir, string rel)
    {
        var p = Path.Combine(outDir, rel);
        return File.Exists(p) ? Encoding.UTF8.GetString(File.ReadAllBytes(p)) : null;
    }

    private static void WriteFile(string dest, string contents)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        File.WriteAllBytes(dest, Encoding.UTF8.GetBytes(contents));
    }

    private static void WriteManifest(string manifestPath, AgentContextScaffold.Manifest manifest)
    {
        var doc = new
        {
            version = manifest.Version,
            // Same JSON key as the TS/Java/Python references ("generatedBy") so a polyglot
            // repo can cross-read the stamp. The installed MetaObjects version, read from
            // the assembly — nudges a re-scaffold once the package moves ahead.
            generatedBy = manifest.GeneratedBy,
            servers = manifest.Servers,
            clients = manifest.Clients,
            files = manifest.Files,
        };
        // UnsafeRelaxedJsonEscaping keeps `& < > +` and non-ASCII unescaped, matching Java's
        // Gson `disableHtmlEscaping()` and TS/Python so the manifest is byte-consistent cross-port.
        var json = JsonSerializer.Serialize(doc, new JsonSerializerOptions
        {
            WriteIndented = true,
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        });
        Directory.CreateDirectory(Path.GetDirectoryName(manifestPath)!);
        File.WriteAllBytes(manifestPath, Encoding.UTF8.GetBytes(json + "\n"));
    }

    // Append @.metaobjects/AGENTS.md to the root CLAUDE.md/AGENTS.md. Idempotent — if the
    // import is already present in either doc, do nothing. If neither doc exists, create
    // CLAUDE.md with the import line. Returns the doc filename created/updated, or null.
    private static string? WireRootDoc(string outDir)
    {
        var existing = RootDocCandidates
            .Where(name => File.Exists(Path.Combine(outDir, name)))
            .ToList();

        foreach (var name in existing)
        {
            var text = Encoding.UTF8.GetString(File.ReadAllBytes(Path.Combine(outDir, name)));
            if (text.Contains(RootDocImportLine, StringComparison.Ordinal)) return null;
        }

        if (existing.Count > 0)
        {
            var name = existing[0];
            var target = Path.Combine(outDir, name);
            var text = Encoding.UTF8.GetString(File.ReadAllBytes(target));
            var sep = text.Length == 0 || text.EndsWith('\n') ? "" : "\n";
            File.WriteAllBytes(target, Encoding.UTF8.GetBytes(text + sep + RootDocImportLine + "\n"));
            return name;
        }

        var created = Path.Combine(outDir, "CLAUDE.md");
        File.WriteAllBytes(created, Encoding.UTF8.GetBytes(RootDocImportLine + "\n"));
        return "CLAUDE.md";
    }
}
