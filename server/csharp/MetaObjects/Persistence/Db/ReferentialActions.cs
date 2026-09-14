// ReferentialActions — resolve the ON DELETE / ON UPDATE actions for a foreign key
// inferred from an identity.reference (ADR-0047).
//
// Ported 1:1 from typescript/packages/migrate-ts/src/referential-actions.ts, which is
// the cross-port SSOT for this precedence. TypeScript owns schema migrations (ADR-0015),
// so the DDL the database actually carries is produced there; this port exists so the C#
// EF Core model can agree with that DDL instead of falling back to EF's own convention
// (#294). Any change to the precedence belongs in BOTH files.

using MetaObjects.Core.Relationship;
using MetaObjects.Meta;

namespace MetaObjects.Persistence.Db;

/// <summary>
/// The resolved referential actions for one foreign key. A null member means
/// "emit no clause" — which includes an explicit <c>no-action</c>, since that IS
/// the database default (see <see cref="ReferentialActions.Resolve"/>).
/// </summary>
public readonly record struct ResolvedReferentialActions(string? OnDelete, string? OnUpdate);

/// <summary>
/// Resolves the referential actions carried by an <c>identity.reference</c>, applying
/// the ADR-0047 precedence shared by every port.
/// </summary>
public static class ReferentialActions
{
    /// <summary>
    /// Resolve the referential actions for the foreign key defined by
    /// <paramref name="reference"/> on <paramref name="entity"/>.
    ///
    /// <para>Precedence (highest first):</para>
    /// <list type="number">
    ///   <item><c>@onDelete</c> / <c>@onUpdate</c> declared DIRECTLY on the
    ///     identity.reference — the reference IS the FK, so the action may be declared
    ///     right where the FK is.</item>
    ///   <item>A correlated sibling relationship on the same entity — matched
    ///     package-aware against the resolved <c>@references</c> target
    ///     (<see cref="NamingRefs.RefMatchesObject"/> / ADR-0042, so bare and FQN forms
    ///     pair correctly); an M:N relationship (<c>@through</c>) never correlates with a
    ///     direct FK. Its explicit <c>@onDelete</c>, else its subtype default
    ///     (composition→cascade, aggregation→set-null, association→restrict);
    ///     onUpdate defaults to cascade.</item>
    ///   <item>A correlated REVERSE relationship on the TARGET entity — the documented
    ///     parent-side authoring shape ("Program owns weeks"). Same resolution as tier 2,
    ///     with the guards described on <see cref="FindReverseRelationship"/>.</item>
    ///   <item>None → null (no ON DELETE / ON UPDATE clause).</item>
    /// </list>
    ///
    /// <para>Resolved <c>no-action</c> → null: it is the database default, so emitting it
    /// would add a clause that changes nothing (and, on the TS side, would dirty
    /// introspection round-trips).</para>
    ///
    /// <para>When more than one relationship targets the same entity (Match.homeTeam /
    /// awayTeam both -> Team), each is correlated to its OWN identity.reference via the
    /// shared relationship&lt;-&gt;reference ladder (#368 round 2) — never the first
    /// match. When the correlation is genuinely ambiguous, it contributes nothing rather
    /// than an arbitrary — possibly wrong — action (see the tier-2/tier-3 bodies below for
    /// the exact rules).</para>
    /// </summary>
    public static ResolvedReferentialActions Resolve(MetaObject entity, MetaReferenceIdentity reference)
    {
        var target = reference.TargetEntity;
        if (target is null) return new ResolvedReferentialActions(null, null);

        // (1) Actions declared directly on the FK-defining reference win.
        var refOnDelete = reference.OnDelete;
        var refOnUpdate = reference.OnUpdate;

        // Resolve the reference's target ONCE, package-aware (ADR-0042: a bare
        // @references resolves in the DECLARING owner's package). Both relationship tiers
        // then correlate against the resolved NODE, so a bare @references pairs correctly
        // with an FQN @objectRef and vice versa.
        var root = entity.Parent;
        var refOwner = reference.Parent ?? entity;
        var targetObj = root is not null
            ? NamingRefs.ResolveObjectRef(root, target, NamingRefs.EffectivePackage(refOwner)) as MetaObject
            : null;

        // (2) A sibling relationship on the FK-owning entity. An M:N relationship
        //     (@through) never correlates — it describes the junction path, not this
        //     direct FK. When the target does not resolve (dangling @references — normally
        //     a load error), fall back to an exact-string match so behavior on
        //     partially-valid trees is unchanged.
        //
        //     #368 (round 2): `entity` may declare MORE THAN ONE relationship to this
        //     SAME target (Match.homeTeam / awayTeam both -> Team). Matching `r` on the
        //     target alone can't say which FK `r` supplies actions FOR — every FK past
        //     the first silently inherited the first relationship's actions. Resolve it
        //     with the INVERSE of the relationship->reference ladder
        //     (RelationshipReferences.ResolveRelationshipReference): `r` belongs to
        //     `reference` iff the ladder, applied to `r`, resolves back to `reference`
        //     itself — not merely "resolves to *some* reference on this target". `r` and
        //     `reference` are always declared on the same `entity`, the exact shape the
        //     ladder is built for, so this is a direct inversion, not a second parallel
        //     rule.
        var rel = entity.Relationships().FirstOrDefault(r =>
        {
            if (r.Through is not null) return false;
            var objectRef = r.ObjectRef;
            if (objectRef is null) return false;
            if (targetObj is null) return objectRef == target;
            if (!NamingRefs.RefMatchesObject(
                    targetObj, objectRef, NamingRefs.EffectivePackage(r.Parent ?? entity)))
                return false;
            return ReferenceEquals(
                RelationshipReferences.ResolveRelationshipReference(entity, r.Name, objectRef, r.SourceRefField),
                reference);
        });

        // (3) Failing that, the REVERSE relationship declared on the TARGET entity.
        //     When the tier-3 satisfiability guard fires, the reverse relationship's
        //     AUTHORED @onUpdate still applies (only the inferred contributions drop).
        string? suppressedReverseOnUpdate = null;
        if (rel is null && targetObj is not null)
        {
            var reverse = FindReverseRelationship(entity, reference, targetObj);
            // Tier-3 satisfiability guard: an INFERRED set-null default (a parent-side
            // aggregation with no explicit @onDelete) is unsatisfiable when any FK column
            // is NOT NULL — SET NULL cannot fire there, and letting it through would break
            // a previously-valid model purely because the correlation got smarter. An
            // inferred default never breaks a model: the INFERRED contributions drop
            // (today's bare FK), while anything the author explicitly wrote survives — an
            // EXPLICIT @onDelete: "set-null" flows through (the author asked for it), and
            // an EXPLICIT @onUpdate is honored (dropping it would be the original bug).
            if (reverse is not null)
            {
                var unsatisfiableInferredSetNull =
                    reverse.OnDelete is null
                    && ON_DELETE_DEFAULT_BY_SUBTYPE.TryGetValue(reverse.SubType, out var def)
                    && def == ACTION_SET_NULL
                    && ReadIdentityFields(reference).Any(n =>
                        entity.FindField(n) is { IsRequired: true });

                if (unsatisfiableInferredSetNull)
                    suppressedReverseOnUpdate = reverse.OnUpdate;
                else
                    rel = reverse;
            }
        }

        var onDeleteRaw = refOnDelete ?? rel?.EffectiveOnDelete;
        var onUpdateRaw = refOnUpdate ?? (rel is not null ? rel.EffectiveOnUpdate : suppressedReverseOnUpdate);

        return new ResolvedReferentialActions(Normalize(onDeleteRaw), Normalize(onUpdateRaw));
    }

    /// <summary>
    /// Tier-3 correlation: the relationship declared on the TARGET (parent) entity
    /// pointing back at the FK-owning entity — the shape the docs and the authoring skill
    /// teach ("Author owns posts": a to-many composition on Author, while Post owns the FK).
    ///
    /// <para>Guards (each fails closed to "no contribution"):</para>
    /// <list type="bullet">
    ///   <item>An M:N relationship (<c>@through</c>) never correlates — it describes the
    ///     junction path, not this direct FK (the junction's own FKs correlate via its own
    ///     identity.reference children). The same guard applies at tier 2.</item>
    ///   <item>When the FK-owning entity holds more than one enforced reference to the same
    ///     target, the reverse relationship cannot say WHICH FK carries the ownership edge,
    ///     so it contributes to none of them (arming every FK could cascade through an edge
    ///     the author never designated).</item>
    ///   <item>When the TARGET entity declares more than one non-<c>@through</c>
    ///     relationship back at <paramref name="entity"/> (rare — e.g. a "posts"
    ///     composition and a separate "latestPost" association both <c>@objectRef</c>-ing
    ///     Post), no candidate is preferred: this is the tier-2 ambiguity's mirror image
    ///     (multiple RELATIONSHIPS rather than multiple REFERENCES), and it cannot be
    ///     resolved by the relationship-&gt;reference ladder — that ladder picks among
    ///     references declared on the SAME object as the relationship, whereas here the
    ///     candidate relationships live on <c>targetObj</c> while <paramref name="reference"/>
    ///     lives on <paramref name="entity"/>, a different object, so the ladder has no
    ///     candidates to apply to. Previously this used the FIRST match (the same
    ///     silently-wrong-schema defect as tier 2); it now fails closed like the guard
    ///     above, once the ambiguity guard above has already established
    ///     <paramref name="reference"/> is the entity's only candidate reference to this
    ///     target.</item>
    /// </list>
    /// </summary>
    private static MetaRelationship? FindReverseRelationship(
        MetaObject entity, MetaReferenceIdentity reference, MetaObject targetObj)
    {
        var root = entity.Parent;
        if (root is null) return null;

        // Ambiguity guard: exactly one enforced reference from `entity` to this target,
        // and it must be `reference` itself.
        var refsToTarget = entity.ReferenceIdentities().Where(r =>
        {
            if (!r.Enforce) return false;
            var t = r.TargetEntity;
            if (t is null) return false;
            return ReferenceEquals(
                NamingRefs.ResolveObjectRef(root, t, NamingRefs.EffectivePackage(r.Parent ?? entity)),
                targetObj);
        }).ToList();
        if (refsToTarget.Count != 1 || !ReferenceEquals(refsToTarget[0], reference)) return null;

        // The reverse relationship's bare @objectRef resolves in ITS declaring owner's
        // package (normally the target entity's own package).
        //
        // Fail closed on ambiguity rather than taking the first match: if more than one
        // non-@through relationship on targetObj resolves back to `entity`, none of them
        // is preferred (see the class doc above).
        var reverseCandidates = targetObj.Relationships().Where(r =>
        {
            if (r.Through is not null) return false; // M:N — junction path, not this FK
            var objectRef = r.ObjectRef;
            if (objectRef is null) return false;
            return NamingRefs.RefMatchesObject(
                entity, objectRef, NamingRefs.EffectivePackage(r.Parent ?? targetObj));
        }).ToList();
        return reverseCandidates.Count == 1 ? reverseCandidates[0] : null;
    }

    /// <summary>
    /// The field names forming an identity key. The canonical form is a string array;
    /// the comma-separated string form is accepted defensively, matching TS
    /// <c>readIdentityFields</c> (and the loader's own NormalizeIdentityFields).
    /// </summary>
    // ADR-0039: resolving Attr() — @fields may be inherited via the identity's extends.
    public static IReadOnlyList<string> ReadIdentityFields(MetaIdentity identity)
    {
        var raw = identity.Attr(IDENTITY_ATTR_FIELDS);
        if (raw is string s)
            return s.Split(',').Select(p => p.Trim()).Where(p => p.Length > 0).ToArray();
        if (raw is System.Collections.IEnumerable en)
            return en.Cast<object?>().Select(v => (v?.ToString() ?? "").Trim())
                     .Where(p => p.Length > 0).ToArray();
        return [];
    }

    /// <summary>
    /// Values are load-validated against REFERENTIAL_ACTIONS (allowedValues on both
    /// relationship.* and — since ADR-0047 — identity.reference), so only canonical
    /// kebab-case spellings reach this point.
    /// </summary>
    private static string? Normalize(string? action)
    {
        if (action is null) return null;
        if (action == ACTION_NO_ACTION) return null;
        return action;
    }
}
