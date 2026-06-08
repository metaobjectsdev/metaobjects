// FR-021 — central resolver from (metadataPackage, typeName?) to per-port output
// identity (in C#, the namespace). Resolution order, evaluated for every named type:
//
//   1. Type-level override        — config.TypeOverrides["<pkg>::<typeName>"]
//   2. Package-level override     — config.PackageNamespaces[<pkg>]
//   3. Convention rule            — config.Convention (strip + prepend + case + separator)
//   4. Unmapped strategy fallback — config.UnmappedStrategy (Flatten | Error | Derive)
//
// All resolution happens via this single helper so the @provided enum resolver
// (FR-019), the entity/value-object namespace emitter (this generalization),
// and any future per-port consumer agree on the answer.

using System.Text;
using MetaObjects.Meta;

namespace MetaObjects.Codegen;

/// <summary>FR-021 — central package-binding resolver.</summary>
public static class PackageBindingResolver
{
    /// <summary>The metaobjects-standard package separator (cross-port invariant). Always <c>::</c>.</summary>
    public const string MetaPackageSeparator = "::";

    /// <summary>The metadata node's EFFECTIVE package — the file-default package captured at parse
    /// time, NOT just the node's own (rarely-set) <c>package:</c> attr. Mirrors the
    /// <c>PackageOf</c> pattern in FR-019: derive from <see cref="MetaData.ResolutionKey"/>
    /// by stripping the trailing <c>::&lt;name&gt;</c> suffix.</summary>
    public static string? EffectivePackage(MetaData node)
    {
        if (!string.IsNullOrEmpty(node.Package)) return node.Package;
        var key = node.ResolutionKey();
        var idx = key.LastIndexOf(MetaPackageSeparator, StringComparison.Ordinal);
        return idx < 0 ? null : key[..idx];
    }

    /// <summary>The set of distinct cross-package C# namespaces this entity references — for
    /// emitting <c>using</c> directives in the file preamble when per-package binding splits
    /// the model across multiple namespaces. Walks <c>field.object @objectRef</c> targets +
    /// the super (TPH base) when present; resolves each via <see cref="Resolve"/> and
    /// filters out the entity's own namespace.</summary>
    public static IReadOnlyList<string> CrossPackageReferencedNamespaces(
        MetaObjects.Meta.MetaObject entity, MetaObjects.Meta.MetaRoot root, GenConfig config)
    {
        var ownNs = Resolve(config, EffectivePackage(entity), entity.Name);
        var seen = new HashSet<string>(StringComparer.Ordinal);

        void Consider(MetaObjects.Meta.MetaObject? target)
        {
            if (target is null) return;
            var ns = Resolve(config, EffectivePackage(target), target.Name);
            if (string.IsNullOrEmpty(ns) || ns == ownNs) return;
            seen.Add(ns);
        }

        // field.object refs (owned-type navigations on entity AND value-objects).
        foreach (var f in entity.Fields())
        {
            if (f.SubType != MetaObjects.Core.Field.FieldConstants.FIELD_SUBTYPE_OBJECT) continue;
            if (f.ObjectRef is not { } oref) continue;
            var target = root.FindObject(CSharpNaming.StripPkg(oref));
            Consider(target);
        }

        // TPH base — a subtype's `class Sub : Base` requires Base's namespace.
        if (entity.SuperData is MetaObjects.Meta.MetaObject super)
            Consider(super);

        return seen.OrderBy(n => n, StringComparer.Ordinal).ToList();
    }

    /// <summary>
    /// Resolve a metadata package (and optional type name) to its target C# namespace per the
    /// FR-021 resolution order. Throws <see cref="InvalidOperationException"/> when the package
    /// is unresolvable and <see cref="GenConfig.UnmappedStrategy"/> is
    /// <see cref="UnmappedPackageStrategy.Error"/>.
    /// </summary>
    /// <param name="config">The codegen config holding the convention + overrides.</param>
    /// <param name="package">Metadata package (e.g. <c>acme::cases</c>). Empty/null → fall through
    ///   to the unmapped strategy (no overrides/convention apply to no-package).</param>
    /// <param name="typeName">Optional named type within the package. When provided, enables the
    ///   type-level override layer (<c>typeOverrides["<pkg>::<typeName>"]</c>). When null, only
    ///   package-level resolution applies (use for "where do this package's enums import from" —
    ///   the FR-019 case).</param>
    /// <param name="fallbackContext">Human-readable context for the error message (e.g. the
    ///   referencing entity name) so a missing config has a useful diagnostic.</param>
    public static string Resolve(
        GenConfig config,
        string? package,
        string? typeName = null,
        string? fallbackContext = null)
        => ResolveImpl(config, package, typeName, useProvidedEnumPrepend: false, fallbackContext);

    /// <summary>Resolve for an abstract <c>field.enum</c> with <c>@provided: true</c>
    /// (FR-019 shared-enum reference case). Layer order is the same as <see cref="Resolve"/>,
    /// but the Convention rule consults <see cref="PackageBindingConvention.ProvidedEnumPrepend"/>
    /// (falling back to <see cref="PackageBindingConvention.Prepend"/> when unset).</summary>
    public static string ResolveForProvidedEnum(
        GenConfig config,
        string? package,
        string? typeName = null,
        string? fallbackContext = null)
        => ResolveImpl(config, package, typeName, useProvidedEnumPrepend: true, fallbackContext);

    /// <summary>Resolve via the layered map (TypeOverrides → PackageNamespaces → Convention)
    /// WITHOUT applying the unmapped-strategy fallback. Returns null when none of the layers
    /// matches. Callers (notably the FR-019 @provided-enum reference resolver) use this to
    /// chain to their own legacy fallback (e.g. <see cref="GenConfig.ProvidedEnumNamespace"/>)
    /// before deciding to error out.</summary>
    public static string? TryResolve(
        GenConfig config,
        string? package,
        string? typeName = null,
        bool useProvidedEnumPrepend = false)
    {
        // 1. Type-level override.
        if (!string.IsNullOrEmpty(package) && !string.IsNullOrEmpty(typeName))
        {
            var fqn = package + MetaPackageSeparator + typeName;
            if (config.TypeOverrides.TryGetValue(fqn, out var typeTarget) && !string.IsNullOrEmpty(typeTarget))
                return typeTarget;
        }
        // 2. Package-level override.
        if (!string.IsNullOrEmpty(package) &&
            config.PackageNamespaces.TryGetValue(package, out var pkgTarget) &&
            !string.IsNullOrEmpty(pkgTarget))
        {
            return pkgTarget;
        }
        // 3. Convention rule.
        if (!string.IsNullOrEmpty(package) && config.Convention is { } conv)
        {
            // When useProvidedEnumPrepend is true, ONLY succeed if the convention actually has
            // a ProvidedEnumPrepend set; otherwise fall through so the caller can apply its
            // own legacy fallback (ProvidedEnumNamespace).
            if (useProvidedEnumPrepend && string.IsNullOrEmpty(conv.ProvidedEnumPrepend)) return null;
            return ApplyConvention(conv, package, applyStripPrepend: true, useProvidedEnumPrepend);
        }
        return null;
    }

    private static string ResolveImpl(
        GenConfig config,
        string? package,
        string? typeName,
        bool useProvidedEnumPrepend,
        string? fallbackContext)
    {
        // 1. Type-level override — most specific, wins absolutely.
        if (!string.IsNullOrEmpty(package) && !string.IsNullOrEmpty(typeName))
        {
            var fqn = package + MetaPackageSeparator + typeName;
            if (config.TypeOverrides.TryGetValue(fqn, out var typeTarget) && !string.IsNullOrEmpty(typeTarget))
                return typeTarget;
        }

        // 2. Package-level override.
        if (!string.IsNullOrEmpty(package) &&
            config.PackageNamespaces.TryGetValue(package, out var pkgTarget) &&
            !string.IsNullOrEmpty(pkgTarget))
        {
            return pkgTarget;
        }

        // 3. Convention rule — derives the target from the package itself.
        if (!string.IsNullOrEmpty(package) && config.Convention is { } conv)
        {
            var derived = ApplyConvention(conv, package, applyStripPrepend: true, useProvidedEnumPrepend);
            if (derived is not null) return derived;
        }

        // 4. Unmapped strategy fallback.
        return config.UnmappedStrategy switch
        {
            UnmappedPackageStrategy.Flatten => config.Namespace,
            UnmappedPackageStrategy.Derive when config.Convention is { } deriveConv =>
                ApplyConvention(deriveConv, package ?? "", applyStripPrepend: false, useProvidedEnumPrepend) ?? config.Namespace,
            UnmappedPackageStrategy.Derive => config.Namespace,
            UnmappedPackageStrategy.Error => throw BuildErrorForUnmapped(package, typeName, fallbackContext),
            _ => config.Namespace,
        };
    }

    /// <summary>Apply the convention rule. Returns null if <paramref name="package"/> doesn't
    /// start with <see cref="PackageBindingConvention.Strip"/> (and <paramref name="applyStripPrepend"/>
    /// is true). When <paramref name="useProvidedEnumPrepend"/> is true, the convention's
    /// <see cref="PackageBindingConvention.ProvidedEnumPrepend"/> replaces the default
    /// <see cref="PackageBindingConvention.Prepend"/> (falling back to the default when unset).</summary>
    private static string? ApplyConvention(PackageBindingConvention conv, string package, bool applyStripPrepend, bool useProvidedEnumPrepend = false)
    {
        var prepend = useProvidedEnumPrepend && !string.IsNullOrEmpty(conv.ProvidedEnumPrepend)
            ? conv.ProvidedEnumPrepend
            : conv.Prepend;

        string remainder;
        if (applyStripPrepend && !string.IsNullOrEmpty(conv.Strip))
        {
            if (!package.StartsWith(conv.Strip, StringComparison.Ordinal)) return null;
            remainder = package.Substring(conv.Strip.Length);
        }
        else
        {
            remainder = package;
        }

        if (string.IsNullOrEmpty(remainder)) return applyStripPrepend ? prepend : null;

        var segments = remainder.Split(new[] { MetaPackageSeparator }, StringSplitOptions.None);
        var transformed = segments.Select(s => Transform(s, conv.Case)).ToArray();
        var joined = string.Join(conv.Separator, transformed);
        return applyStripPrepend
            ? string.IsNullOrEmpty(prepend)
                ? joined
                : prepend + conv.Separator + joined
            : joined;
    }

    private static string Transform(string segment, PackageCase casing) => casing switch
    {
        PackageCase.PascalCase => ToPascalCase(segment),
        PackageCase.CamelCase => ToCamelCase(segment),
        PackageCase.KebabCase => ToKebabCase(segment),
        PackageCase.SnakeCase => ToSnakeCase(segment),
        PackageCase.Lowercase => segment.Replace("-", "").Replace("_", "").ToLowerInvariant(),
        PackageCase.Preserve => segment,
        _ => segment,
    };

    /// <summary>Split a segment on <c>-</c> and <c>_</c> boundaries (and at lower→upper transitions)
    /// so case transformations can reassemble it consistently.</summary>
    private static string[] SplitWords(string segment)
    {
        if (string.IsNullOrEmpty(segment)) return [];
        var words = new List<string>();
        var current = new StringBuilder();
        for (var i = 0; i < segment.Length; i++)
        {
            var c = segment[i];
            if (c == '-' || c == '_')
            {
                if (current.Length > 0) { words.Add(current.ToString()); current.Clear(); }
                continue;
            }
            // Boundary at lower→upper transition (camelCase to two words).
            if (current.Length > 0 && char.IsUpper(c) && char.IsLower(current[current.Length - 1]))
            {
                words.Add(current.ToString()); current.Clear();
            }
            current.Append(c);
        }
        if (current.Length > 0) words.Add(current.ToString());
        return words.ToArray();
    }

    private static string ToPascalCase(string segment)
    {
        var words = SplitWords(segment);
        var sb = new StringBuilder();
        foreach (var w in words)
        {
            if (w.Length == 0) continue;
            sb.Append(char.ToUpperInvariant(w[0]));
            if (w.Length > 1) sb.Append(w.Substring(1).ToLowerInvariant());
        }
        return sb.ToString();
    }

    private static string ToCamelCase(string segment)
    {
        var pascal = ToPascalCase(segment);
        if (pascal.Length == 0) return pascal;
        return char.ToLowerInvariant(pascal[0]) + pascal.Substring(1);
    }

    private static string ToKebabCase(string segment) =>
        string.Join("-", SplitWords(segment).Select(w => w.ToLowerInvariant()));

    private static string ToSnakeCase(string segment) =>
        string.Join("_", SplitWords(segment).Select(w => w.ToLowerInvariant()));

    private static InvalidOperationException BuildErrorForUnmapped(string? package, string? typeName, string? context)
    {
        var pkgRef = string.IsNullOrEmpty(package) ? "<no package>" : package;
        var typeRef = string.IsNullOrEmpty(typeName) ? "" : $" (type \"{typeName}\")";
        var contextSuffix = string.IsNullOrEmpty(context) ? "" : $" — referenced from {context}";
        return new InvalidOperationException(
            $"FR-021 — metadata package \"{pkgRef}\"{typeRef} has no namespace binding{contextSuffix}. " +
            $"Add an entry to PackageNamespaces (e.g. {{ \"{pkgRef}\", \"YourApp.Namespace\" }}), " +
            $"a TypeOverrides entry, or a Convention rule that matches this package — " +
            $"or set UnmappedStrategy = Flatten to fall back to the default Namespace.");
    }
}
