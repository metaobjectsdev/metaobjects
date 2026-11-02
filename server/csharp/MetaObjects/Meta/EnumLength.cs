// The column length of a string-stored field.enum: the field's @maxLength, else the project's
// default (`enums.maxLength` in .metaobjects/config.json, carried on the loaded root beside the
// naming rules), else none — an unbounded text column. Mirrors TS enum-length.ts.

using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Shared.BaseTypes;

namespace MetaObjects.Meta;

/// <summary>The project's enum storage defaults: <c>enums</c> in <c>.metaobjects/config.json</c>.</summary>
/// <param name="MaxLength">The column length of a string-stored enum that declares no @maxLength.</param>
public sealed record EnumDefaults(long? MaxLength)
{
    /// <summary>No project default: an enum with no @maxLength is an unbounded text column.</summary>
    public static readonly EnumDefaults Default = new((long?)null);

    /// <summary>The enum defaults for the tree <paramref name="node"/> belongs to: what its root carries, else none.</summary>
    public static EnumDefaults Of(MetaData node) => (node.Root() as MetaRoot)?.EnumDefaults ?? Default;
}

/// <summary>Core resolution of a string-stored enum's column length.</summary>
public static class EnumLength
{
    /// <summary>
    /// The column length of <paramref name="field"/>, a string-stored <c>field.enum</c>: its
    /// @maxLength (ADR-0039 — resolving), else the project default, else null. Null for an
    /// @intValueMap enum, whose column is an integer, and for any other field.
    /// <para>The loader refuses an @maxLength a member does not fit; it does not see the
    /// project config, so a member longer than the project DEFAULT is refused here
    /// (ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH), by every consumer that sizes the column.</para>
    /// </summary>
    public static long? ResolveMaxLength(MetaField field)
    {
        if (field.SubType != FIELD_SUBTYPE_ENUM || field.Attr(FIELD_ATTR_INT_VALUE_MAP) is not null) return null;
        if (field.MaxLength is { } own) return own;
        if (EnumDefaults.Of(field).MaxLength is not { } fallback) return null;
        var longest = (field.EffectiveEnumValues ?? [])
            .OrderByDescending(v => v.Length).FirstOrDefault();
        if (longest is not null && longest.Length > fallback)
        {
            var owner = field.Parent;
            var label = owner is not null && owner.Type == TYPE_OBJECT ? $"{owner.Name}.{field.Name}" : field.Name;
            throw new MetaModelException(
                $"field.enum \"{label}\" has the member \"{longest}\" ({longest.Length} characters), longer than " +
                $"the project's enums.maxLength {fallback}. Give the field its own @maxLength of at least " +
                $"{longest.Length}, raise enums.maxLength, or shorten the member.",
                ErrorCode.ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH);
        }
        return fallback;
    }
}
