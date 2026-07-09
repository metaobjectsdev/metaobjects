// super reference resolution — package navigation helpers
//
// Ported from typescript/packages/metadata/src/super-resolve.ts.
//
// Reference syntax (Java metaobjects-core conventions):
//   Bare name       "Fruit"            → resolve in contextPackage, then root fallback
//   Absolute        "::fishstore::Fish" → strip leading ::, walk from root
//   Relative parent "..::common::id"   → up one package level, then resolve "common::id"
//   Multi-level     "..::..::shared::User" → up two levels, then resolve "shared::User"
//   Same-package    "common::id"       → try contextPackage prepend first, then root-rooted
//
// Super resolution is IMMEDIATE during parse (Java behavior). This module
// provides only the lookup helper; the parser calls it inline. The deferred
// multi-pass walker (resolveDeferredSupers) is added in Task 5.1.

using MetaObjects.Meta;

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
    /// Recursively searches the tree for a node whose <see cref="MetaData.Fqn"/>
    /// matches. Returns the first match, or null.
    /// </summary>
    private static MetaData? FindInTree(MetaData root, string fqn)
    {
        if (root.Fqn() == fqn) return root;
        // Match by EFFECTIVE qualified key (file-default package folded onto the
        // bare name, captured at parse time) for nodes carrying no own package —
        // the cross-PACKAGE cross-file case. Mirrors the TS findInTree second
        // clause. The parser keeps an object's Fqn() bare for the FR5d
        // referrer-envelope contract, so this clause is what lets a fully-qualified
        // `extends: acme::common::BaseEntity` resolve against a `BaseEntity`
        // declared under `package: acme::common` in a separate file.
        if (root.Package is null && root.Name != "" && root.ResolutionKey() == fqn)
        {
            return root;
        }
        // ADR-0039: OwnChildren — super-resolution tree walk. This IS the extends-resolution
        // machinery, so it must traverse only the physically-declared children (resolving
        // Children() would recurse through the very super chain being built).
        foreach (MetaData child in root.OwnChildren())
        {
            MetaData? found = FindInTree(child, fqn);
            if (found is not null) return found;
        }
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
        // 1. Absolute reference: leading "::"
        // ---------------------------------------------------------------------
        if (reference.StartsWith(PACKAGE_SEPARATOR, StringComparison.Ordinal))
        {
            string absolutePath = reference[PACKAGE_SEPARATOR.Length..];
            return FindInTree(root, absolutePath);
        }

        // ---------------------------------------------------------------------
        // 2. Relative reference: one or more leading "..::"
        // ---------------------------------------------------------------------
        if (reference.StartsWith(PACKAGE_PARENT + PACKAGE_SEPARATOR,
                StringComparison.Ordinal))
        {
            string[] parts = Split(reference);
            int levels = 0;
            while (levels < parts.Length && parts[levels] == PACKAGE_PARENT)
            {
                levels++;
            }

            string[] pkgParts = contextPackage != "" ? Split(contextPackage) : [];
            string[] remainder = parts.Skip(levels).ToArray();
            if (pkgParts.Length < levels || remainder.Length == 0)
            {
                return null;
            }

            IEnumerable<string> allParts = pkgParts.Take(pkgParts.Length - levels).Concat(remainder);
            return FindInTree(root, string.Join(PACKAGE_SEPARATOR, allParts));
        }

        // ---------------------------------------------------------------------
        // 3. Bare name OR same-package shorthand (contains "::" but no leading
        //    "::" or "..::"): try contextPackage prepend first, then root-rooted.
        // ---------------------------------------------------------------------
        if (contextPackage != "")
        {
            MetaData? found = FindInTree(root,
                $"{contextPackage}{PACKAGE_SEPARATOR}{reference}");
            if (found is not null) return found;
        }
        return FindInTree(root, reference);
    }

    /// <summary>
    /// Split a package path on the <c>::</c> separator. Mirrors the JS
    /// <c>String.prototype.split</c> on a multi-char separator.
    /// </summary>
    private static string[] Split(string value) =>
        value.Split(PACKAGE_SEPARATOR, StringSplitOptions.None);

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

        // Every SuperRef-bearing node over the PHYSICAL declaration tree, plus each
        // node's effective context-package (node.Package ?? nearest-ancestor
        // package) — the same value the pre-order walk threaded.
        var pending = new List<MetaData>();
        var effectivePkgOf = new Dictionary<MetaData, string>(ReferenceEqualityComparer.Instance);
        Walk(root, "", (node, ctxPkg) =>
        {
            if (node.SuperRef is null) return;
            effectivePkgOf[node] = node.Package ?? ctxPkg;
            pending.Add(node);
        });

        // Cycle guard: a genuine super cycle is unresolvable → the node is left
        // unresolved and reported as a failure below.
        var inProgress = new HashSet<MetaData>(ReferenceEqualityComparer.Instance);
        // Nodes already attempted this pass. On-demand resolution can reach a node
        // via the `pending` loop AND via owner/target recursion — `attempted` makes
        // each node resolve (and, on failure, report) EXACTLY ONCE, restoring the
        // single-visit walk's no-duplicate-failures guarantee (a successful node is
        // deduped by SuperData; this also covers the FAILURE path, which sets no
        // marker). Mirrors the TS reference (#188).
        var attempted = new HashSet<MetaData>(ReferenceEqualityComparer.Instance);

        void ResolveNode(MetaData node)
        {
            if (node.SuperRef is null || node.SuperData is not null) return;
            if (!attempted.Add(node)) return; // already resolved-or-failed this pass — never re-report
            if (!inProgress.Add(node)) return; // cycle — leave unresolved; reported below
            string effectivePkg = effectivePkgOf.TryGetValue(node, out var pkg) ? pkg : (node.Package ?? "");

            // For a dotted child-targeting ref, ResolveSuperRef reads the OWNER's
            // effective Children() — which includes inherited members only once the
            // owner's own extends chain is resolved. Resolve the owner node's chain
            // FIRST (memoized), regardless of collection order.
            if (IsChildTargetingRef(node.SuperRef))
            {
                (string OwnerRef, string[] Path)? parsed = ParseChildTargetingRef(node.SuperRef);
                if (parsed is not null)
                {
                    MetaData? ownerNode = ResolveSuperRef(parsed.Value.OwnerRef, effectivePkg, root);
                    if (ownerNode is not null) ResolveNode(ownerNode);
                }
            }

            // FR-024: thread the referrer's type so dotted `Entity.child` refs resolve
            // type-scoped (a field ref selects fields; an identity ref identities).
            MetaData? target = ResolveSuperRef(node.SuperRef, effectivePkg, root, new ReferrerScope(node.Type));
            inProgress.Remove(node);

            if (target is not null)
            {
                // FR-024: a dotted ref must target a node of the SAME type and subtype
                // as the extending node. Dotted-only — top-level extends is unchanged.
                if (IsChildTargetingRef(node.SuperRef) &&
                    (target.Type != node.Type || target.SubType != node.SubType))
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

    private static void Walk(MetaData node, string ctxPkg, Action<MetaData, string> visit)
    {
        visit(node, ctxPkg);
        string nextCtx = node.Package ?? ctxPkg;
        // ADR-0039: OwnChildren — this is a declaration-structure walk internal to
        // super-resolution; it must visit only physically-declared children.
        foreach (MetaData child in node.OwnChildren())
        {
            Walk(child, nextCtx, visit);
        }
    }
}
