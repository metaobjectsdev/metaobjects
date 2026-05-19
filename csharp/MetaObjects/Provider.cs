namespace MetaObjects;

// ---------------------------------------------------------------------------
// IMetaDataTypeProvider
// ---------------------------------------------------------------------------

/// <summary>
/// A unit of metamodel registration — contributes and/or extends types in a
/// <see cref="TypeRegistry"/>. One provider per package.
/// Ported from <c>typescript/packages/metadata/src/provider.ts</c>.
/// </summary>
public interface IMetaDataTypeProvider
{
    /// <summary>Stable id; other providers reference it in <see cref="Dependencies"/>.</summary>
    string Id { get; }

    /// <summary>
    /// Ids of providers that must register before this one.
    /// Return an empty list when there are no dependencies.
    /// </summary>
    IReadOnlyList<string> Dependencies { get; }

    /// <summary>Register new types and/or extend existing ones.</summary>
    void RegisterTypes(TypeRegistry registry);
}

// ---------------------------------------------------------------------------
// Provider (static composition helpers)
// ---------------------------------------------------------------------------

/// <summary>
/// Static helpers for composing a <see cref="TypeRegistry"/> from a set of
/// <see cref="IMetaDataTypeProvider"/> instances.
/// </summary>
public static class Provider
{
    /// <summary>
    /// Build a <see cref="TypeRegistry"/> by composing <paramref name="providers"/>.
    /// Providers are topologically sorted by their <see cref="IMetaDataTypeProvider.Dependencies"/>;
    /// the sort is stable — providers with no ordering constraint keep input order.
    /// </summary>
    /// <exception cref="MetaModelException">
    /// Thrown with <see cref="ErrorCode.ERR_PROVIDER_DUPLICATE_ID"/> when two providers share an id,
    /// <see cref="ErrorCode.ERR_PROVIDER_MISSING_DEPENDENCY"/> when a declared dependency is absent,
    /// or <see cref="ErrorCode.ERR_PROVIDER_DEPENDENCY_CYCLE"/> when a cycle is detected.
    /// </exception>
    public static TypeRegistry ComposeRegistry(IReadOnlyList<IMetaDataTypeProvider> providers)
    {
        IReadOnlyList<IMetaDataTypeProvider> ordered = TopoSort(providers);
        TypeRegistry registry = new();
        foreach (IMetaDataTypeProvider provider in ordered)
        {
            provider.RegisterTypes(registry);
        }
        return registry;
    }

    // ------------------------------------------------------------------
    // Stable topological sort — O(n²), n is a handful of providers.
    // ------------------------------------------------------------------

    private static IReadOnlyList<IMetaDataTypeProvider> TopoSort(
        IReadOnlyList<IMetaDataTypeProvider> providers)
    {
        // Duplicate-id check.
        HashSet<string> ids = new(StringComparer.Ordinal);
        foreach (IMetaDataTypeProvider p in providers)
        {
            if (!ids.Add(p.Id))
            {
                throw new MetaModelException(
                    $"composeRegistry: duplicate provider id \"{p.Id}\"",
                    ErrorCode.ERR_PROVIDER_DUPLICATE_ID);
            }
        }

        // Missing-dependency check.
        foreach (IMetaDataTypeProvider p in providers)
        {
            foreach (string dep in p.Dependencies)
            {
                if (!ids.Contains(dep))
                {
                    throw new MetaModelException(
                        $"composeRegistry: provider \"{p.Id}\" depends on \"{dep}\", " +
                        $"which is not in the provider set",
                        ErrorCode.ERR_PROVIDER_MISSING_DEPENDENCY);
                }
            }
        }

        // Stable topological sort: repeatedly emit the first (input-order) provider
        // whose dependencies are all already emitted.
        List<IMetaDataTypeProvider> result = new(providers.Count);
        HashSet<string> emitted = new(StringComparer.Ordinal);

        while (result.Count < providers.Count)
        {
            IMetaDataTypeProvider? next = providers.FirstOrDefault(
                p => !emitted.Contains(p.Id) &&
                     p.Dependencies.All(d => emitted.Contains(d)));

            if (next is null)
            {
                IEnumerable<string> stuck = providers
                    .Where(p => !emitted.Contains(p.Id))
                    .Select(p => p.Id);
                throw new MetaModelException(
                    $"composeRegistry: dependency cycle among providers [{string.Join(", ", stuck)}]",
                    ErrorCode.ERR_PROVIDER_DEPENDENCY_CYCLE);
            }

            result.Add(next);
            emitted.Add(next.Id);
        }

        return result;
    }
}
