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
    /// Resolve a single super reference string against a tree.
    /// </summary>
    /// <param name="reference">
    /// The raw super reference (e.g. "Fruit", "::pkg::Name", "..::common::id").
    /// </param>
    /// <param name="contextPackage">
    /// The package of the model whose super is being resolved.
    /// </param>
    /// <param name="root">The root MetaData of the accumulating tree to search within.</param>
    /// <returns>The resolved MetaData, or null if the reference cannot be resolved.</returns>
    public static MetaData? ResolveSuperRef(string reference, string contextPackage, MetaData root)
    {
        // ---------------------------------------------------------------------
        // 1. Absolute reference: leading "::"
        // ---------------------------------------------------------------------
        if (reference.StartsWith(Constants.PACKAGE_SEPARATOR, StringComparison.Ordinal))
        {
            string absolutePath = reference[Constants.PACKAGE_SEPARATOR.Length..];
            return FindInTree(root, absolutePath);
        }

        // ---------------------------------------------------------------------
        // 2. Relative reference: one or more leading "..::"
        // ---------------------------------------------------------------------
        if (reference.StartsWith(Constants.PACKAGE_PARENT + Constants.PACKAGE_SEPARATOR,
                StringComparison.Ordinal))
        {
            string[] parts = Split(reference);
            int levels = 0;
            while (levels < parts.Length && parts[levels] == Constants.PACKAGE_PARENT)
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
            return FindInTree(root, string.Join(Constants.PACKAGE_SEPARATOR, allParts));
        }

        // ---------------------------------------------------------------------
        // 3. Bare name OR same-package shorthand (contains "::" but no leading
        //    "::" or "..::"): try contextPackage prepend first, then root-rooted.
        // ---------------------------------------------------------------------
        if (contextPackage != "")
        {
            MetaData? found = FindInTree(root,
                $"{contextPackage}{Constants.PACKAGE_SEPARATOR}{reference}");
            if (found is not null) return found;
        }
        return FindInTree(root, reference);
    }

    /// <summary>
    /// Split a package path on the <c>::</c> separator. Mirrors the JS
    /// <c>String.prototype.split</c> on a multi-char separator.
    /// </summary>
    private static string[] Split(string value) =>
        value.Split(Constants.PACKAGE_SEPARATOR, StringSplitOptions.None);

    // -----------------------------------------------------------------------
    // Deferred resolution — second pass after all files parsed
    // -----------------------------------------------------------------------

    /// <summary>One node whose extends reference could not be resolved against the full tree.</summary>
    public sealed record DeferredSuperFailure(string NodeFqn, string Ref);

    /// <summary>
    /// Walk the tree, resolve every node's SuperRef against the full root,
    /// collect unresolved refs. Idempotent: nodes that already have SuperData set are skipped.
    /// Tracks an inherited context-package while walking so children whose own Package is
    /// unset still resolve correctly (mirroring the parser's eager-resolution semantics).
    /// </summary>
    public static IReadOnlyList<DeferredSuperFailure> ResolveDeferredSupers(MetaData root)
    {
        var failures = new List<DeferredSuperFailure>();
        Walk(root, "", (node, ctxPkg) =>
        {
            if (node.SuperRef is null) return;
            if (node.SuperData is not null) return;
            string effectivePkg = node.Package ?? ctxPkg;
            MetaData? target = ResolveSuperRef(node.SuperRef, effectivePkg, root);
            if (target is not null)
            {
                try
                {
                    node.SetSuperResolved(target);
                }
                catch (InvalidOperationException)
                {
                    // Frozen — ignore; the loader should resolve before freeze.
                }
            }
            else
            {
                failures.Add(new DeferredSuperFailure(node.Fqn(), node.SuperRef));
            }
        });
        return failures.AsReadOnly();
    }

    private static void Walk(MetaData node, string ctxPkg, Action<MetaData, string> visit)
    {
        visit(node, ctxPkg);
        string nextCtx = node.Package ?? ctxPkg;
        foreach (MetaData child in node.OwnChildren())
        {
            Walk(child, nextCtx, visit);
        }
    }
}
