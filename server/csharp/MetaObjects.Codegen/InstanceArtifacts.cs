// instance-artifacts — the single predicate gate for "does this entity produce
// instance/write artifacts?" Mirrors codegen-ts's instance-artifacts module
// (commit 39f2df9f).
//
// An abstract entity (`abstract: true`) contributes shape via inheritance only:
// it must NEVER produce instance/write artifacts — no EF entity mapping, no
// DbSet<> registration, no CRUD routes, no filter allowlist, no CREATE TABLE DDL.
// Every instance/write generator routes its filter through
// EmitsInstanceArtifacts so the invariant holds in exactly one place.

using MetaObjects.Meta;

namespace MetaObjects.Codegen;

/// <summary>Predicate gate for instance/write artifact emission.</summary>
public static class InstanceArtifacts
{
    /// <summary>True iff <paramref name="entity"/> is abstract (shape-only).</summary>
    public static bool IsAbstract(MetaObject entity) => entity.IsAbstract;

    /// <summary>
    /// True iff <paramref name="entity"/> may produce instance/write artifacts
    /// (EF mapping, DbSet, routes, filter allowlist, CREATE TABLE). Abstract
    /// entities are excluded unconditionally.
    /// </summary>
    public static bool EmitsInstanceArtifacts(MetaObject entity) => !entity.IsAbstract;
}
