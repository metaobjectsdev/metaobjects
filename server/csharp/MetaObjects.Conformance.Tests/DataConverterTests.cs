using MetaObjects;
using System.Text.Json;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class DataConverterTests
{
    // --- ToAttrValue -----------------------------------------------------------

    [Fact]
    public void ToAttrValue_preserves_json_scalar_types()
    {
        Assert.Equal("hi", DataConverter.ToAttrValue(JsonDocument.Parse("\"hi\"").RootElement));
        Assert.Equal(42L, DataConverter.ToAttrValue(JsonDocument.Parse("42").RootElement));
        Assert.Equal(true, DataConverter.ToAttrValue(JsonDocument.Parse("true").RootElement));
    }

    [Fact]
    public void ToAttrValue_integer_json_number_returns_long()
    {
        // Integers always return long, not int.
        var result = DataConverter.ToAttrValue(JsonDocument.Parse("99").RootElement);
        Assert.IsType<long>(result);
        Assert.Equal(99L, result);
    }

    [Fact]
    public void ToAttrValue_float_json_number_returns_double()
    {
        var result = DataConverter.ToAttrValue(JsonDocument.Parse("3.14").RootElement);
        Assert.IsType<double>(result);
        Assert.Equal(3.14, (double)result!, 5);
    }

    [Fact]
    public void ToAttrValue_json_array_returns_string_list()
    {
        var result = DataConverter.ToAttrValue(JsonDocument.Parse("[\"a\", \"b\"]").RootElement);
        var list = Assert.IsAssignableFrom<IReadOnlyList<string>>(result);
        Assert.Equal(new[] { "a", "b" }, list);
    }

    [Fact]
    public void ToAttrValue_null_json_throws()
    {
        Assert.Throws<FormatException>(() =>
            DataConverter.ToAttrValue(JsonDocument.Parse("null").RootElement));
    }

    [Fact]
    public void ToAttrValue_object_json_throws()
    {
        Assert.Throws<FormatException>(() =>
            DataConverter.ToAttrValue(JsonDocument.Parse("{\"x\":1}").RootElement));
    }

    // --- ConvertToDataType -----------------------------------------------------

    [Fact]
    public void ConvertToDataType_coerces_toward_the_target()
    {
        Assert.Equal(7L, DataConverter.ConvertToDataType(DataType.Long,
            JsonDocument.Parse("7").RootElement));
    }

    [Fact]
    public void ConvertToDataType_boolean_string_true_becomes_bool()
    {
        // String "true" coerces to bool true when target is Boolean.
        Assert.Equal(true, DataConverter.ConvertToDataType(DataType.Boolean,
            JsonDocument.Parse("\"true\"").RootElement));
    }

    [Fact]
    public void ConvertToDataType_boolean_string_false_becomes_bool()
    {
        Assert.Equal(false, DataConverter.ConvertToDataType(DataType.Boolean,
            JsonDocument.Parse("\"false\"").RootElement));
    }

    [Fact]
    public void ConvertToDataType_integer_string_coerces_to_long()
    {
        // String "42" coerces to 42L when target is Long.
        Assert.Equal(42L, DataConverter.ConvertToDataType(DataType.Long,
            JsonDocument.Parse("\"42\"").RootElement));
    }

    [Fact]
    public void ConvertToDataType_float_string_coerces_to_double()
    {
        Assert.Equal(3.14, (double)DataConverter.ConvertToDataType(DataType.Double,
            JsonDocument.Parse("\"3.14\"").RootElement)!, 5);
    }

    [Fact]
    public void ConvertToDataType_array_element_returns_string_list()
    {
        // Arrays are always returned as IReadOnlyList<string> regardless of target DataType.
        var result = DataConverter.ConvertToDataType(DataType.String,
            JsonDocument.Parse("[\"x\", \"y\"]").RootElement);
        var list = Assert.IsAssignableFrom<IReadOnlyList<string>>(result);
        Assert.Equal(new[] { "x", "y" }, list);
    }

    [Fact]
    public void ConvertToDataType_null_json_throws()
    {
        Assert.Throws<FormatException>(() =>
            DataConverter.ConvertToDataType(DataType.String,
                JsonDocument.Parse("null").RootElement));
    }

    // --- Fix 1: float-notation whole-number string → long (safe range) ---------

    [Fact]
    public void ConvertToDataType_float_notation_whole_number_string_coerces_to_long()
    {
        // "3.0" is a float-notation string that represents the integer 3.
        // TS toInteger: Number("3.0") === 3, Number.isSafeInteger(3) → true → returns 3.
        var result = DataConverter.ConvertToDataType(DataType.Long,
            JsonDocument.Parse("\"3.0\"").RootElement);
        Assert.IsType<long>(result);
        Assert.Equal(3L, result);
    }

    [Fact]
    public void ConvertToDataType_float_notation_beyond_safe_integer_range_keeps_string()
    {
        // 9007199254740993.0 is beyond 2^53-1 — double parse already loses precision.
        // TS: Number.isSafeInteger(parsed) → false → return original string.
        var result = DataConverter.ConvertToDataType(DataType.Long,
            JsonDocument.Parse("\"9007199254740993.0\"").RootElement);
        Assert.IsType<string>(result);
        Assert.Equal("9007199254740993.0", result);
    }

    // --- Fix 2: non-integer JSON number passes through as double ----------------

    [Fact]
    public void ConvertToDataType_non_integer_json_number_passes_through_as_double()
    {
        // JSON number 3.7 targeting DataType.Int — TS toInteger returns raw (the number)
        // unchanged. C# must return double 3.7, NOT the string "3.7".
        var result = DataConverter.ConvertToDataType(DataType.Int,
            JsonDocument.Parse("3.7").RootElement);
        Assert.IsType<double>(result);
        Assert.Equal(3.7, (double)result!, 10);
    }

    // --- Fix 3: boolean pass-through for non-boolean values --------------------

    [Fact]
    public void ConvertToDataType_boolean_with_non_bool_string_passes_through_as_string()
    {
        // TS toBoolean: a non-"true"/"false" string → pass through as-is (AttrValue).
        // C# must return the original string, not throw.
        var result = DataConverter.ConvertToDataType(DataType.Boolean,
            JsonDocument.Parse("\"maybe\"").RootElement);
        Assert.IsType<string>(result);
        Assert.Equal("maybe", result);
    }

    [Fact]
    public void ConvertToDataType_boolean_with_json_number_passes_through()
    {
        // TS toBoolean: a number (not bool, not string) → `return raw as AttrValue`.
        // The JSON number 1 should pass through — C# returns the raw text.
        var result = DataConverter.ConvertToDataType(DataType.Boolean,
            JsonDocument.Parse("1").RootElement);
        // The value is neither true nor false; implementation returns raw text "1".
        Assert.Equal("1", result);
    }
}
