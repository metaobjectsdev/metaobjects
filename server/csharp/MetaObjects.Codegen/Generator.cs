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

    /// <summary>
    /// The project the manifest is anchored on — the directory <see cref="GenStateDir"/>
    /// was derived from. When set, manifest keys are relative to it rather than to
    /// <see cref="OutDir"/>.
    /// <para>
    /// This matters because the manifest is anchored on the PROJECT and never configured
    /// per out dir: with out-dir-relative keys, two runs with different <c>--out</c> under
    /// one project collide on a single entry, and the second run's record makes the first
    /// out dir's HAND-EDITED file read as pristine. Mirrors the Python port's
    /// <c>project_root</c>, re-keyed for the same reason.
    /// </para>
    /// <para>
    /// <c>null</c> keeps the out-dir-relative spelling, for a programmatic caller that
    /// names no project. Both sides of the relative-path computation come from
    /// <c>Path.GetFullPath</c> — normalised but NOT link-resolved — so they stay
    /// symmetric; resolving only one side would walk a key out of the project under a
    /// directory symlink and silently match nothing.
    /// </para>
    /// </summary>
    public string? ProjectRoot { get; init; }
    /// <summary>
    /// First-time-on-existing-file behaviour: <c>"default"</c> refuses a file that cannot
    /// be proved to be generated output; <c>"adopt"</c> records the file's CURRENT content
    /// as the baseline and writes nothing.
    /// <para>
    /// <c>adopt</c> exists because the refusal's remedy — commit the manifest — could not
    /// be performed by the population it named: nothing writes a manifest until a gen
    /// succeeds, and a run where every file refuses writes none. It is NOT protection for
    /// an edit already in the file: what it records IS that text, so the next run
    /// regenerates over it. What it guarantees is that establishing the baseline writes
    /// nothing, which lets the regeneration land as its own reviewable diff.
    /// </para>
    /// </summary>
    public string Baseline { get; init; } = "default";
    /// <summary>C# namespace for generated types.</summary>
    public required string Namespace { get; init; }
    /// <summary>
    /// Strategy applied to field names with no <c>@column</c> override. ADR-0058 — one
    /// project setting (<c>naming.columns</c> in <c>.metaobjects/config.json</c>), read by
    /// every port; defaults to <see cref="ColumnNamingStrategy.SnakeCase"/>, matching what
    /// <c>meta migrate</c> has always created. A real CLI run (<c>CodegenCli.RunGen</c> /
    /// <c>VerifyCommand</c>'s codegen-drift gate) always sets this from the loaded root's
    /// <see cref="MetaRoot.PhysicalNaming"/> rather than relying on this default; it is reached
    /// only by a hand-built <c>GenConfig</c> that names no project (a programmatic embedder,
    /// or a test fixture).
    /// Plumbed through every <c>CSharpNaming.Column</c> call site in the entity +
    /// DbContext generators.
    /// </summary>
    public ColumnNamingStrategy ColumnNamingStrategy { get; init; } = ColumnNamingStrategy.SnakeCase;

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
    /// primary source — #248), and from the DIVERGENCE refusal, which lives in
    /// <c>MetaObjects.Meta.SourceResolution</c> rather than in any generator (an object
    /// whose <c>@role: primary</c> sources disagree on a physical name throws, once,
    /// unconditionally — there is no flag that suppresses it and never should be, and
    /// putting it below codegen is what makes it reach the runtime too). A false positive here (claiming
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
    /// Delete, after the writes, each file under this run's output directories that the hash
    /// manifest records writing and that no generator emitted this run, when it is still
    /// byte-for-byte what was recorded; an edited one is refused by name
    /// (<see cref="OrphanSweep"/>). Needs <see cref="GenStateDir"/> and <see cref="ProjectRoot"/>,
    /// and never runs under <c>Baseline = "adopt"</c>.
    /// <para>
    /// Only a run of the WHOLE generator list may sweep: a subset leaves out the files of the
    /// generators it did not run, and they would all look orphaned. <c>dotnet meta gen</c> sets
    /// it on a run with no <c>--generators</c> narrowing. Defaults to <c>false</c>, so a
    /// programmatic caller, which may be running any subset, deletes nothing it did not ask to.
    /// </para>
    /// </summary>
    public bool SweepOrphans { get; init; } = false;

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

    /// <summary>
    /// The generators of this run, in list order. A generator whose output depends on another
    /// being listed asks here (see <see cref="ReportExportMaxRows"/>). Empty for a context nobody
    /// filled in, which is what a hand-built context in a test gets.
    /// </summary>
    public IReadOnlyList<IGenerator> Generators { get; init; } = [];

    /// <summary>
    /// The row cap of the <c>report-export</c> generator wired into this run, or <c>null</c> when the
    /// run lists none. The routes generator emits the <c>?format=</c> branch on a served report's list
    /// route if and only if this is not <c>null</c>, and builds it with this cap. It reads the answer
    /// from <see cref="IGenerator.ReportExportMaxRows"/>, so an ejected copy of the export generator
    /// wires the routes exactly as the packaged one does.
    /// </summary>
    public int? ReportExportMaxRows =>
        Generators.Select(g => g.ReportExportMaxRows).FirstOrDefault(m => m is not null);

    /// <summary>
    /// What the api-docs generator asks of the generators it documents (see
    /// <see cref="GeneratorApplicability"/>): the packaged generators' answers.
    /// </summary>
    public GeneratorApplicability Applicability { get; init; } = GeneratorApplicability.Packaged;

    /// <summary>
    /// The predicate <see cref="Narrow"/> applied, so a view-backed report's row model (which
    /// joins a generator's set from <see cref="Root"/>, not from <see cref="Entities"/>) is
    /// held to it too. <c>null</c> on a context nobody narrowed.
    /// </summary>
    public Func<MetaObject, bool>? Scope { get; init; }

    /// <summary>
    /// The same context with <see cref="Entities"/> reduced to the objects
    /// <paramref name="include"/> accepts (and every report row model held to it too).
    /// <see cref="Root"/> is untouched, so a generator that resolves a reference through it
    /// (a value object an emitted entity points at) still finds the target. <c>null</c> returns
    /// this context. This is what the packaged generators' <c>Include</c> property does.
    /// </summary>
    public GenContext Narrow(Func<MetaObject, bool>? include) =>
        include is null ? this : new GenContext
        {
            Entities = Entities.Where(include).ToList(),
            Root = Root,
            Config = Config,
            Warn = Warn,
            Generators = Generators,
            Applicability = Applicability,
            Scope = Scope is null ? include : o => Scope(o) && include(o),
        };
}

/// <summary>A codegen unit. Kebab-case <see cref="Name"/> surfaces in diagnostics.</summary>
public interface IGenerator
{
    string Name { get; }
    IEnumerable<EmittedFile> Generate(GenContext ctx);

    /// <summary>
    /// Where this entry's files are written, when not under the run's <c>--out</c>
    /// (ADR-0034 Amendment 9: each entry in <c>codegen/Generators.cs</c> may carry its own
    /// output directory, as the api reference does). A relative path is taken from the
    /// directory the run starts in, as <c>--out</c> is. <c>null</c>, the default, writes
    /// under <c>--out</c>.
    /// </summary>
    string? OutDir => null;

    /// <summary>
    /// What a run does with a file of this entry's that was edited by hand since it was
    /// generated. <see cref="Codegen.HandEdits.Keep"/>, the default, refuses to replace it (and
    /// refuses to delete it once no generator emits it). <see cref="Codegen.HandEdits.Overwrite"/>
    /// replaces it with fresh output and records the new content, and lets the orphan sweep
    /// delete it, naming each file it discards. Set it on an entry in
    /// <c>codegen/Generators.cs</c> with <see cref="GeneratorExtensions.WithHandEdits"/>.
    /// </summary>
    HandEdits HandEdits => HandEdits.Keep;

    /// <summary>
    /// The row cap of the report export this entry wires into the report list routes, or <c>null</c>
    /// (the default, and the answer of every generator but <c>report-export</c>) when it wires none.
    /// Listing a generator that answers a number is what makes the routes generator emit the
    /// <c>?format=csv|json|xml</c> branch: see <see cref="GenContext.ReportExportMaxRows"/>.
    /// </summary>
    int? ReportExportMaxRows => null;
}

/// <summary>A generator entry's <c>handEdits</c> setting: what a run does with a hand-edited file.</summary>
public enum HandEdits
{
    /// <summary>Refuse to replace or delete a hand-edited file (the default).</summary>
    Keep,
    /// <summary>Replace a hand-edited file with fresh output, and delete a hand-edited orphan.</summary>
    Overwrite,
}

/// <summary>Per-entry settings for any <see cref="IGenerator"/>.</summary>
public static class GeneratorExtensions
{
    /// <summary>The same entry with its <see cref="IGenerator.HandEdits"/> setting replaced:
    /// <c>new EntityGenerator().WithHandEdits(HandEdits.Overwrite)</c>.</summary>
    public static IGenerator WithHandEdits(this IGenerator generator, HandEdits handEdits) =>
        new HandEditsGenerator(generator is HandEditsGenerator h ? h.Inner : generator, handEdits);
}

/// <summary>An entry with its <c>handEdits</c> setting; everything else is the wrapped entry's.</summary>
internal sealed class HandEditsGenerator(IGenerator inner, HandEdits handEdits) : IGenerator
{
    /// <summary>The wrapped entry.</summary>
    public IGenerator Inner { get; } = inner;
    /// <inheritdoc/>
    public string Name => Inner.Name;
    /// <inheritdoc/>
    public string? OutDir => Inner.OutDir;
    /// <inheritdoc/>
    public HandEdits HandEdits { get; } = handEdits;
    /// <inheritdoc/>
    public int? ReportExportMaxRows => Inner.ReportExportMaxRows;
    /// <inheritdoc/>
    public IEnumerable<EmittedFile> Generate(GenContext ctx) => Inner.Generate(ctx);
}

/// <summary>One-file-per-entity convenience base (entity / queries / routes generators).</summary>
public abstract class PerEntityGenerator : IGenerator
{
    public abstract string Name { get; }

    /// <summary>
    /// Per-entity opt-in; defaults to all entities.
    ///
    /// Public (ADR-0034 Amendment 3 eject): an owned copy of one <see
    /// cref="PerEntityGenerator"/> subclass may want to reuse ANOTHER's applicability
    /// predicate (e.g. a customized routes generator asking "would filter-allowlist emit
    /// for this entity?") rather than re-deriving it. C# requires an override's
    /// accessibility to match its base exactly, so every subclass override below is
    /// public too.
    /// </summary>
    public virtual bool Filter(MetaObject entity) => true;

    protected abstract EmittedFile GenerateOne(MetaObject entity, GenContext ctx);

    public virtual IEnumerable<EmittedFile> Generate(GenContext ctx) =>
        ctx.Narrow(Include).Entities.Where(Filter).Select(e => GenerateOne(e, ctx));

    /// <summary>
    /// Scope this entry to some objects: only those it accepts are generated for. Set on the
    /// entry in <c>codegen/Generators.cs</c> (<c>new RoutesGenerator { Include = o =&gt; ... }</c>).
    /// <c>null</c>, the default, accepts every object. Separate from <see cref="Filter"/>,
    /// which is the generator's OWN applicability rule and stays the subclass seam.
    /// </summary>
    public Func<MetaObject, bool>? Include { get; init; }
}
