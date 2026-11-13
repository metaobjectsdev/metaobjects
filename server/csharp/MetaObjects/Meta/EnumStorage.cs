// rc.21 — the string a string-stored field.enum member is stored as: its @stringValueMap entry,
// else the member itself. ONE definition every consumer that writes a member into the database
// (a CHECK, a column length, a converter, a @condition literal) reads. Mirrors TypeScript's
// core/field/enum-storage.ts.

using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Meta;

public static class EnumStorage
{
    /// <summary>The effective (ADR-0039: resolving) <c>@stringValueMap</c>, or null.</summary>
    public static IReadOnlyDictionary<string, object?>? StringValueMapOf(MetaData field) =>
        field.Attr(FIELD_ATTR_STRING_VALUE_MAP) as IReadOnlyDictionary<string, object?>;

    /// <summary>The string <paramref name="member"/> is stored as: its @stringValueMap entry, else the member.</summary>
    public static string StoredValue(MetaData field, string member) =>
        StringValueMapOf(field) is { } map && map.TryGetValue(member, out var v) && v is string { Length: > 0 } s ? s : member;

    /// <summary>Every member of @values (resolving), as stored, in declaration order.</summary>
    public static IReadOnlyList<string> StoredValues(MetaField field) =>
        (field.EffectiveEnumValues ?? []).Select(m => StoredValue(field, m)).ToList();
}
