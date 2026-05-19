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
}
