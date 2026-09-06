// MetaObject — concrete node class for type=object nodes.
//
// Ported 1:1 from typescript/packages/metadata/src/meta/meta-object.ts.

namespace MetaObjects.Meta;

/// <summary>
/// Concrete node class for <c>object.*</c> nodes.
/// Extends <see cref="MetaData"/> directly: no model wrapper, no metaOf() indirection.
/// </summary>
public class MetaObject(TypeId typeId, string name) : MetaData(typeId, name)
{
    /// <summary>
    /// All effective <c>source.*</c> children (own + inherited via extends).
    /// Answers the same question as Java's <c>getSources(true)</c>, but NOT in the same
    /// ORDER: this delegates to <c>Children()</c> / EffectiveChildren, which starts from
    /// the super's list and appends non-overriding own children, so INHERITED sources come
    /// first (TypeScript's <c>_effectiveChildren</c> matches). Java concatenates own first,
    /// then walks the super chain. Order is not part of the contract — every consumer
    /// filters by role or kind — but a comment reasoning about "the first primary" has to
    /// name the right port.
    /// </summary>
    public IReadOnlyList<MetaSource> Sources()
    {
        return Cached("sources", () =>
            (IReadOnlyList<MetaSource>)Children()
                .OfType<MetaSource>()
                .ToArray());
    }

    /// <summary>Own <c>source.*</c> children only — no inheritance walk.</summary>
    public IReadOnlyList<MetaSource> OwnSources()
    {
        return Cached("ownSources", () =>
            (IReadOnlyList<MetaSource>)OwnChildren()
                .OfType<MetaSource>()
                .ToArray());
    }

    /// <summary>
    /// The primary writable <c>source.rdb</c> — the first effective source whose
    /// role is "primary" and kind is writable (table). Walks the extends chain so
    /// a projection (which declares its own read-only source) still inherits the
    /// parent entity's writable source. The ValidationPasses one-primary rule
    /// guarantees at most one primary per object (own-only).
    /// </summary>
    public MetaSource? FindPrimaryWritableSource()
    {
        // Run the primary-source DIVERGENCE refusal before answering — outside the memo,
        // so it runs on every call. DbTable resolves through this method, and DbTable is
        // read by the M:N RUNTIME resolver (MetaObjects.Codegen/Runtime/M2MResolver.
        // TableOf), which executes SQL against the answer and goes through no generator at
        // all — so while the refusal lived in CSharpNaming it never ran for that caller,
        // and a divergent object silently bound the inherited PARENT's relation. A refusal
        // that depends on which consumer asked is not a refusal. The narrowing below
        // stays: divergence is about the NAME, and this method additionally asks "is that
        // primary the WRITE target?".
        SourceResolution.RefuseDivergentPrimaries(this);
        return Cached("primaryWritableSource", () =>
            Sources().FirstOrDefault(s => s.Role == SOURCE_ROLE_PRIMARY && s.IsWritable()));
    }

    /// <summary>
    /// The primary read-only <c>source.rdb</c> — the first OWN source whose role
    /// is "primary" and kind is read-only (view/materializedView/storedProc/
    /// tableFunction). Own-only: a projection declares its own read-only source;
    /// the parent entity's writable source is reached via
    /// <see cref="FindPrimaryWritableSource"/>.
    /// </summary>
    public MetaSource? FindPrimaryReadOnlySource()
    {
        return Cached("primaryReadOnlySource", () =>
            OwnSources().FirstOrDefault(s => s.Role == SOURCE_ROLE_PRIMARY && s.IsReadOnly()));
    }

    /// <summary>
    /// The physical SQL name from the primary writable <c>source.rdb</c> via the
    /// FR-016 four-step rule on <see cref="MetaSource.PhysicalName"/>. Walks the
    /// extends chain. Replaces the legacy object-level <c>@dbTable</c> attr
    /// (dropped in source-v2). Returns null when the object has no primary
    /// writable source.
    /// </summary>
    public string? DbTable => Cached("dbTable", () =>
    {
        var src = FindPrimaryWritableSource();
        var name = src?.PhysicalName;
        return string.IsNullOrEmpty(name) ? null : name;
    });

    /// <summary>
    /// The physical SQL name from the primary read-only <c>source.rdb</c> via the
    /// FR-016 four-step rule on <see cref="MetaSource.PhysicalName"/>. Own-only —
    /// used for projections. Replaces the legacy object-level <c>@dbView</c> attr
    /// (dropped in source-v2). Returns null when the object has no primary
    /// read-only source.
    /// </summary>
    public string? DbView => Cached("dbView", () =>
    {
        var src = FindPrimaryReadOnlySource();
        var name = src?.PhysicalName;
        return string.IsNullOrEmpty(name) ? null : name;
    });

    /// <summary>
    /// True when this object is a read-only projection: it has a read-only primary
    /// source and no writable primary source (queries target the view; nothing to
    /// write). Write-through objects (a read-only and a writable primary) are NOT
    /// read-only projections — they're CQRS write-through.
    /// </summary>
    public bool IsReadOnlyProjection() =>
        OwnSources().Any(s => s.IsReadOnly()) && !OwnSources().Any(s => s.IsWritable());

    /// <summary>
    /// #214 (FR-024 §7) — true when this object is a WRITE-THROUGH entity read-view: it
    /// owns BOTH a writable-kind <c>source.rdb</c> (<c>@kind: table</c>) AND a read-only-kind
    /// <c>source.rdb</c> (<c>@kind: view</c> / materializedView / …). Writes route to the
    /// table; reads route to the (derived-field-carrying) replica view.
    /// OWN-only + role-agnostic (mirrors the TS reference <c>isWriteThrough</c>): a replica
    /// view carries <c>@role: replica</c>, so detection must NOT go through the primary-role
    /// <see cref="FindPrimaryWritableSource"/> / <see cref="FindPrimaryReadOnlySource"/>
    /// accessors — it classifies this object's OWN sources by <c>@kind</c>.
    /// A write-through object is therefore NOT an <see cref="IsReadOnlyProjection"/>.
    /// </summary>
    public bool IsWriteThrough() =>
        OwnSources().Any(s => s.IsWritable()) && OwnSources().Any(s => s.IsReadOnly());

    /// <summary>
    /// #214 (FR-024 §7) — the physical SQL name of the replica read-only source for a
    /// write-through entity: the first OWN read-only source's <see cref="MetaSource.PhysicalName"/>
    /// regardless of <c>@role</c>. Distinct from <see cref="DbView"/>, which requires the
    /// read-only source to be <c>@role: primary</c> (a projection) and so returns null for a
    /// <c>@role: replica</c> write-through view. Returns null when there is no own read-only source.
    /// </summary>
    public string? ReplicaViewName => Cached("replicaViewName", () =>
    {
        var name = ReplicaSource?.PhysicalName;
        return string.IsNullOrEmpty(name) ? null : name;
    });

    /// <summary>
    /// The source node <see cref="ReplicaViewName"/> names — ONE selection, so the view's
    /// name and its <c>@role</c> cannot be picked by two functions that agree until they do
    /// not. Hoisted out of <see cref="ReplicaViewName"/> because a second caller forced it:
    /// the <c>&lt;Entity&gt;Names</c> artifact keys its sources by ROLE, so a consumer
    /// reaching for a write-through entity's replica view has to know which role that view
    /// plays, and hardcoding <c>"replica"</c> would be a second derivation of what this
    /// accessor already decides. Mirrors the TS reference's <c>projectionViewSource</c>.
    /// </summary>
    public MetaSource? ReplicaSource => Cached("replicaSource", () =>
        OwnSources().FirstOrDefault(s => s.IsReadOnly()));

    /// <summary>True when the object's subtype is <c>entity</c>.</summary>
    public bool IsEntity() => SubType == OBJECT_SUBTYPE_ENTITY;

    /// <summary>True when the object's subtype is <c>value</c>.</summary>
    public bool IsValue() => SubType == OBJECT_SUBTYPE_VALUE;

    /// <summary>True when the object's subtype is <c>projection</c> (a derived read-only model).</summary>
    public bool IsProjection() => SubType == OBJECT_SUBTYPE_PROJECTION;

    // -------------------------------------------------------------------------
    // Fields
    // -------------------------------------------------------------------------

    /// <summary>All effective fields (own + inherited via extends).</summary>
    public IReadOnlyList<MetaField> Fields()
    {
        return Cached("fields", () =>
            (IReadOnlyList<MetaField>)Children()
                .Where(c => c is MetaField)
                .Cast<MetaField>()
                .ToArray());
    }

    /// <summary>Own fields only — excludes fields inherited via extends.</summary>
    public IReadOnlyList<MetaField> OwnFields()
    {
        return Cached("ownFields", () =>
            (IReadOnlyList<MetaField>)OwnChildren()
                .Where(c => c is MetaField)
                .Cast<MetaField>()
                .ToArray());
    }

    /// <summary>Find an effective field by name, or <see langword="null"/>.</summary>
    public MetaField? FindField(string fieldName)
    {
        return Cached($"findField:{fieldName}", () =>
            Fields().FirstOrDefault(f => f.Name == fieldName));
    }

    /// <summary>Java-parity alias for <see cref="FindField"/>.</summary>
    public MetaField? GetField(string fieldName) => FindField(fieldName);

    // -------------------------------------------------------------------------
    // Runtime instantiation (object model)
    // -------------------------------------------------------------------------

    /// <summary>
    /// Instantiate a backing object for this MetaObject (Java parity:
    /// <c>MetaObject.newInstance()</c>). Resolution order:
    ///
    ///   1. If <paramref name="registry"/> yields a factory for this object's
    ///      <see cref="MetaData.ResolutionKey"/>, invoke it; if the result is
    ///      <see cref="IMetaObjectAware"/>, attach this MetaObject as its back-reference.
    ///   2. Otherwise create a map-backed <see cref="ValueObject"/> (the unbound
    ///      default for <c>object.value</c>), which sets its own back-reference via
    ///      the constructor.
    ///
    /// The registry key is the object's package-folded <see cref="MetaData.ResolutionKey"/>
    /// (<c>package::name</c>) — the SAME form a nested field's <c>@objectRef</c> uses,
    /// so a factory registered for an object's resolution key is found whether
    /// instantiation is driven top-down or via an object-ref.
    ///
    /// AOT-safe: only registered <see cref="ObjectFactory"/> constructor delegates
    /// are consulted — no <c>Type.GetType</c> / <c>Activator</c> / reflection.
    /// </summary>
    public object NewInstance(ObjectClassRegistry? registry = null)
    {
        var reg = registry ?? ObjectClassRegistry.Default;
        var factory = reg.Resolve(ResolutionKey());
        if (factory is not null)
        {
            var instance = factory(this);
            if (instance is IMetaObjectAware aware)
            {
                aware.SetMetaData(this);
            }
            return instance;
        }
        return new ValueObject(this);
    }

    // -------------------------------------------------------------------------
    // Identities
    // -------------------------------------------------------------------------

    /// <summary>All effective identities (own + inherited via extends).</summary>
    public IReadOnlyList<MetaIdentity> Identities()
    {
        return Cached("identities", () =>
            (IReadOnlyList<MetaIdentity>)Children()
                .Where(c => c is MetaIdentity)
                .Cast<MetaIdentity>()
                .ToArray());
    }

    /// <summary>Own identities only — excludes inherited.</summary>
    public IReadOnlyList<MetaIdentity> OwnIdentities()
    {
        return Cached("ownIdentities", () =>
            (IReadOnlyList<MetaIdentity>)OwnChildren()
                .Where(c => c is MetaIdentity)
                .Cast<MetaIdentity>()
                .ToArray());
    }

    /// <summary>The single primary identity, if any.</summary>
    public MetaIdentity? PrimaryIdentity()
    {
        return Cached("primaryIdentity", () =>
            Identities().FirstOrDefault(i => i.SubType == IDENTITY_SUBTYPE_PRIMARY));
    }

    /// <summary>All secondary identities.</summary>
    public IReadOnlyList<MetaIdentity> SecondaryIdentities()
    {
        return Cached("secondaryIdentities", () =>
            (IReadOnlyList<MetaIdentity>)Identities()
                .Where(i => i.SubType == IDENTITY_SUBTYPE_SECONDARY)
                .ToArray());
    }

    /// <summary>All reference identities (foreign keys) — the FK-resolution source for codegen/migrate.</summary>
    public IReadOnlyList<MetaReferenceIdentity> ReferenceIdentities()
    {
        return Cached("referenceIdentities", () =>
            (IReadOnlyList<MetaReferenceIdentity>)Identities()
                .OfType<MetaReferenceIdentity>()
                .ToArray());
    }

    // -------------------------------------------------------------------------
    // Relationships
    // -------------------------------------------------------------------------

    /// <summary>All effective relationships (own + inherited via extends).</summary>
    public IReadOnlyList<MetaRelationship> Relationships()
    {
        return Cached("relationships", () =>
            (IReadOnlyList<MetaRelationship>)Children()
                .Where(c => c is MetaRelationship)
                .Cast<MetaRelationship>()
                .ToArray());
    }

    /// <summary>Own relationships only — excludes inherited.</summary>
    public IReadOnlyList<MetaRelationship> OwnRelationships()
    {
        return Cached("ownRelationships", () =>
            (IReadOnlyList<MetaRelationship>)OwnChildren()
                .Where(c => c is MetaRelationship)
                .Cast<MetaRelationship>()
                .ToArray());
    }

    // -------------------------------------------------------------------------
    // Indexes
    // -------------------------------------------------------------------------

    /// <summary>All effective lookup indexes (own + inherited via extends). ADR-0039: resolving.</summary>
    public IReadOnlyList<MetaIndex> LookupIndexes()
    {
        return Cached("lookupIndexes", () =>
            (IReadOnlyList<MetaIndex>)Children()
                .OfType<MetaIndex>()
                .ToArray());
    }

    /// <summary>Own lookup indexes only — excludes inherited.</summary>
    public IReadOnlyList<MetaIndex> OwnLookupIndexes()
    {
        return Cached("ownLookupIndexes", () =>
            // ADR-0039: own-accessor definition — the deliberate own-only API twin of
            // LookupIndexes(), and the same sanctioned use its identity/relationship siblings
            // have: codegen emitting a generated subclass, iterating own members so the ones
            // the parent's artifact already declares are not restated here.
            (IReadOnlyList<MetaIndex>)OwnChildren()
                .OfType<MetaIndex>()
                .ToArray());
    }

    // -------------------------------------------------------------------------
    // Validators
    // -------------------------------------------------------------------------

    /// <summary>All effective validators (own + inherited via extends).</summary>
    public IReadOnlyList<MetaValidator> Validators()
    {
        return Cached("validators", () =>
            (IReadOnlyList<MetaValidator>)Children()
                .Where(c => c is MetaValidator)
                .Cast<MetaValidator>()
                .ToArray());
    }

    /// <summary>Own validators only — excludes inherited.</summary>
    public IReadOnlyList<MetaValidator> OwnValidators()
    {
        return Cached("ownValidators", () =>
            (IReadOnlyList<MetaValidator>)OwnChildren()
                .Where(c => c is MetaValidator)
                .Cast<MetaValidator>()
                .ToArray());
    }

    // -------------------------------------------------------------------------
    // Layouts
    // -------------------------------------------------------------------------

    /// <summary>All effective layouts (own + inherited via extends).</summary>
    public IReadOnlyList<MetaLayout> Layouts()
    {
        return Cached("layouts", () =>
            (IReadOnlyList<MetaLayout>)Children()
                .Where(c => c is MetaLayout)
                .Cast<MetaLayout>()
                .ToArray());
    }

    /// <summary>Own layouts only — excludes inherited.</summary>
    public IReadOnlyList<MetaLayout> OwnLayouts()
    {
        return Cached("ownLayouts", () =>
            (IReadOnlyList<MetaLayout>)OwnChildren()
                .Where(c => c is MetaLayout)
                .Cast<MetaLayout>()
                .ToArray());
    }
}
