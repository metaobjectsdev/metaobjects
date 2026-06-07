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
    /// When <c>false</c> (the default), abstract entities emit no shape artifact
    /// at all. When <c>true</c>, an abstract entity emits exactly one standalone
    /// <c>public abstract class &lt;Name&gt;</c> (properties only — no EF
    /// <c>[Table]</c>/<c>[Key]</c>/<c>[Column]</c> mapping, since it is a shape,
    /// not a table). Abstract entities NEVER produce instance/write artifacts
    /// regardless of this knob.
    /// </summary>
    public bool EmitAbstractShapes { get; init; } = false;

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
