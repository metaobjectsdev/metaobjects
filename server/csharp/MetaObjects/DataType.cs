// DataType — a coarse, cross-cutting value-type classification.
//
// Java-DataTypes parity: a small closed set that both fields and attributes
// classify into (a MetaField/MetaAttr subtype maps to exactly one DataType).
// Registry-driven — a (type, subType)'s DataType is declared on its
// TypeDefinition, never in a central switch here. This module stays small and
// stable: just the constants, the enum, and the DataTypeAware interface.
//
// Ported 1:1 from typescript/packages/metadata/src/data-type.ts.
// SCREAMING_SNAKE constant names: cross-language grep parity with TS and Java.

namespace MetaObjects;

// ---------------------------------------------------------------------------
// String constants (mirror TS DATA_TYPE_* exports)
// ---------------------------------------------------------------------------

/// <summary>
/// String constants for the coarse value-type vocabulary.
/// Mirrors the <c>DATA_TYPE_*</c> exports in <c>data-type.ts</c>.
/// </summary>
public static class DataTypeConstants
{
    public const string DATA_TYPE_BOOLEAN = "boolean";
    public const string DATA_TYPE_INT     = "int";
    public const string DATA_TYPE_LONG    = "long";
    public const string DATA_TYPE_DOUBLE  = "double";
    public const string DATA_TYPE_STRING  = "string";
    public const string DATA_TYPE_DATE    = "date";
    public const string DATA_TYPE_OBJECT  = "object";

    /// <summary>
    /// The closed set of coarse value types, in the same order as the TS
    /// <c>DATA_TYPES</c> array.
    /// </summary>
    public static readonly string[] DATA_TYPES =
    [
        DATA_TYPE_BOOLEAN,
        DATA_TYPE_INT,
        DATA_TYPE_LONG,
        DATA_TYPE_DOUBLE,
        DATA_TYPE_STRING,
        DATA_TYPE_DATE,
        DATA_TYPE_OBJECT,
    ];
}

// ---------------------------------------------------------------------------
// Enum (idiomatic C# representation — Registry.cs uses DataType?)
// ---------------------------------------------------------------------------

/// <summary>
/// The closed set of coarse value types.
/// <para>
/// The TS source (<c>data-type.ts</c>) models this as a string union; C# models
/// it as an <c>enum</c> so <c>DataType?</c> in <see cref="TypeDefinition"/> stays a
/// non-nullable value type and benefits from exhaustiveness checking.
/// </para>
/// Members correspond 1:1 to the <c>DATA_TYPE_*</c> string constants in
/// <see cref="DataTypeConstants"/>.
/// </summary>
public enum DataType
{
    Boolean,
    Int,
    Long,
    Double,
    String,
    Date,
    Object,
}

// ---------------------------------------------------------------------------
// DataTypeAware interface (mirrors the TS DataTypeAware interface)
// ---------------------------------------------------------------------------

/// <summary>
/// Implemented by nodes that carry a typed value — MetaField and MetaAttr.
/// Mirrors the <c>DataTypeAware</c> interface in <c>data-type.ts</c>.
/// </summary>
public interface IDataTypeAware
{
    DataType DataType { get; }
}
