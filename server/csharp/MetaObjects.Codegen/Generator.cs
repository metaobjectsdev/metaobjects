// Codegen generator abstraction — the C# analog of codegen-ts's Generator/runGen.
// Single output target for now (multi-target/cross-target import resolution can
// follow the TS shape later). Each generator emits files; the runner writes them
// under an @generated-header guard so hand-written files are never clobbered.

using MetaObjects.Meta;

namespace MetaObjects.Codegen;

/// <summary>A file a generator produced. <paramref name="Path"/> is relative to the out dir.</summary>
public sealed record EmittedFile(string Path, string Content);

/// <summary>Resolved generation config.</summary>
public sealed record GenConfig
{
    /// <summary>Directory generated files are written under.</summary>
    public required string OutDir { get; init; }

    /// <summary>
    /// Where the codegen hash manifest lives (<c>&lt;GenStateDir&gt;/.hashes.json</c>),
    /// recording what this generator wrote so a later run can tell its own output from a
    /// hand edit.
    /// <para>
    /// <c>null</c> disables that detection and falls back to the legacy
    /// <c>&lt;auto-generated/&gt;</c>-marker rule — which cannot distinguish an edited
    /// generated file from a pristine one, because an edited file keeps its marker.
    /// Mirrors codegen-ts, where a <c>runGen</c> with no <c>projectRoot</c> likewise gets
    /// weaker guarantees; the CLI always supplies a value.
    /// </para>
    /// <para>
    /// COMMIT the manifest. It is one hash per generated path, and the only thing that
    /// makes hand-edit detection work on a machine that did not generate the output.
    /// </para>
    /// </summary>
    public string? GenStateDir { get; init; }
    /// <summary>C# namespace for generated types.</summary>
    public required string Namespace { get; init; }
    /// <summary>
    /// Strategy applied to field names with no <c>@column</c> override. Defaults
    /// to <see cref="ColumnNamingStrategy.Literal"/> (EF Core convention).
    /// Plumbed through every <c>CSharpNaming.Column</c> call site in the entity +
    /// DbContext generators.
    /// </summary>
    public ColumnNamingStrategy ColumnNamingStrategy { get; init; } = ColumnNamingStrategy.Literal;

    /// <summary>
    /// C1 — the RUN-LEVEL presence gate for the <c>&lt;Entity&gt;Names</c> artifact:
    /// true iff the <c>names</c> generator (<c>Generators.NamesGenerator</c>) is part
    /// of the generator suite THIS run selected. Consumption sites
    /// (<c>CSharpNaming.ColumnRef</c>/<c>NameRef</c>, called from the entity + db-context
    /// generators) gate on this before referencing <c>&lt;Owner&gt;Names.*</c> — without
    /// it, <c>dotnet meta gen --generators entity,db-context</c> (a documented,
    /// individually-selectable subset per <c>GenCommand.DefaultGeneratorNames</c>'s own
    /// doc comment) emitted a reference to a class no generator in that run produces,
    /// failing <c>CS0103</c> against a real EF Core compile.
    /// <para>
    /// This is PRESENCE, distinct from the per-object EXISTENCE question
    /// <c>CSharpNaming.ResolveObjectNames</c> answers (null when an object has no
    /// primary source — #248), and from the DIVERGENCE guard inside that same method
    /// (a primary/writable-source disagreement throws, once, unconditionally — there is
    /// no flag that suppresses it and never should be). A false positive here (claiming
    /// names ran when it did not) would reintroduce exactly the defect this exists to
    /// close; nothing may compare a constant's VALUE to a literal and fall back on a
    /// mismatch — that is the forbidden shape. This only asks "was the generator even
    /// invoked."
    /// </para>
    /// <para>
    /// Defaults to <c>false</c>. <c>GenCommand.Run</c> and <c>VerifyCommand</c>'s
    /// codegen-drift gate compute the real value from the resolved generator-name list
    /// (<c>GeneratorRegistry.IncludesNames</c>) and set this explicitly on every actual
    /// CLI invocation, so a project's real output is governed by what <c>--generators</c>
    /// selected either way; this default only reaches a caller that builds
    /// <c>GenConfig</c> directly and says nothing about which generators it plans to run
    /// — a programmatic embedder, or a hand-built test fixture. It fails in the SAFE
    /// direction: <c>true</c> would reproduce, through this API surface, the exact
    /// CS0103 defect this flag exists to close (running <c>EntityGenerator</c> alone
    /// still emits a reference to a class nothing in that run produces); <c>false</c>
    /// keeps the literal spelling, which always compiles and is still the right
    /// physical name. This also mirrors the TypeScript reference port, where the
    /// equivalent knob (<c>includeNames</c> in <c>render-context.ts</c>) defaults to
    /// <c>false</c> — the two reference ports must not disagree on this default. Every
    /// hand-built <c>GenConfig</c> in this codebase's test suite that actually exercises
    /// the names artifact sets <c>IncludeNames = true</c> explicitly.
    /// </para>
    /// </summary>
    public bool IncludeNames { get; init; } = false;

    /// <summary>
    /// When <c>false</c> (the default), abstract entities emit no shape artifact
    /// at all. When <c>true</c>, an abstract entity emits exactly one standalone
    /// <c>public abstract class &lt;Name&gt;</c> (properties only — no EF
    /// <c>[Table]</c>/<c>[Key]</c>/<c>[Column]</c> mapping, since it is a shape,
    /// not a table). Abstract entities NEVER produce instance/write artifacts
    /// regardless of this knob.
    /// </summary>
    public bool EmitAbstractShapes { get; init; } = false;

    /// <summary>
    /// The C# type name of the EF Core DbContext that callable (stored-proc / table-function)
    /// wrappers take as their first parameter. Defaults to <c>AppDbContext</c> (the name the
    /// upstream DbContextGenerator emits). A downstream consumer that renames its context
    /// sets this so callable signatures reference the real type.
    /// </summary>
    public string ContextTypeName { get; init; } = "AppDbContext";

    /// <summary>
    /// FR-019 — the C# namespace an externally-<c>@provided</c> shared enum is referenced
    /// from (ADR-0026: the namespace is per-port codegen config, never a metadata attr —
    /// ADR-0001). A consuming field of a <c>@provided</c> abstract <c>field.enum</c> emits
    /// <c>&lt;ProvidedEnumNamespace&gt;.&lt;EnumName&gt;</c>. Unset (null/empty) is fine
    /// when the model has no <c>@provided</c> enums; referencing one without it set is a
    /// codegen-time error naming the enum + this key.
    /// </summary>
    public string? ProvidedEnumNamespace { get; init; }

    /// <summary>
    /// FR-019 — maps a metadata <b>package</b> (e.g. <c>acme::ext::auth</c>) to the C#
    /// namespace its <c>@provided</c> shared enums are referenced from. The namespace
    /// binds to the enum's <i>declaring package</i> (metadata-native, ADR-0001); the
    /// package→namespace map is per-port codegen config. This lets a single model
    /// reference <c>@provided</c> enums that live in several namespaces (one entry per
    /// namespace, not per enum). When a referenced provided enum's package has no entry
    /// here, <see cref="ProvidedEnumNamespace"/> is used as the single fallback; if
    /// neither resolves, it is a codegen-time error naming the enum + its package.
    /// </summary>
    public Dictionary<string, string> PackageNamespaces { get; init; } = new();

    /// <summary>
    /// Package-binding — convention rule that derives a C# namespace from a metadata package
    /// when no explicit override matches. Covers the 90% case so an adopter with N
    /// domains needs ~1 line of config, not N. Unset (null) ⇒ no convention applied;
    /// resolution falls through to <see cref="UnmappedStrategy"/>.
    /// </summary>
    public PackageBindingConvention? Convention { get; init; }

    /// <summary>
    /// Package-binding — type-level overrides keyed by fully-qualified type name
    /// (<c>&lt;package&gt;::&lt;typeName&gt;</c>). Wins over package-level
    /// <see cref="PackageNamespaces"/> and the <see cref="Convention"/> rule. Use when
    /// a single entity / value-object / enum in an otherwise-uniform package needs to
    /// land in a different namespace than its siblings.
    /// </summary>
    public Dictionary<string, string> TypeOverrides { get; init; } = new();

    /// <summary>
    /// Package-binding — what to do when neither overrides nor the <see cref="Convention"/> rule
    /// resolves a metadata package. Defaults to <see cref="UnmappedPackageStrategy.Flatten"/>
    /// (today's behavior: fall back to <see cref="Namespace"/>). Setting to
    /// <see cref="UnmappedPackageStrategy.Error"/> forces explicit mapping (recommended
    /// once an adopter's config is settled — catches metadata that grows a new package
    /// without a corresponding config entry).
    /// </summary>
    public UnmappedPackageStrategy UnmappedStrategy { get; init; } = UnmappedPackageStrategy.Flatten;
}

/// <summary>Package-binding — convention rule that derives a target namespace from a metadata
/// package. Resolution: split the package on <c>::</c>, strip the leading
/// <see cref="Strip"/> prefix (if matched), transform each remaining segment per
/// <see cref="Case"/>, join by <see cref="Separator"/>, prepend <see cref="Prepend"/>.
/// The metaobjects-standard <c>::</c> package separator is invariant (cross-port);
/// <see cref="Separator"/> is the per-port output joiner (e.g. <c>.</c> for C#).</summary>
public sealed record PackageBindingConvention
{
    /// <summary>Prefix to strip from the metadata package (e.g. <c>acme::</c>). Match must succeed
    /// for the convention rule to apply; otherwise the resolver falls through to the next
    /// resolution layer. Empty/null = strip nothing.</summary>
    public string? Strip { get; init; }

    /// <summary>Per-port prefix to prepend to the derived segments
    /// (e.g. <c>Acme.Domain.Entities</c>). Joined to the segments by
    /// <see cref="Separator"/>. Required when the convention rule is set.</summary>
    public required string Prepend { get; init; }

    /// <summary>Per-port segment separator (e.g. <c>.</c> for C#/Java, <c>/</c> for TS
    /// module paths). Defaults to <c>.</c>.</summary>
    public string Separator { get; init; } = ".";

    /// <summary>Per-segment case transformation. Applied to each segment AFTER splitting
    /// the metadata package on <c>::</c>, BEFORE joining by <see cref="Separator"/>.</summary>
    public PackageCase Case { get; init; } = PackageCase.PascalCase;

    /// <summary>Package-binding — alternate <see cref="Prepend"/> applied when resolving an
    /// abstract <c>field.enum</c> with <c>@provided: true</c> (the FR-019 shared-enum
    /// reference case). When set, the convention rule's strip / case / separator stay
    /// the same; only the prepended root differs. Lets adopters route <c>@provided</c>
    /// enums to a parallel namespace tree (e.g. <c>YourApp.Domain.DataEnums.*</c>)
    /// without splitting their <c>YourApp.Domain.Entities.*</c> tree. Unset = use
    /// <see cref="Prepend"/> (today's behavior — @provided enums land alongside
    /// entities in the same convention).</summary>
    public string? ProvidedEnumPrepend { get; init; }
}

/// <summary>Per-segment case transformations supported by <see cref="PackageBindingConvention.Case"/>.</summary>
public enum PackageCase
{
    /// <summary>each-segment → EachSegment (C#/Java/Kotlin namespace segments).</summary>
    PascalCase,
    /// <summary>each-segment → eachSegment (TS interior identifier segments).</summary>
    CamelCase,
    /// <summary>each-segment → each-segment (TS npm package name segments).</summary>
    KebabCase,
    /// <summary>each-segment → each_segment (Python module name segments).</summary>
    SnakeCase,
    /// <summary>each-segment → eachsegment (Java reverse-DNS package segments — no separator within a segment).</summary>
    Lowercase,
    /// <summary>each-segment → each-segment (as-authored — no transformation).</summary>
    Preserve,
}

/// <summary>What to do when a metadata package resolves through neither overrides nor the
/// <see cref="GenConfig.Convention"/> rule.</summary>
public enum UnmappedPackageStrategy
{
    /// <summary>Fall back to the port's default flat <see cref="GenConfig.Namespace"/>. Matches
    /// today's behavior (FR-019) when <see cref="GenConfig.PackageNamespaces"/> has no entry.</summary>
    Flatten,
    /// <summary>Codegen fails with a clear message naming the package + the config key to set.
    /// Recommended once an adopter's config is settled — catches metadata that grows a new
    /// package without a corresponding config entry.</summary>
    Error,
    /// <summary>Apply the convention rule's case + separator transformation without
    /// <see cref="PackageBindingConvention.Strip"/>/<see cref="PackageBindingConvention.Prepend"/>
    /// — pure passthrough. Useful when metadata packages are already in the port's idiom.</summary>
    Derive,
}

/// <summary>Per-run state handed to every generator.</summary>
public sealed class GenContext
{
    public required IReadOnlyList<MetaObject> Entities { get; init; }
    public required MetaRoot Root { get; init; }
    public required GenConfig Config { get; init; }
    public Action<string> Warn { get; init; } = _ => { };
}

/// <summary>A codegen unit. Kebab-case <see cref="Name"/> surfaces in diagnostics.</summary>
public interface IGenerator
{
    string Name { get; }
    IEnumerable<EmittedFile> Generate(GenContext ctx);
}

/// <summary>One-file-per-entity convenience base (entity / queries / routes generators).</summary>
public abstract class PerEntityGenerator : IGenerator
{
    public abstract string Name { get; }

    /// <summary>Per-entity opt-in; defaults to all entities.</summary>
    protected virtual bool Filter(MetaObject entity) => true;

    protected abstract EmittedFile GenerateOne(MetaObject entity, GenContext ctx);

    public virtual IEnumerable<EmittedFile> Generate(GenContext ctx) =>
        ctx.Entities.Where(Filter).Select(e => GenerateOne(e, ctx));
}
