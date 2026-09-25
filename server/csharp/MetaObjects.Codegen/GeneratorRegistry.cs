// ADR-0021 D3 — stable-name generator registry (C# port of the TS reference
// server/typescript/packages/codegen-ts/src/generator-registry.ts).
//
// Generators are identified by a STABLE string id (e.g. `entity`, `routes`,
// `render-helper`) rather than by a language-specific class import / hardcoded
// suite. The id is the cross-port contract: the same logical generator carries
// the same stable name in every port. This is the discoverability + identity
// surface behind `dotnet meta gen --list`.
//
// It is the ONLY door. ADR-0034 Amendment 2 made codegen opt-in and DELETED the
// default suite this note used to name (GenCommand.DefaultGenerators): a run that
// selects no generator generates nothing and says so (GenCommand.NoGeneratorsSelected).
// So the registry powers `--list`, a stable identity, and the selection-by-name every
// run now goes through — including the once-unreachable generators (render-helper,
// extractor, output-prompt, filter-allowlist, template) — without changing what any
// generator EMITS.
//
// Stable names mirror the TS registry exactly where the concept matches
// (cross-port contract): entity, db-context, routes, output-parser, extractor,
// output-prompt, render-helper, filter-allowlist, template.

using MetaObjects.Codegen.Generators;
using MetaObjects.Meta;
using MetaObjects.Render;

namespace MetaObjects.Codegen;

/// <summary>Tier of a registered generator (ADR-0020 / ADR-0021 D1).</summary>
public enum GeneratorTier
{
    /// <summary>Recommended Tier-1 `gen` suite (idiomatic emission).</summary>
    Native,
    /// <summary>Tier-2 artifact owned by the neutral docs engine.</summary>
    Neutral,
}

/// <summary>
/// The six layers a generator can belong to — the axis an adopter SELECTS BY, gated
/// cross-port against <c>fixtures/generator-registry-conformance/registry.json</c>
/// exactly as <see cref="GeneratorTier"/> is.
/// </summary>
/// <remarks>
/// Six, not ten. An earlier draft split <c>Capability</c> four ways, each with ONE
/// member — a layer with one member does no grouping work. The first four layers are
/// app-shape decisions a builder makes; <c>Capability</c> holds the ones the MODEL has
/// already made (you declared a <c>template.prompt</c>), which is why they are found by
/// probing a real model rather than by browsing a taxonomy.
/// </remarks>
public enum GeneratorLayer
{
    /// <summary>Entity/DTO/value-object modules and the constants beside them.</summary>
    Model,
    /// <summary>Query helpers, DbContext, repositories, table objects.</summary>
    Persistence,
    /// <summary>HTTP surface: routes, filter allowlists, validators, wiring.</summary>
    Api,
    /// <summary>Browser tier: forms, hooks, grids.</summary>
    Client,
    /// <summary>Documentation artifacts (on by default; owned by the docs door).</summary>
    Docs,
    /// <summary>Chosen by the model, not by browsing — prompts, parsers, payloads, traces.</summary>
    Capability,
}

/// <summary>
/// Extra inputs a factory may need to construct a generator. Today only the
/// on-disk template root (required by <c>render-helper</c>'s build-time drift
/// gate and the <c>template</c> primitive). Optional so <c>--list</c> can
/// construct every entry without supplying one (factories must never throw).
/// </summary>
public sealed record GeneratorBuildContext(string? TemplateRoot = null);

/// <summary>One registry entry: stable id + description + tier + factory.</summary>
public sealed record GeneratorRegistryEntry
{
    /// <summary>Stable, cross-port-consistent id. Equals the registry map key.</summary>
    public required string Name { get; init; }
    /// <summary>One-line (no newline) human description for <c>--list</c>.</summary>
    public required string Description { get; init; }
    /// <summary>Native = recommended `gen` suite; Neutral = `docs`-owned.</summary>
    public required GeneratorTier Tier { get; init; }
    /// <summary>The selection axis — see <see cref="GeneratorLayer"/>. Gated cross-port.</summary>
    public required GeneratorLayer Layer { get; init; }
    /// <summary>
    /// Constructs the generator with sensible defaults. Calling it (even with an
    /// empty <see cref="GeneratorBuildContext"/>) must NOT throw — <c>--list</c>
    /// relies on that.
    /// </summary>
    public required Func<GeneratorBuildContext, IGenerator> Factory { get; init; }
    /// <summary>Optional one-line options summary for <c>--list</c>.</summary>
    public string? Options { get; init; }
    /// <summary>Optional note — e.g. pointing neutral entries at their door.</summary>
    public string? Note { get; init; }
    /// <summary>
    /// The <c>Generators/&lt;file&gt;</c> source file <c>dotnet meta eject</c> copies for
    /// this entry (ADR-0034 Amendment 3) — also its embedded-resource file name (see
    /// <c>MetaObjects.Codegen.csproj</c>'s <c>EmbeddedResource</c> item group) and the
    /// name the copy is written under in the adopter's <c>codegen/generators/</c>.
    /// <c>null</c> = not ejectable. Only the <c>template</c> primitive has no source of
    /// its own to own — every other Native entry names its file here.
    /// </summary>
    public string? SourceFileName { get; init; }
    /// <summary>
    /// Stable names of the generators whose output this one's output references. A run
    /// that selects this entry without them gets a warning from <c>gen</c> (see
    /// <see cref="GeneratorRegistry.UnsatisfiedRequires"/>) and <c>--list</c> shows them.
    /// Advisory, never an error: an adopter may keep a hand-written file at that path.
    /// </summary>
    public IReadOnlyList<string> Requires { get; init; } = [];
}

/// <summary>
/// The stable-name generator registry. Registers every C# generator that exists
/// so all are discoverable (<c>--list</c>) and selectable by stable name.
/// </summary>
public static class GeneratorRegistry
{
    // The `template` generator is a PRIMITIVE: real use supplies name/walk/template
    // via config. For registry identity + `--list` we construct a benign no-op
    // instance so the factory yields a valid IGenerator without throwing — mirrors
    // the TS templatePrimitive().
    private static IGenerator TemplatePrimitive(GeneratorBuildContext _) =>
        TemplateGenerator.Create(
            name: "template",
            template: string.Empty,
            walk: (MetaRoot _) => Enumerable.Empty<TemplateWalkResult>(),
            provider: new InMemoryProvider(new Dictionary<string, string>()));

    // render-helper requires an on-disk template root for its build-time drift
    // gate. For `--list` (no root) we hand it a harmless temp dir so construction
    // never throws; real selection passes --template-root.
    private static IGenerator RenderHelper(GeneratorBuildContext ctx) =>
        new RenderHelperGenerator(
            string.IsNullOrEmpty(ctx.TemplateRoot) ? Path.GetTempPath() : ctx.TemplateRoot);

    /// <summary>Stable-name → entry. Insertion order is the default-suite order.</summary>
    public static readonly IReadOnlyDictionary<string, GeneratorRegistryEntry> Entries =
        new Dictionary<string, GeneratorRegistryEntry>(StringComparer.Ordinal)
        {
            ["entity"] = new()
            {
                Name = "entity",
                Description = "Per-entity EF Core entity class (the entity module).",
                Tier = GeneratorTier.Native,
                Layer = GeneratorLayer.Model,
                Factory = _ => new EntityGenerator(),
                SourceFileName = "EntityGenerator.cs",
            },
            ["db-context"] = new()
            {
                Name = "db-context",
                Description = "Single EF Core DbContext binding every generated entity.",
                Tier = GeneratorTier.Native,
                Layer = GeneratorLayer.Persistence,
                Factory = _ => new DbContextGenerator(),
                SourceFileName = "DbContextGenerator.cs",
                // DbSet<Entity> for every entity class EntityGenerator emits.
                Requires = ["entity"],
            },
            ["routes"] = new()
            {
                Name = "routes",
                Description = "Per-entity ASP.NET Core CRUD route handlers.",
                Tier = GeneratorTier.Native,
                Layer = GeneratorLayer.Api,
                Factory = _ => new RoutesGenerator(),
                SourceFileName = "RoutesGenerator.cs",
                // The handlers take AppDbContext, read <Entity>FilterAllowlist and bind the
                // entity classes; without any of the three the output does not compile.
                Requires = ["entity", "db-context", "filter-allowlist"],
            },
            ["output-parser"] = new()
            {
                Name = "output-parser",
                Description = "Per-template tolerant output parser (recover-on-receipt).",
                Tier = GeneratorTier.Native,
                Layer = GeneratorLayer.Capability,
                Factory = _ => new OutputParserGenerator(),
                Note = "Needs `entity` in the same run: it references each value object's own POCO (ADR-0056).",
                SourceFileName = "OutputParserGenerator.cs",
                // ADR-0056: the value object's own POCO, which EntityGenerator emits.
                Requires = ["entity"],
            },
            ["extractor"] = new()
            {
                Name = "extractor",
                Description = "Per-template typed Extract<Name> helper (strict payload extraction).",
                Tier = GeneratorTier.Native,
                Layer = GeneratorLayer.Capability,
                Factory = _ => new ExtractorGenerator(),
                Note = "Needs `entity` in the same run: it references each value object's own POCO (ADR-0056).",
                SourceFileName = "ExtractorGenerator.cs",
                // ADR-0056: the value object's own POCO, which EntityGenerator emits.
                Requires = ["entity"],
            },
            ["output-prompt"] = new()
            {
                Name = "output-prompt",
                Description = "Per-template output-format prompt fragment generator.",
                Tier = GeneratorTier.Native,
                Layer = GeneratorLayer.Capability,
                Factory = _ => new OutputPromptGenerator(),
                SourceFileName = "OutputPromptGenerator.cs",
            },
            ["render-helper"] = new()
            {
                Name = "render-helper",
                Description = "Per-renderable-template render helper (typed wrappers; document/email for a template.output, the document shape for a template.prompt).",
                Tier = GeneratorTier.Native,
                Layer = GeneratorLayer.Capability,
                Factory = RenderHelper,
                Options = "template-root (required when selected)",
                Note = "Needs `entity` in the same run: it references each value object's own POCO (ADR-0056).",
                SourceFileName = "RenderHelperGenerator.cs",
                // ADR-0056: the value object's own POCO, which EntityGenerator emits.
                Requires = ["entity"],
            },
            ["filter-allowlist"] = new()
            {
                Name = "filter-allowlist",
                Description = "Per-entity REST filter allowlist (queryable-field guard).",
                Tier = GeneratorTier.Native,
                Layer = GeneratorLayer.Api,
                Factory = _ => new FilterAllowlistGenerator(),
                SourceFileName = "FilterAllowlistGenerator.cs",
            },
            ["names"] = new()
            {
                Name = "names",
                Description = "Per-object physical database name constants (table/view name, schema, columns).",
                Tier = GeneratorTier.Native,
                Layer = GeneratorLayer.Model,
                Factory = _ => new NamesGenerator(),
                SourceFileName = "NamesGenerator.cs",
            },
            ["template"] = new()
            {
                Name = "template",
                Description = "Generic Mustache template primitive (walk + template -> files).",
                Tier = GeneratorTier.Native,
                Layer = GeneratorLayer.Capability,
                Factory = TemplatePrimitive,
                Options = "name, walk, template, format? (config-only)",
            },
            // FR-015 — per-entity typed EF Core calling method for a callable source
            // (storedProc / tableFunction). Same stable name as the TS callable
            // generator (cross-port contract).
            ["callable"] = new()
            {
                Name = "callable",
                Description = "Per-entity callable wrapper (storedProc / tableFunction FromSqlInterpolated method).",
                Tier = GeneratorTier.Native,
                Layer = GeneratorLayer.Capability,
                Factory = _ => new CallableGenerator(),
                SourceFileName = "CallableGenerator.cs",
            },
        };

    /// <summary>All entries, native first then neutral, alphabetical within tier.</summary>
    public static IReadOnlyList<GeneratorRegistryEntry> List()
    {
        var all = Entries.Values;
        return
        [
            .. all.Where(e => e.Tier == GeneratorTier.Native).OrderBy(e => e.Name, StringComparer.Ordinal),
            .. all.Where(e => e.Tier == GeneratorTier.Neutral).OrderBy(e => e.Name, StringComparer.Ordinal),
        ];
    }

    /// <summary>Resolve an entry by stable id, or null if unknown.</summary>
    public static GeneratorRegistryEntry? Get(string id) =>
        Entries.TryGetValue(id, out var e) ? e : null;

    /// <summary>
    /// C1 — the ONE place that decides <see cref="GenConfig.IncludeNames"/> from a
    /// resolved generator-name selection: true iff the stable id <c>"names"</c>
    /// (<see cref="Generators.NamesGenerator"/>'s <c>Name</c>) is among <paramref
    /// name="names"/>. Every caller that resolves a generator suite AND builds a
    /// <see cref="GenConfig"/> from it (<c>GenCommand.Run</c>, <c>VerifyCommand</c>'s
    /// codegen-drift gate) must compute <c>IncludeNames</c> through this method rather
    /// than re-deriving it, or the two commands could disagree about whether a given
    /// run's <c>&lt;Entity&gt;Names.g.cs</c> actually exists — the same class of bug
    /// this method exists to close, at a second site.
    /// </summary>
    public static bool IncludesNames(IReadOnlyList<string> names) =>
        names.Contains("names", StringComparer.Ordinal);

    /// <summary>
    /// Build the generators for the given stable names, in the order requested.
    /// Throws <see cref="ArgumentException"/> naming the first unknown id.
    /// </summary>
    /// <summary>
    /// One warning per selected generator whose <see cref="GeneratorRegistryEntry.Requires"/>
    /// are not all selected too. Advisory, never an error. Mirrors TS
    /// <c>warnUnsatisfiedRequires</c> and Python <c>unsatisfied_requires</c>.
    /// </summary>
    public static IReadOnlyList<string> UnsatisfiedRequires(IReadOnlyList<string> names)
    {
        var selected = new HashSet<string>(names, StringComparer.Ordinal);
        var warnings = new List<string>();
        foreach (var name in names)
        {
            var entry = Get(name);
            if (entry is null) continue;
            var missing = entry.Requires.Where(d => !selected.Contains(d)).ToList();
            if (missing.Count == 0) continue;
            var listed = string.Join(", ", missing.Select(m => $"\"{m}\""));
            warnings.Add(
                $"\"{name}\" is selected but {listed} {(missing.Count == 1 ? "is" : "are")} not. " +
                $"The code \"{name}\" emits references what {listed} would have emitted, so it " +
                $"will not compile. Add {listed} to --generators, or keep your own hand-written " +
                "files at those paths.");
        }
        return warnings;
    }

    public static IReadOnlyList<IGenerator> Resolve(IEnumerable<string> names, GeneratorBuildContext? ctx = null)
    {
        var build = ctx ?? new GeneratorBuildContext();
        var result = new List<IGenerator>();
        foreach (var name in names)
        {
            var entry = Get(name)
                ?? throw new ArgumentException(
                    $"unknown generator \"{name}\". Run `dotnet meta gen --list` for the available stable names.",
                    nameof(names));
            result.Add(entry.Factory(build));
        }
        return result;
    }
}
