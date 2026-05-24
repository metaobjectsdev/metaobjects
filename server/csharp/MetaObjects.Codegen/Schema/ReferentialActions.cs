// ReferentialActions — resolve @onDelete / @onUpdate for an FK at codegen time.
//
// Mirrors Java Stage 2 Unit 2 and TS migrate-ts's expected-schema action threading:
// pick the relationship.* sibling whose @objectRef matches the FK target entity
// name, read its effective on-delete/on-update (explicit attr → subtype default),
// and translate to SQL (cascade / set-null / restrict / no-action). Filters out
// no-action to match introspection's normalization.

using MetaObjects.Meta;
using MetaObjects.Codegen.Migrate;
using MetaObjects.Core.Relationship;

namespace MetaObjects.Codegen.Schema;

/// <summary>
/// Resolved referential actions for a single FK. Both fields are nullable —
/// no-action is omitted (introspection drops it; emitter should too, so the
/// expected and actual snapshots compare equal).
/// </summary>
public readonly record struct ResolvedReferentialActions(FkAction? OnDelete, FkAction? OnUpdate);

/// <summary>Resolves cross-language referential actions on a per-FK basis.</summary>
public static class ReferentialActions
{
    /// <summary>
    /// Pick the <c>relationship.*</c> child of <paramref name="entity"/> whose
    /// <c>@objectRef</c> targets <paramref name="targetEntityName"/> (with package
    /// stripped). Returns null when none matches — callers fall back to no-action.
    /// </summary>
    private static MetaRelationship? FindFkRelationship(MetaObject entity, string targetEntityName)
    {
        foreach (var rel in entity.Relationships())
        {
            if (rel.ObjectRef is not { } refName) continue;
            // Compare with package stripped on both sides; users may write a bare name.
            if (CSharpNaming.StripPkg(refName) == CSharpNaming.StripPkg(targetEntityName))
                return rel;
        }
        return null;
    }

    /// <summary>
    /// Resolves the effective referential actions for an enforced reference identity.
    /// </summary>
    /// <param name="entity">The FK-owning entity (the child).</param>
    /// <param name="targetEntityName">The target entity name (the parent).</param>
    public static ResolvedReferentialActions Resolve(MetaObject entity, string targetEntityName)
    {
        var rel = FindFkRelationship(entity, targetEntityName);
        if (rel is null)
        {
            // No relationship found — emit nothing (defer to DB defaults, mirroring no-action).
            return new ResolvedReferentialActions(null, null);
        }

        FkAction? del = ToFkAction(rel.EffectiveOnDelete);
        FkAction? upd = ToFkAction(rel.EffectiveOnUpdate);
        return new ResolvedReferentialActions(del, upd);
    }

    /// <summary>
    /// Translates a referential-action wire string to <see cref="FkAction"/>.
    /// Returns null for "no-action" so emitters can omit the clause.
    /// </summary>
    public static FkAction? ToFkAction(string action) => action switch
    {
        RelationshipConstants.ACTION_CASCADE   => FkAction.Cascade,
        RelationshipConstants.ACTION_SET_NULL  => FkAction.SetNull,
        RelationshipConstants.ACTION_RESTRICT  => FkAction.Restrict,
        RelationshipConstants.ACTION_NO_ACTION => (FkAction?)null, // omit to match introspection's normalization
        _                                       => null,
    };

    /// <summary>Renders an <see cref="FkAction"/> to its SQL keyword form.</summary>
    public static string FkActionSql(FkAction a) => a switch
    {
        FkAction.Cascade  => "CASCADE",
        FkAction.SetNull  => "SET NULL",
        FkAction.Restrict => "RESTRICT",
        FkAction.NoAction => "NO ACTION",
        _ => throw new InvalidOperationException($"unhandled FkAction: {a}"),
    };
}
