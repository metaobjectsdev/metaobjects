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

    public IEnumerable<EmittedFile> Generate(GenContext ctx) =>
        ctx.Entities.Where(Filter).Select(e => GenerateOne(e, ctx));
}
