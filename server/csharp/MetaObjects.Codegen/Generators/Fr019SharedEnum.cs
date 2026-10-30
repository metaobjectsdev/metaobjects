// FR-019 — shared + externally-provided enum resolution (C# port of the TS
// reference server/typescript/packages/codegen-ts/src/enum-shared.ts +
// enum-import.ts + templates/enums-file.ts).
//
// A reusable enum is a ROOT/package-level abstract `field.enum` (a sibling of
// object.entity) that concrete entity fields `extends`. Per ADR-0026 such a
// declaration is materialized ONCE per port and referenced, instead of being
// redeclared inline (a nested `public enum E`) in every consuming entity file.
//
// Two cases on the abstract declaration:
//   • non-@provided → metaobjects MATERIALIZES the type once (a shared file,
//     Enums.g.cs, a namespace-level `public enum E { A, B }`), and consuming
//     fields reference it (same namespace ⇒ a bare `E`).
//   • @provided: true → metaobjects emits NOTHING for the type; consuming fields
//     reference an existing hand-written/third-party type, resolved via per-port
//     codegen config (GenConfig.ProvidedEnumNamespace) as `<ns>.E`. The
//     namespace never lives in metadata (ADR-0001); a missing config for a
//     referenced provided enum is a codegen-time error naming the enum + key.
//
// The common inline case (a concrete `field.enum` with @values declared directly,
// no root-extends) is UNCHANGED — it stays a per-entity nested `<Entity><Field>`
// enum. Shared + @provided are additive branches gated on "root-level abstract
// field.enum", so the inline default output is byte-identical (the drift gate).

using MetaObjects.Core.Field;
using MetaObjects.Meta;
using MetaObjects.Shared;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>A shared (root-level abstract) enum declaration codegen must reason about.
/// <paramref name="Package"/> is the declaration's effective metadata package (folded
/// file-default package), used to resolve a <c>@provided</c> enum's C# namespace via
/// <see cref="GenConfig.PackageNamespaces"/> (ADR-0001: bind the namespace to the
/// metadata package, never an FQN in metadata).</summary>
public sealed record SharedEnum(string Name, IReadOnlyList<string> Values, bool Provided, string Package);

/// <summary>
/// FR-019 — resolves the shared/provided status of an enum field and collects the
/// materialized shared enums across the loaded model. Mirrors the TS enum-shared module.
/// </summary>
public static class Fr019SharedEnum
{
    /// <summary>
    /// The shared enum declaration a concrete enum field resolves to via <c>extends</c>, or
    /// <see langword="null"/> when the field is an inline enum. Delegates the walk to
    /// <see cref="SharedEnumDeclaration.ResolveSharedEnumDeclaration"/> — the single
    /// cross-port/loader authority (#246 / FR-019) — so naming and materialization can never
    /// drift from what the loader's conflict check agrees is "shared".
    /// </summary>
    public static MetaField? ResolveSharedEnumDecl(MetaField field) =>
        SharedEnumDeclaration.ResolveSharedEnumDeclaration(field);

    /// <summary>The shared-enum descriptor a field resolves to, or null for inline enums.</summary>
    public static SharedEnum? SharedEnumForField(MetaField field)
    {
        if (ResolveSharedEnumDecl(field) is not { } decl) return null;
        // Read the member set from the DECLARATION, not the consuming field: every field
        // sharing this declaration must agree on its materialized shape, so the read must be
        // anchored at the one node the shape is owned by rather than wherever the walk
        // happened to start — output cannot depend on which consumer codegen visits first.
        if (decl.EffectiveEnumValues is not { Count: > 0 } values) return null;
        return new SharedEnum(
            Name: CSharpNaming.Pascal(decl.Name),
            Values: values,
            // ADR-0039 sanctioned own: @provided is a declaration-layer provenance marker
            // ("THIS type is supplied by hand-written/third-party code"), like IsAbstract —
            // it does not flow down an extends chain. A resolving read misfires on a chained
            // declaration (root abstract B extends root abstract @provided A): B would be
            // reported provided and emit a reference to a hand-written B the adopter never
            // declared, instead of materializing B. Matches the JVM ports.
            Provided: decl.OwnAttr(FIELD_ATTR_PROVIDED) is true,
            Package: PackageOf(decl));
    }

    /// <summary>
    /// The declaration's effective metadata package — its package-folded
    /// <see cref="MetaData.ResolutionKey"/> with the trailing <c>::Name</c> stripped.
    /// Empty string when the declaration carries no package (root-level, no file default).
    /// </summary>
    private static string PackageOf(MetaField decl)
    {
        var key = decl.ResolutionKey();
        var idx = key.LastIndexOf(Structural.PACKAGE_SEPARATOR, StringComparison.Ordinal);
        return idx < 0 ? "" : key[..idx];
    }

    /// <summary>
    /// All shared (root-level abstract) enum declarations in the loaded root that are
    /// actually CONSUMED by at least one concrete entity field — keyed by materialized
    /// type name. A declaration nobody extends is not materialized (no dangling type).
    /// Deterministic order: first-consumption order across entities (ordinal by name).
    /// </summary>
    public static IReadOnlyList<SharedEnum> CollectSharedEnums(MetaRoot root, IEnumerable<MetaObject>? alsoReached = null)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var outList = new List<SharedEnum>();
        // FR-023: an enum reaches the output iff an object this project generates uses it, decided by the
        // USING object, never by the enum's own package. `alsoReached` is what that object pulls in that
        // is itself imported (a value object whose POCO is emitted because a generated entity holds one).
        foreach (var entity in root.Objects().Where(root.InScope).Concat(alsoReached ?? []))
            foreach (var field in entity.Fields())
            {
                if (SharedEnumForField(field) is not { } shared) continue;
                if (seen.Add(shared.Name)) outList.Add(shared);
            }
        return outList.OrderBy(e => e.Name, StringComparer.Ordinal).ToList();
    }

    /// <summary>The shared enums that metaobjects MATERIALIZES (non-@provided, consumed).</summary>
    public static IReadOnlyList<SharedEnum> MaterializedSharedEnums(MetaRoot root, IEnumerable<MetaObject>? alsoReached = null) =>
        CollectSharedEnums(root, alsoReached).Where(e => !e.Provided).ToList();

    /// <summary>
    /// The C# type reference a consuming field emits for a shared/provided enum:
    /// <list type="bullet">
    ///   <item>materialized → the bare type name <c>E</c> (lives in the same generated namespace).</item>
    ///   <item>@provided → <c>&lt;cfg.ProvidedEnumNamespace&gt;.E</c>. A missing config is a
    ///   codegen-time error naming the enum + the config key (ADR-0026 / ADR-0001).</item>
    /// </list>
    /// </summary>
    public static string SharedEnumTypeReference(SharedEnum shared, GenConfig config)
    {
        if (!shared.Provided) return shared.Name;
        // Bind the namespace to the enum's declaring metadata package (ADR-0001):
        //   TypeOverrides → PackageNamespaces → Convention with ProvidedEnumPrepend →
        //   ProvidedEnumNamespace (FR-019 legacy single-string fallback) → Error.
        var ns = PackageBindingResolver.TryResolve(config, shared.Package, shared.Name, useProvidedEnumPrepend: true)
                 ?? config.ProvidedEnumNamespace;
        if (string.IsNullOrEmpty(ns))
            throw new InvalidOperationException(
                $"provided enum \"{shared.Name}\" (declared in package \"{shared.Package}\") is marked " +
                $"@provided but no C# namespace is configured to reference it from. Set " +
                $"Convention.ProvidedEnumPrepend, map its package in PackageNamespaces, " +
                $"or set the legacy ProvidedEnumNamespace fallback.");
        return $"{PackageBindingResolver.ValidNamespace(ns, shared.Package)}.{shared.Name}";
    }
}
