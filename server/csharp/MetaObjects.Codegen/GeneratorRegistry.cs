// ADR-0021 D3 — stable-name generator registry (C# port of the TS reference
// server/typescript/packages/codegen-ts/src/generator-registry.ts).
//
// Generators are identified by a STABLE string id (e.g. `entity`, `routes`,
// `render-helper`) rather than by a language-specific class import / hardcoded
// suite. The id is the cross-port contract: the same logical generator carries
// the same stable name in every port. This is the discoverability + identity
// surface behind `dotnet meta gen --list`.
//
// It is ADDITIVE. The existing default suite (GenCommand.DefaultGenerators)
// keeps the same four generators by default — the registry powers `--list`,
// a stable identity, and selection-by-name so the previously-unreachable
// generators (render-helper, extractor, output-prompt, filter-allowlist,
// template) become runnable from the CLI without changing what any generator
// EMITS.
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
                Factory = _ => new EntityGenerator(),
            },
            ["db-context"] = new()
            {
                Name = "db-context",
                Description = "Single EF Core DbContext binding every generated entity.",
                Tier = GeneratorTier.Native,
                Factory = _ => new DbContextGenerator(),
            },
            ["routes"] = new()
            {
                Name = "routes",
                Description = "Per-entity ASP.NET Core CRUD route handlers.",
                Tier = GeneratorTier.Native,
                Factory = _ => new RoutesGenerator(),
            },
            ["payload"] = new()
            {
                Name = "payload",
                Description = "Per-template strict typed payload record(s) (the prompt/parser/extractor bind type).",
                Tier = GeneratorTier.Native,
                Factory = _ => new PayloadGenerator(),
            },
            ["output-parser"] = new()
            {
                Name = "output-parser",
                Description = "Per-template tolerant output parser (recover-on-receipt).",
                Tier = GeneratorTier.Native,
                Factory = _ => new OutputParserGenerator(),
            },
            ["extractor"] = new()
            {
                Name = "extractor",
                Description = "Per-template typed Extract<Name> helper (strict payload extraction).",
                Tier = GeneratorTier.Native,
                Factory = _ => new ExtractorGenerator(),
            },
            ["output-prompt"] = new()
            {
                Name = "output-prompt",
                Description = "Per-template output-format prompt fragment generator.",
                Tier = GeneratorTier.Native,
                Factory = _ => new OutputPromptGenerator(),
            },
            ["render-helper"] = new()
            {
                Name = "render-helper",
                Description = "Per-template.output render helper (document/email typed wrappers).",
                Tier = GeneratorTier.Native,
                Factory = RenderHelper,
                Options = "template-root (required when selected)",
            },
            ["filter-allowlist"] = new()
            {
                Name = "filter-allowlist",
                Description = "Per-entity REST filter allowlist (queryable-field guard).",
                Tier = GeneratorTier.Native,
                Factory = _ => new FilterAllowlistGenerator(),
            },
            ["names"] = new()
            {
                Name = "names",
                Description = "Per-object physical database name constants (table/view name, schema, columns).",
                Tier = GeneratorTier.Native,
                Factory = _ => new NamesGenerator(),
            },
            ["template"] = new()
            {
                Name = "template",
                Description = "Generic Mustache template primitive (walk + template -> files).",
                Tier = GeneratorTier.Native,
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
                Factory = _ => new CallableGenerator(),
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
    /// Build the generators for the given stable names, in the order requested.
    /// Throws <see cref="ArgumentException"/> naming the first unknown id.
    /// </summary>
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
