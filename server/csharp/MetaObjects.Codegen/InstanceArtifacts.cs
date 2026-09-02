// instance-artifacts — the single predicate gate for "does this entity produce
// instance/write artifacts?" Mirrors codegen-ts's instance-artifacts module
// (commit 39f2df9f).
//
// TWO things make an object not a source of instance artifacts:
//
//   1. ABSTRACT (`abstract: true`) — it contributes shape via inheritance only:
//      it must NEVER produce instance/write artifacts — no EF entity mapping, no
//      DbSet<> registration, no CRUD routes, no filter allowlist, no CREATE TABLE DDL.
//
//   2. SOURCELESS — no declared/inherited `source.rdb` at all. #248 settled that DB
//      participation derives from a declared source, never from the object subtype,
//      and this port had the subtype-only test (`IsEntity() || DbView != null`)
//      duplicated across five gates with no source check anywhere in the chain. A
//      concrete `object.entity` declaring no source loads with ZERO errors (the
//      loader's one-primary-source rule fires only when an object declares ≥1
//      source), and it was getting a fabricated `[Table("<Name>")]`, a `DbSet<>`,
//      CRUD routes and a filter allowlist against a table nothing will ever create.
//      Mirrors the TS reference (codegen-ts's instance-artifacts.ts:
//      `emitsInstanceArtifacts = !isAbstract && hasAnyRdbSource`).
//
// Every instance/write generator routes its filter through EmitsInstanceArtifacts
// so the invariant holds in exactly one place.

using MetaObjects.Meta;
using static MetaObjects.Persistence.Source.SourceConstants;

namespace MetaObjects.Codegen;

/// <summary>Predicate gate for instance/write artifact emission.</summary>
public static class InstanceArtifacts
{
    /// <summary>True iff <paramref name="entity"/> is abstract (shape-only).</summary>
    public static bool IsAbstract(MetaObject entity) => entity.IsAbstract;

    /// <summary>
    /// True iff <paramref name="entity"/> declares (or inherits via <c>extends</c>)
    /// at least one <c>source.rdb</c> child of ANY kind — writable OR read-only.
    /// Zero sources means "not backed by any store" (the loader's own contract:
    /// zero sources is legal and means not persisted), so the DB-artifact tier must
    /// emit nothing for it. The any-kind sibling of the TS reference's
    /// <c>hasAnyRdbSource</c>.
    ///
    /// RESOLVING, not own-only (ADR-0039): an entity may inherit its source.rdb via
    /// <c>extends</c>, and an own-only read here would classify such an entity as
    /// sourceless and silently delete its table mapping.
    /// </summary>
    public static bool HasAnyRdbSource(MetaObject entity) =>
        entity.Sources().Any(s => s.SubType == SOURCE_SUBTYPE_RDB);

    /// <summary>
    /// True iff <paramref name="entity"/> may produce instance/write artifacts
    /// (EF mapping, DbSet, routes, filter allowlist, CREATE TABLE). Abstract
    /// entities are excluded unconditionally; so are sourceless ones (#248 — see
    /// the file header).
    /// </summary>
    public static bool EmitsInstanceArtifacts(MetaObject entity) =>
        !entity.IsAbstract && HasAnyRdbSource(entity);
}
