// MetaValidator — concrete node class for type=validator nodes.
// Subtype classes (Required, Length, Regex, Numeric, Array) are co-located.
//
// Ported 1:1 from typescript/packages/metadata/src/meta/meta-validator.ts.

namespace MetaObjects.Meta;

/// <summary>
/// Concrete base node class for <c>validator.*</c> nodes.
/// Extends <see cref="MetaData"/> directly: no model wrapper, no metaOf() indirection.
/// </summary>
public class MetaValidator(TypeId typeId, string name) : MetaData(typeId, name)
{
    /// <summary>
    /// Numeric range minimum — shared by length, numeric, and array validators.
    /// </summary>
    public long? Min
    {
        get
        {
            var v = OwnAttr(VALIDATOR_ATTR_MIN);
            return v is long l ? l : null;
        }
    }

    /// <summary>
    /// Numeric range maximum — shared by length, numeric, and array validators.
    /// </summary>
    public long? Max
    {
        get
        {
            var v = OwnAttr(VALIDATOR_ATTR_MAX);
            return v is long l ? l : null;
        }
    }

    /// <summary>True when this validator's subtype is <c>required</c>.</summary>
    public bool IsRequired() => SubType == VALIDATOR_SUBTYPE_REQUIRED;

    /// <summary>True when this validator's subtype is <c>length</c>.</summary>
    public bool IsLength() => SubType == VALIDATOR_SUBTYPE_LENGTH;

    /// <summary>True when this validator's subtype is <c>regex</c>.</summary>
    public bool IsRegex() => SubType == VALIDATOR_SUBTYPE_REGEX;
}

/// <summary>Required validator (no extra attrs; subtype class exists for <c>is</c> narrowing).</summary>
public class MetaRequiredValidator(TypeId typeId, string name) : MetaValidator(typeId, name) { }

/// <summary>Length validator: <see cref="MetaValidator.Min"/>/<see cref="MetaValidator.Max"/> are string/array length bounds.</summary>
public class MetaLengthValidator(TypeId typeId, string name) : MetaValidator(typeId, name) { }

/// <summary>Regex validator: carries the pattern.</summary>
public class MetaRegexValidator(TypeId typeId, string name) : MetaValidator(typeId, name)
{
    /// <summary>The regex pattern string (the <c>@pattern</c> attr).</summary>
    public string? Pattern
    {
        get
        {
            var v = OwnAttr(VALIDATOR_ATTR_PATTERN);
            return v is string s ? s : null;
        }
    }
}

/// <summary>Numeric validator: <see cref="MetaValidator.Min"/>/<see cref="MetaValidator.Max"/> are value bounds.</summary>
public class MetaNumericValidator(TypeId typeId, string name) : MetaValidator(typeId, name) { }

/// <summary>Array validator: <see cref="MetaValidator.Min"/>/<see cref="MetaValidator.Max"/> are element-count bounds.</summary>
public class MetaArrayValidator(TypeId typeId, string name) : MetaValidator(typeId, name) { }
