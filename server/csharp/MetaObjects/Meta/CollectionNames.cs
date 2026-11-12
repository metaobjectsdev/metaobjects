// An object's collection name: its own @collectionName, else the project's pluralizer
// (naming.collections) over its name. Ported from
// typescript/packages/metadata/src/naming.ts (collectionNameOf, declaredCollectionName).

using static MetaObjects.Core.Object.ObjectConstants;

namespace MetaObjects.Meta;

public static class CollectionNames
{
    private static readonly char[] AlreadyPluralExcludedPrecedingChars = ['s', 'u', 'i', 'a'];

    /// <summary>
    /// The collection name of <paramref name="obj"/>, in its own casing: declared, else the project's
    /// pluralizer over its name. Own, not resolving: a name inherited from an abstract base would hand
    /// every subtype one collection.
    /// </summary>
    public static string Of(MetaObject obj) =>
        Declared(obj) ?? NamingStrategies.Pluralizer(ConfiguredPluralizer(obj) ?? NamingStrategies.DefaultPluralizer)(obj.Name);

    /// <summary>The pluralizer the project configures (<c>naming.collections</c>), or null when it names none.</summary>
    public static string? ConfiguredPluralizer(MetaData node) => PhysicalNaming.Of(node).Collections;

    /// <summary>The collection name <paramref name="obj"/> declares (<c>@collectionName</c>), or null.</summary>
    public static string? Declared(MetaObject obj) =>
        // ADR-0039: own — a collection name is the declaring object's alone (see Of).
        obj.OwnAttr(OBJECT_ATTR_COLLECTION_NAME) is string { Length: > 0 } own ? own : null;

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
