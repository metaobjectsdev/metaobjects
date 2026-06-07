// M2MNavigation — codegen-side descriptor for a many-to-many relationship (FR-018).
//
// Mirrors the TS codegen relation-resolver's buildM2mEntry: walk a source
// entity's relationships, and for each `@cardinality: "many"` + `@through`
// relationship derive the junction FK columns from the junction entity's two
// identity.reference children (the SSOT) via the shared M2MDerivation helper —
// hetero / directed-self-join / symmetric. Codegen reads these descriptors to
// emit the entity navigation collection (EntityGenerator), the EF UsingEntity
// wiring (DbContextGenerator), and the REST traversal route (RoutesGenerator).
//
// The descriptor carries LOGICAL junction FK field names. The generated EF code
// addresses the junction/target via their PascalCased property names (EF maps each
// property to its physical column through the [Column] attribute), so codegen never
// needs the physical column name — that resolution lives in the entity generator.

using MetaObjects.Core.Relationship;
using MetaObjects.Meta;
using static MetaObjects.Core.Relationship.RelationshipConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>
/// A resolved many-to-many navigation on a source entity: the target entity, the
/// junction entity, and the source/target junction FK fields (logical + physical),
/// plus the symmetric flag. Derived from metadata at codegen time.
/// </summary>
public sealed record M2MNavigation(
    MetaObject Source,
    MetaRelationship Relationship,
    MetaObject Target,
    MetaObject Junction,
    /// <summary>Logical junction FK field holding the SOURCE key (e.g. "postId").</summary>
    string SourceField,
    /// <summary>Logical junction FK field holding the TARGET key (e.g. "tagId").</summary>
    string TargetField,
    bool Symmetric)
{
    /// <summary>The navigation member name (the relationship name, e.g. "tags").</summary>
    public string Name => Relationship.Name;

    /// <summary>True when the target entity is the source entity (self-join).</summary>
    public bool IsSelfJoin => ReferenceEquals(Source, Target) ||
        string.Equals(Source.Name, Target.Name, StringComparison.Ordinal);
}

/// <summary>
/// Builds <see cref="M2MNavigation"/> descriptors from metadata — the single place
/// codegen derives M:N junction columns. Shared by the entity / DbContext / routes
/// generators so they agree on the wiring.
/// </summary>
public static class M2MNavigationBuilder
{
    /// <summary>
    /// All M:N navigations declared on <paramref name="entity"/> (own relationships
    /// with <c>@cardinality: "many"</c> + <c>@through</c>). Returns an empty list for
    /// an entity with no M:N relationships. A relationship whose junction FK columns
    /// cannot be derived is skipped (the loader validation surfaces the error).
    /// </summary>
    public static IReadOnlyList<M2MNavigation> For(MetaObject entity, MetaRoot root)
    {
        var result = new List<M2MNavigation>();
        foreach (var rel in entity.Relationships())
        {
            if (rel.Cardinality != CARDINALITY_MANY || rel.Through is null) continue;
            if (Build(entity, rel, root) is { } nav) result.Add(nav);
        }
        return result;
    }

    private static M2MNavigation? Build(MetaObject source, MetaRelationship rel, MetaRoot root)
    {
        if (rel.ObjectRef is not { } targetRef || rel.Through is not { } throughRef) return null;
        var target = root.FindObject(CSharpNaming.StripPkg(targetRef));
        var junction = root.FindObject(CSharpNaming.StripPkg(throughRef));
        if (target is null || junction is null) return null;

        M2MFields fields;
        try { fields = M2MDerivation.DeriveM2MFields(rel, source, root); }
        catch (M2MDerivationException) { return null; }

        return new M2MNavigation(
            Source: source,
            Relationship: rel,
            Target: target,
            Junction: junction,
            SourceField: fields.SourceField,
            TargetField: fields.TargetField,
            Symmetric: rel.Symmetric);
    }
}
