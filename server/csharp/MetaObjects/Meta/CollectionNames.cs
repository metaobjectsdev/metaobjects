// rc.19 (R57) — an object's collection name: its own @collectionName (or the deprecated @dbSetName
// alias), else the project's pluralizer (naming.collections) over its name. Ported from
// typescript/packages/metadata/src/naming.ts (collectionNameOf, declaredCollectionName).

using static MetaObjects.Core.Object.ObjectConstants;

namespace MetaObjects.Meta;

/// <summary>A collection name an object declares itself, and whether through the deprecated alias.</summary>
public sealed record DeclaredCollectionName(string Name, bool DeprecatedAlias);

public static class CollectionNames
{
    private static readonly char[] AlreadyPluralExcludedPrecedingChars = ['s', 'u', 'i', 'a'];

    /// <summary>
    /// The collection name of <paramref name="obj"/>, in its own casing: declared, else the project's
    /// pluralizer over its name. Own, not resolving: a name inherited from an abstract base would hand
    /// every subtype one collection.
    /// </summary>
    public static string Of(MetaObject obj) =>
        Declared(obj)?.Name ?? NamingStrategies.Pluralizer(ConfiguredPluralizer(obj) ?? NamingStrategies.DefaultPluralizer)(obj.Name);

    /// <summary>The pluralizer the project configures (<c>naming.collections</c>), or null when it names none.</summary>
    public static string? ConfiguredPluralizer(MetaData node) => PhysicalNaming.Of(node).Collections;

    /// <summary>
    /// The collection name <paramref name="obj"/> declares, or null. Declaring both <c>@collectionName</c>
    /// and its deprecated alias <c>@dbSetName</c> is refused: the two disagreeing has no answer.
    /// </summary>
    public static DeclaredCollectionName? Declared(MetaObject obj)
    {
        var own = obj.OwnAttr(OBJECT_ATTR_COLLECTION_NAME) as string;
        var alias = obj.OwnAttr(OBJECT_ATTR_DB_SET_NAME) as string;
        var hasOwn = !string.IsNullOrEmpty(own);
        var hasAlias = !string.IsNullOrEmpty(alias);
        if (hasOwn && hasAlias)
            throw new MetaModelException(
                $"{obj.ResolutionKey()}: declares both @{OBJECT_ATTR_COLLECTION_NAME} and @{OBJECT_ATTR_DB_SET_NAME}; " +
                $"@{OBJECT_ATTR_DB_SET_NAME} is a deprecated alias of @{OBJECT_ATTR_COLLECTION_NAME} — keep only @{OBJECT_ATTR_COLLECTION_NAME}.",
                ErrorCode.ERR_BAD_ATTR_VALUE);
        if (hasOwn) return new DeclaredCollectionName(own!, false);
        if (hasAlias) return new DeclaredCollectionName(alias!, true);
        return null;
    }

    /// <summary>
    /// The <c>standard</c> pluralizer, the rule every port shares (<c>fixtures/naming-conformance</c>):
    /// an already-plural name stays, else the suffix rule.
    /// </summary>
    public static string StandardPluralize(string s)
    {
        if (s.Length >= 2 && s.EndsWith("s", StringComparison.OrdinalIgnoreCase)
            && Array.IndexOf(AlreadyPluralExcludedPrecedingChars, char.ToLowerInvariant(s[^2])) < 0)
            return s;
        if (s.EndsWith("s", StringComparison.OrdinalIgnoreCase) || s.EndsWith("x", StringComparison.OrdinalIgnoreCase) ||
            s.EndsWith("z", StringComparison.OrdinalIgnoreCase) || s.EndsWith("ch", StringComparison.OrdinalIgnoreCase) ||
            s.EndsWith("sh", StringComparison.OrdinalIgnoreCase))
            return s + "es";
        if (s.Length > 1 && (s[^1] == 'y' || s[^1] == 'Y') && !"aeiouAEIOU".Contains(s[^2]))
            return s[..^1] + "ies";
        return s + "s";
    }
}
