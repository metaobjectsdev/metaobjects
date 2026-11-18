// SerializerKeys fails closed: a credential that cannot be matched to the serializer's contract is a
// refusal, never a silently unstripped response.

using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using MetaObjects.Codegen.Runtime;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class SerializerKeysTests
{
    public sealed class Row
    {
        public long Id { get; set; }
        public string? PinHash { get; set; }
    }

    private static readonly string[] Names = ["PinHash", "pinHash"];

    [Fact]
    public void The_default_contract_gives_the_policys_key()
    {
        var opts = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower, TypeInfoResolver = new DefaultJsonTypeInfoResolver() };
        Assert.Equal(["pin_hash"], SerializerKeys.KeysOfType(typeof(Row), opts, Names));
    }

    [Fact]
    public void A_type_without_the_credential_contributes_nothing_and_never_throws()
    {
        var opts = new JsonSerializerOptions { TypeInfoResolver = new NoProviderResolver() };
        Assert.Empty(SerializerKeys.KeysOfType(typeof(string), opts, Names));
    }

    // A resolver whose properties carry no reflection member (what a custom resolver, a rebuilding
    // modifier or a source-generated context can do).
    private sealed class NoProviderResolver : IJsonTypeInfoResolver
    {
        public JsonTypeInfo? GetTypeInfo(Type type, JsonSerializerOptions options)
        {
            var info = JsonTypeInfo.CreateJsonTypeInfo(type, options);
            if (type != typeof(Row)) return info;
            var id = info.CreateJsonPropertyInfo(typeof(long), "id");
            id.Get = o => ((Row)o).Id;
            id.Set = (o, v) => ((Row)o).Id = (long)v!;
            var pin = info.CreateJsonPropertyInfo(typeof(string), "pinHash");
            pin.Get = o => ((Row)o).PinHash;
            pin.Set = (o, v) => ((Row)o).PinHash = (string?)v;
            info.Properties.Add(id);
            info.Properties.Add(pin);
            return info;
        }
    }

    [Fact]
    public void A_contract_with_no_reflection_member_is_refused_naming_the_type_and_property_but_no_value()
    {
        var opts = new JsonSerializerOptions { TypeInfoResolver = new NoProviderResolver() };
        var ex = Assert.Throws<InvalidOperationException>(() => SerializerKeys.KeysOfType(typeof(Row), opts, Names));
        Assert.Contains("Row.PinHash", ex.Message);
        Assert.Contains("refused", ex.Message);
    }

    private sealed class RowConverter : JsonConverter<Row>
    {
        public override Row? Read(ref Utf8JsonReader reader, Type t, JsonSerializerOptions o) => throw new NotSupportedException();
        public override void Write(Utf8JsonWriter writer, Row value, JsonSerializerOptions o) => writer.WriteStringValue("x");
    }

    [Fact]
    public void A_custom_converter_for_the_row_type_is_refused()
    {
        var opts = new JsonSerializerOptions { Converters = { new RowConverter() }, TypeInfoResolver = new DefaultJsonTypeInfoResolver() };
        var ex = Assert.Throws<InvalidOperationException>(() => SerializerKeys.KeysOfType(typeof(Row), opts, Names));
        Assert.Contains("Row.PinHash", ex.Message);
    }

    [Fact]
    public void A_credential_the_contract_does_not_carry_is_refused()
    {
        // A modifier that drops the property from the contract while the type still declares it.
        var resolver = new DefaultJsonTypeInfoResolver();
        resolver.Modifiers.Add(ti => { if (ti.Type == typeof(Row)) ti.Properties.Remove(ti.Properties.Single(p => p.Name == "PinHash")); });
        var opts = new JsonSerializerOptions { TypeInfoResolver = resolver };
        var ex = Assert.Throws<InvalidOperationException>(() => SerializerKeys.KeysOf(new[] { new Row() }, false, opts, Names));
        Assert.Contains("Row.PinHash", ex.Message);
    }

    [Fact]
    public void Strip_also_removes_a_key_that_spells_the_credential_ignoring_case_and_separators()
    {
        var node = System.Text.Json.Nodes.JsonNode.Parse("""{"id":1,"pin_hash":"v","PIN-HASH":"v","name":"n"}""")!;
        SerializerKeys.Strip(node, [], Names);
        Assert.Equal("""{"id":1,"name":"n"}""", node.ToJsonString());
    }
}
