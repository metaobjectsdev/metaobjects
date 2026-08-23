// MetaRelationship — concrete node class for type=relationship nodes.
//
// Ported 1:1 from typescript/packages/metadata/src/meta/meta-relationship.ts.

namespace MetaObjects.Meta;

/// <summary>
/// Concrete node class for <c>relationship.*</c> nodes.
/// Extends <see cref="MetaData"/> directly: no model wrapper, no metaOf() indirection.
/// </summary>
// ADR-0039: every getter below uses the RESOLVING Attr() accessor — a relationship
// attr may be inherited from an abstract base via extends (reconciled with the
// resolving MetaIdentity getters).
public class MetaRelationship(TypeId typeId, string name) : MetaData(typeId, name)
{
    /// <summary>Relationship cardinality (e.g. <c>"one"</c> or <c>"many"</c>).</summary>
    public string? Cardinality
    {
        get
        {
            var v = Attr(RELATIONSHIP_ATTR_CARDINALITY);
            return v is string s ? s : null;
        }
    }

    /// <summary>FQN of the target object (e.g. <c>"acme::vehicle::Car"</c>).</summary>
    public string? ObjectRef
    {
        get
        {
            var v = Attr(RELATIONSHIP_ATTR_OBJECT_REF);
            return v is string s ? s : null;
        }
    }

    /// <summary>Junction (through) entity name for M:N relationships.</summary>
    public string? Through
    {
        get
        {
            var v = Attr(RELATIONSHIP_ATTR_THROUGH);
            return v is string s ? s : null;
        }
    }

    /// <summary>Source-side FK field on the junction (directed self-join disambiguator).</summary>
    public string? SourceRefField
    {
        get
        {
            var v = Attr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD);
            return v is string s ? s : null;
        }
    }

    /// <summary>Whether this M:N relationship is an undirected (symmetric) self-join.</summary>
    public bool Symmetric => Attr(RELATIONSHIP_ATTR_SYMMETRIC) is true;

    /// <summary>
    /// The effective FK referential action on parent delete — the explicit
    /// <c>@onDelete</c>, else the per-subtype default
    /// (<see cref="ON_DELETE_DEFAULT_BY_SUBTYPE"/>).
    /// </summary>
    public string EffectiveOnDelete =>
        OnDelete ?? (ON_DELETE_DEFAULT_BY_SUBTYPE.TryGetValue(SubType, out var def)
            ? def : ACTION_RESTRICT);

    /// <summary>
    /// The explicitly declared <c>@onDelete</c>, or null when absent. Mirrors TS
    /// <c>MetaRelationship.onDelete</c>: the ADR-0047 precedence has to tell "the author
    /// wrote an action" apart from "the subtype default applies", so the RAW value is a
    /// separate question from <see cref="EffectiveOnDelete"/>.
    /// </summary>
    // ADR-0039: resolving Attr() — @onDelete may be inherited via extends.
    public string? OnDelete =>
        Attr(RELATIONSHIP_ATTR_ON_DELETE) is string s && s.Length > 0 ? s : null;

    /// <summary>The explicitly declared <c>@onUpdate</c>, or null when absent.</summary>
    // ADR-0039: resolving Attr() — @onUpdate may be inherited via extends.
    public string? OnUpdate =>
        Attr(RELATIONSHIP_ATTR_ON_UPDATE) is string s && s.Length > 0 ? s : null;

    /// <summary>
    /// The effective FK referential action on parent key update — the explicit
    /// <c>@onUpdate</c>, else <see cref="ON_UPDATE_DEFAULT"/>.
    /// </summary>
    public string EffectiveOnUpdate => OnUpdate ?? ON_UPDATE_DEFAULT;
}
