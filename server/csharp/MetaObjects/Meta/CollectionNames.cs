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

    /// <summary>
    /// rc.19 fix round (I3) — the REST collection segment, shared with TypeScript
    /// (<c>fixtures/naming-conformance/collection-segments.json</c>): a declared name wins, else a
    /// configured pluralizer's output over the name, each snake_cased by <see cref="SnakeCollectionName"/>;
    /// with neither, <paramref name="unconfigured"/> (the historical rule, byte-identical) over the name.
    /// </summary>
    public static string Segment(MetaObject obj, Func<string, string> unconfigured)
    {
        if (Declared(obj)?.Name is { } declared) return SnakeCollectionName(declared);
        if (ConfiguredPluralizer(obj) is { } configured) return SnakeCollectionName(NamingStrategies.Pluralizer(configured)(obj.Name));
        return unconfigured(obj.Name);
    }

    /// <summary>
    /// snake_case a collection name with an acronym-aware split: a trailing plural <c>s</c> /
    /// <c>es</c> after a capital is a suffix of the acronym, not a word of its own (<c>FAQs</c> →
    /// <c>faqs</c>, <c>TaxIDs</c> → <c>tax_ids</c>). Mirrors TS <c>snakeCollectionName</c>.
    /// </summary>
    public static string SnakeCollectionName(string s)
    {
        var m = System.Text.RegularExpressions.Regex.Match(s, "^(.*[A-Z])(e?s)$");
        return m.Success
            ? Persistence.Source.SourceNaming.ToSnakeCase(m.Groups[1].Value) + m.Groups[2].Value
            : Persistence.Source.SourceNaming.ToSnakeCase(s);
    }

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
