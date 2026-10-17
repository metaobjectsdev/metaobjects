// super reference resolution (ADR-0059)
//
// An `extends` ref resolves through the same rules as every other reference
// (NamingRefs.OwnerCandidateKeys): `::Rest` root-absolute, `..::Rest` parent-relative,
// `pkg::Name` exact, bare `Name` in the declaring node's own file package, then root-level
// — never another package. The package context is the declaring node's effective package
// (`Package ?? FileDefaultPackage`).
//
// FR-024: a ref whose final `::`-segment is dotted (`pkg::Customer.id`) targets a child
// nested in the owner object — resolved type-scoped to the referrer.
//
// Super resolution is deferred by the loader (ResolveDeferredSupers); the parser calls
// ResolveSuperRef inline only when deferral is off.

using MetaObjects.Meta;
using MetaObjects.Shared;
using MetaObjects.Core.Identity;

namespace MetaObjects;

/// <summary>
/// Super reference resolution helpers — package navigation against a tree.
/// </summary>
internal static class SuperResolve
{
    // -----------------------------------------------------------------------
    // Tree search helper
    // -----------------------------------------------------------------------

    /// <summary>
    /// The top-level node (a direct child of <paramref name="root"/>) whose resolution key is
    /// exactly <paramref name="key"/> — <c>&lt;package | fileDefaultPackage&gt;::&lt;name&gt;</c>, or
    /// the bare name for a root-level node. The key is captured at parse time, so the match does
    /// not depend on load order or post-merge tree shape. Exact only (ADR-0059 R2).
    /// </summary>
    private static MetaData? FindTopLevel(MetaData root, string key)
    {
        // ADR-0039: OwnChildren — super-resolution reads the PHYSICAL declaration layer; the
        // root has no super, so its own children are its children.
        foreach (MetaData child in root.OwnChildren())
            if (child.Name != "" && child.ResolutionKey() == key) return child;
        return null;
    }

    // -----------------------------------------------------------------------
    // Reference parsing & resolution
    // -----------------------------------------------------------------------

    /// <summary>
    /// FR-024 (ADR-0029): the type-scope of the node whose <c>extends</c> is being
    /// resolved. A dotted <c>Entity.child</c> ref selects among the owner's children of
    /// the SAME type as the referrer — a field ref resolves fields, an identity
    /// ref resolves identities. Required for the dotted branch; ignored for
    /// dot-free refs (legacy behavior unchanged).
    /// </summary>
    public sealed record ReferrerScope(string Type);

    /// <summary>
    /// FR-024: true when a ref's final <c>::</c>-segment contains a <c>.</c> — i.e. the ref
    /// targets a child nested inside an object (<c>Customer.id</c>,
    /// <c>acme::sales::Customer.id</c>). Names cannot contain <c>.</c>, so this is
    /// unambiguous. Call sites use this to apply the dotted-only
    /// type/subtype-mismatch check (ERR_EXTENDS_TARGET_MISMATCH) without altering
    /// shipped top-level extends behavior.
    /// </summary>
    public static bool IsChildTargetingRef(string reference)
    {
        int lastSep = reference.LastIndexOf(PACKAGE_SEPARATOR, StringComparison.Ordinal);
        string lastSegment = lastSep == -1 ? reference : reference[(lastSep + PACKAGE_SEPARATOR.Length)..];
        return lastSegment.Contains(CHILD_REF_SEPARATOR, StringComparison.Ordinal);
    }

    /// <summary>
    /// Whether a dotted <c>extends</c> target is acceptable for the extending node.
    ///
    /// Type must match exactly. Subtype must match too — with ONE exception, on identities
    /// (#310). For an identity, subtype equality was answering the wrong question: it read
    /// as "the same kind of thing", but ADR-0040 encodes uniqueness in the TYPE, so
    /// primary and secondary are both UNIQUE KEYS and differ only in which one the entity
    /// nominated as its main handle. Borrowing a key borrows uniqueness, not that
    /// nomination — so a read model may key off a business key the entity models as
    /// identity.secondary while never surfacing its surrogate identity.primary at all.
    ///
    /// identity.reference is excluded on both sides: a foreign key is not unique, so it
    /// can never back a borrowed key.
    ///
    /// Shared because there are TWO doors — this module's deferred resolution and
    /// Parser's eager check. They held independent copies of the boolean, so a change to
    /// one silently left the other enforcing the old rule.
    /// </summary>
    public static bool ExtendsTargetCompatible(MetaData node, MetaData target)
    {
        if (target.Type != node.Type) return false;
        if (target.SubType == node.SubType) return true;
        return node.Type == BaseTypes.TYPE_IDENTITY
            && IdentityConstants.IDENTITY_UNIQUE_KEY_SUBTYPES.Contains(node.SubType)
            && IdentityConstants.IDENTITY_UNIQUE_KEY_SUBTYPES.Contains(target.SubType);
    }

    /// <summary>
    /// The one wording for ERR_EXTENDS_TARGET_MISMATCH, shared by both doors and mirrored
    /// in the other three ports.
    /// </summary>
    public const string EXTENDS_TARGET_MISMATCH_RULE =
        "a dotted extends must target a node of the same type and subtype — the one exception " +
        "is an identity, which may extend any UNIQUE key (identity.primary or identity.secondary)";

    /// <summary>
    /// FR-024: split a child-targeting ref into the root-object ref and the child
    /// traversal path. The addressing model: a package qualifies the ROOT-level
    /// node only; every subsequent dotted segment traverses CHILD NAMES to any
    /// depth (<c>Customer.id</c>, <c>Customer.priceCents.display</c> — object →
    /// field → view). Returns null for degenerate empty parts (<c>.id</c>,
    /// <c>Customer.</c>, <c>Customer..x</c>).
    /// </summary>
    private static (string OwnerRef, string[] Path)? ParseChildTargetingRef(string reference)
    {
        int lastSep = reference.LastIndexOf(PACKAGE_SEPARATOR, StringComparison.Ordinal);
        int segStart = lastSep == -1 ? 0 : lastSep + PACKAGE_SEPARATOR.Length;
        string lastSegment = reference[segStart..];
        string[] parts = lastSegment.Split(CHILD_REF_SEPARATOR, StringSplitOptions.None);
        if (parts.Length < 2 || Array.Exists(parts, p => p == "")) return null;
        return (reference[..segStart] + parts[0], parts[1..]);
    }

    /// <summary>
    /// Resolve a single super reference string against a tree.
    ///
    /// <para>
    /// FR-024 (ADR-0029): a ref whose final segment is dotted (<c>Customer.id</c>)
    /// targets a child nested inside an object. The owner part resolves with the
    /// existing strategies (absolute / relative / bare / same-package); the child
    /// is then selected among the owner's EFFECTIVE children (so inherited
    /// children resolve) by name AND the referrer's type (type-scoped). A dotted
    /// ref that does not resolve returns null WITHOUT falling through to the
    /// bare lookup; a dotted ref with no <paramref name="referrerScope"/> is unresolvable.
    /// </para>
    /// </summary>
    /// <param name="reference">
    /// The raw super reference (e.g. "Fruit", "::pkg::Name", "..::common::id", "Customer.id").
    /// </param>
    /// <param name="contextPackage">
    /// The package of the model whose super is being resolved.
    /// </param>
    /// <param name="root">The root MetaData of the accumulating tree to search within.</param>
    /// <param name="referrerScope">FR-024: the extending node's type — required to resolve dotted refs.</param>
    /// <returns>The resolved MetaData, or null if the reference cannot be resolved.</returns>
    /// <exception cref="RefOverDropException">A <c>..::</c> ref drops more segments than the package has.</exception>
    public static MetaData? ResolveSuperRef(
        string reference,
        string contextPackage,
        MetaData root,
        ReferrerScope? referrerScope = null)
    {
        // ---------------------------------------------------------------------
        // 0. FR-024 dotted child-targeting ref: `<rootRef>.<child>...<child>`
        //
        // Addressing model (ADR-0029): the package qualifies the ROOT-level node
        // only; each subsequent segment traverses CHILD NAMES to any depth
        // (object → field → view: `Customer.priceCents.display`). INTERMEDIATE
        // segments select by UNIQUE name among the current node's effective
        // children (a cross-type name collision is ambiguous → unresolved); the
        // FINAL segment is type-scoped to the referrer. Mirrors the TS reference.
        // ---------------------------------------------------------------------
        if (IsChildTargetingRef(reference))
        {
            if (referrerScope is null) return null;
            (string OwnerRef, string[] Path)? parsed = ParseChildTargetingRef(reference);
            if (parsed is null) return null; // degenerate (empty segment)
            MetaData? current = ResolveSuperRef(parsed.Value.OwnerRef, contextPackage, root);
            if (current is null) return null;
            for (int i = 0; i < parsed.Value.Path.Length - 1; i++)
            {
                string seg = parsed.Value.Path[i];
                var matches = current.Children().Where(c => c.Name == seg).ToList();
                if (matches.Count != 1) return null; // missing or ambiguous intermediate
                current = matches[0];
            }
            string last = parsed.Value.Path[^1];
            return current
                .Children()
                .FirstOrDefault(c => c.Name == last && c.Type == referrerScope.Type);
        }

        // ---------------------------------------------------------------------
        // A plain ref binds one top-level node by its form (ADR-0059 R2). An
        // over-dropping `..::` throws RefOverDropException; the deferred pass reports it.
        // ---------------------------------------------------------------------
        foreach (string key in NamingRefs.OwnerCandidateKeys(reference, contextPackage))
        {
            MetaData? found = FindTopLevel(root, key);
            if (found is not null) return found;
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // Deferred resolution — second pass after all files parsed
    // -----------------------------------------------------------------------

    /// <summary>
    /// FR-024: why deferred super resolution failed.
    /// <list type="bullet">
    /// <item><see cref="Unresolved"/> — no target found (loader emits ERR_UNRESOLVED_SUPER).</item>
    /// <item><see cref="TargetMismatch"/> — a dotted child-targeting ref resolved, but the
    /// target's type/subtype differs from the extending node's (loader emits
    /// ERR_EXTENDS_TARGET_MISMATCH). Applies ONLY to dotted refs — top-level
    /// extends behavior is unchanged.</item>
    /// </list>
    /// </summary>
    public enum SuperFailureKind
    {
        Unresolved,
        TargetMismatch,
        /// <summary>A <c>..::</c> ref drops more package segments than the declaring node's package has
        /// (ADR-0059 R2; loader emits ERR_BAD_ATTR_VALUE).</summary>
        OverDrop,
    }

    /// <summary>A node's type + subType identity, for the target-mismatch message.</summary>
    public sealed record TypeIdentity(string Type, string SubType);

    /// <summary>One node whose extends reference could not be resolved against the full tree.
    /// <see cref="Node"/> is the offending referrer node (useful for FR5a / ADR-0009 to
    /// attach <c>node.Source</c> to the loader error envelope).
    /// FR-024: <see cref="Kind"/> distinguishes unresolved refs from dotted target-mismatch;
    /// <see cref="Target"/> / <see cref="Referrer"/> are populated for target-mismatch only.</summary>
    public sealed record DeferredSuperFailure(
        string NodeFqn,
        string Ref,
        MetaData? Node = null,
        SuperFailureKind Kind = SuperFailureKind.Unresolved,
        TypeIdentity? Target = null,
        TypeIdentity? Referrer = null);

    /// <summary>
    /// Resolve every node's SuperRef against the full root, collecting unresolved
    /// refs. Idempotent: nodes that already have SuperData set are skipped.
    ///
    /// <para>
    /// #188: super-resolution is ORDER-INDEPENDENT. The prior implementation
    /// resolved each SuperRef in a single pre-order walk — physical (= load)
    /// order. A dotted ref to an INHERITED member (<c>extends: Owner.member</c>
    /// where Owner inherits <c>member</c> via its OWN <c>extends</c>) reads the
    /// owner's EFFECTIVE <see cref="MetaData.Children"/> — inherited members appear
    /// only once the owner's extends chain is resolved. So it succeeded only when
    /// the owner happened to resolve first: green under one directory-scan order,
    /// ERR_UNRESOLVED_SUPER under another. Instead resolve ON DEMAND with
    /// memoization + cycle detection (topological): before a dotted ref reads the
    /// owner's children, resolve the owner's whole chain first, and after resolving
    /// a node also resolve its target's chain (multi-level inheritance). The result
    /// is a pure function of the source SET, independent of enumeration order.
    /// </para>
    ///
    /// <para>
    /// An inherited context-package is threaded while collecting the pending set so
    /// children whose own Package is unset still resolve correctly (mirroring the
    /// parser's eager-resolution semantics); it is captured per node so a node
    /// resolved out of collection order still uses the correct package.
    /// </para>
    /// </summary>
    public static IReadOnlyList<DeferredSuperFailure> ResolveDeferredSupers(MetaData root)
    {
        var failures = new List<DeferredSuperFailure>();

        // Every SuperRef-bearing node over the PHYSICAL declaration tree. Each node's package
        // context is its own (ADR-0059 R3): `Package ?? FileDefaultPackage`, so a node resolves
        // in the file that declared it, not in the first file's package.
        var pending = new List<MetaData>();
        Walk(root, node =>
        {
            if (node.SuperRef is not null) pending.Add(node);
        });

        // ADR-0059 R2: an over-dropping `..::` is a bad value, not a missing target.
        const string overDrop = "over-drop";
        object? TryResolve(string reference, string pkg, ReferrerScope? scope = null)
        {
            try { return ResolveSuperRef(reference, pkg, root, scope); }
            catch (RefOverDropException) { return overDrop; }
        }

        // Nodes already attempted this pass. On-demand resolution can reach a node
        // via the `pending` loop AND via owner/target recursion — `attempted` makes
        // each node resolve (and, on failure, report) EXACTLY ONCE, restoring the
        // single-visit walk's no-duplicate-failures guarantee (a successful node is
        // deduped by SuperData; this also covers the FAILURE path, which sets no
        // marker). It is also the cycle guard: `attempted` is never removed, so a
        // genuine super cycle (A→B→A) terminates on re-entry to the
        // already-attempted node rather than recursing forever. Mirrors the TS
        // reference (#188).
        var attempted = new HashSet<MetaData>(ReferenceEqualityComparer.Instance);

        void ResolveNode(MetaData node)
        {
            if (node.SuperRef is null || node.SuperData is not null) return;
            if (!attempted.Add(node)) return; // already resolved-or-failed this pass — never re-report
            string effectivePkg = NamingRefs.EffectivePackageOf(node);

            // For a dotted child-targeting ref, ResolveSuperRef reads the OWNER's
            // effective Children() — which includes inherited members only once the
            // owner's own extends chain is resolved. Resolve the owner node's chain
            // FIRST (memoized), regardless of collection order.
            if (IsChildTargetingRef(node.SuperRef))
            {
                (string OwnerRef, string[] Path)? parsed = ParseChildTargetingRef(node.SuperRef);
                if (parsed is not null)
                {
                    if (TryResolve(parsed.Value.OwnerRef, effectivePkg) is MetaData ownerNode) ResolveNode(ownerNode);
                }
            }

            // FR-024: thread the referrer's type so dotted `Entity.child` refs resolve
            // type-scoped (a field ref selects fields; an identity ref identities).
            object? resolved = TryResolve(node.SuperRef, effectivePkg, new ReferrerScope(node.Type));
            if (ReferenceEquals(resolved, overDrop))
            {
                failures.Add(new DeferredSuperFailure(node.Fqn(), node.SuperRef, node, SuperFailureKind.OverDrop));
                return;
            }
            MetaData? target = resolved as MetaData;

            if (target is not null)
            {
                // FR-024: a dotted ref must target a node of the SAME type and subtype
                // as the extending node. Dotted-only — top-level extends is unchanged.
                if (IsChildTargetingRef(node.SuperRef) && !ExtendsTargetCompatible(node, target))
                {
                    failures.Add(new DeferredSuperFailure(
                        node.Fqn(),
                        node.SuperRef,
                        node,
                        SuperFailureKind.TargetMismatch,
                        new TypeIdentity(target.Type, target.SubType),
                        new TypeIdentity(node.Type, node.SubType)));
                    return;
                }
                try
                {
                    node.SetSuperResolved(target);
                }
                catch (InvalidOperationException)
                {
                    // Frozen — ignore; the loader should resolve before freeze.
                }
                // Ensure the target's OWN chain is resolved too, so a later Children()
                // read on `node` (codegen/validation) sees the full multi-level
                // inherited set (e.g. Base extends AbstractRoot). Memoized — no re-work.
                ResolveNode(target);
            }
            else
            {
                failures.Add(new DeferredSuperFailure(node.Fqn(), node.SuperRef, node));
            }
        }

        foreach (var node in pending) ResolveNode(node);
        return failures.AsReadOnly();
    }

    private static void Walk(MetaData node, Action<MetaData> visit)
    {
        visit(node);
        // ADR-0039: OwnChildren — this is a declaration-structure walk internal to
        // super-resolution; it must visit only physically-declared children.
        foreach (MetaData child in node.OwnChildren())
        {
            Walk(child, visit);
        }
    }
}
