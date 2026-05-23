// Attr concern constants — the attr subtypes that determine how an attribute
// value is parsed and stored.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/attr/attr-constants.ts.

using MetaObjects.Shared;

namespace MetaObjects.Core.Attr;

/// <summary>
/// Attr concern constants — the 9 attr subtypes (plus the universal base).
/// Wire-format identifiers; do not rename.
/// </summary>
public static class AttrConstants
{
    public const string ATTR_SUBTYPE_STRING      = "string";
    public const string ATTR_SUBTYPE_INT         = "int";
    public const string ATTR_SUBTYPE_LONG        = "long";
    public const string ATTR_SUBTYPE_DOUBLE      = "double";
    public const string ATTR_SUBTYPE_BOOLEAN     = "boolean";
    public const string ATTR_SUBTYPE_CLASS       = "class";
    public const string ATTR_SUBTYPE_PROPERTIES  = "properties";
    public const string ATTR_SUBTYPE_STRINGARRAY = "stringarray";
    public const string ATTR_SUBTYPE_FILTER      = "filter";

    public static readonly string[] ATTR_SUBTYPES =
    [
        BaseTypes.SUBTYPE_BASE,
        ATTR_SUBTYPE_STRING,
        ATTR_SUBTYPE_INT,
        ATTR_SUBTYPE_LONG,
        ATTR_SUBTYPE_DOUBLE,
        ATTR_SUBTYPE_BOOLEAN,
        ATTR_SUBTYPE_CLASS,
        ATTR_SUBTYPE_PROPERTIES,
        ATTR_SUBTYPE_STRINGARRAY,
        ATTR_SUBTYPE_FILTER,
    ];
}
