// rc.21 part B — the view vocabulary at load, the C# twin of the TypeScript
// rc21b-view-vocabulary.test.ts: each construct accepted where it means something and refused,
// with its code and message, where it does not. The shared conformance fixtures
// (projection-view-vocabulary-rc21 and its error-* siblings) pin the cross-port envelopes.

using System.Text.Json;
using MetaObjects.Loader;
using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class ViewVocabularyRc21LoaderTests
{
    private const string Entities = """
      { "object.value": { "name": "Contact", "children": [ { "field.string": { "name": "kind" } } ] } },
      { "object.entity": { "name": "Customer", "children": [
        { "source.rdb": { "@table": "customers" } },
        { "field.long": { "name": "id" } }, { "field.string": { "name": "zip" } },
        { "field.object": { "name": "contacts", "@objectRef": "Contact", "isArray": true, "@storage": "jsonb" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { "name": "Order", "children": [
        { "source.rdb": { "@table": "orders" } },
        { "field.long": { "name": "id" } }, { "field.long": { "name": "customerId" } },
        { "field.enum": { "name": "status", "@values": ["Open", "Shipped"], "@intValueMap": { "Open": 0, "Shipped": 1 } } },
        { "field.enum": { "name": "kind", "@values": ["A", "B"] } },
        { "field.int": { "name": "n" } }, { "field.string": { "name": "ref" } }, { "field.timestamp": { "name": "at" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { "name": "customerId", "@fields": "customerId", "@references": "Customer" } } ] } },
      { "object.entity": { "name": "OrderEvent", "children": [
        { "source.rdb": { "@table": "order_events" } },
        { "field.long": { "name": "id" } }, { "field.long": { "name": "orderId" } }, { "field.long": { "name": "customerId" } },
        { "field.timestamp": { "name": "createdAt" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { "name": "orderId", "@fields": "orderId", "@references": "Order" } } ] } }
    """;

    private static string View(params string[] fields) => $$"""
      { "object.projection": { "name": "V", "children": [
        { "source.rdb": { "@kind": "view", "@view": "v" } },
        { "field.long": { "name": "id", "extends": "Order.id" } },
        {{string.Join(",\n", fields)}} ] } }
    """;

    private static string Computed(string name, string subType, object expr) =>
        $$"""{ "field.{{subType}}": { "name": "{{name}}", "children": [ { "origin.computed": { "@expr": {{JsonSerializer.Serialize(expr)}} } } ] } }""";

    private static IReadOnlyList<MetaError> Load(params string[] extra)
    {
        var json = $$"""{ "metadata.root": { "package": "acme", "children": [ {{Entities}}{{string.Concat(extra.Select(e => ",\n" + e))}} ] } }""";
        var registry = Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });
        return new MetaDataLoader(registry).Load([new InMemoryStringSource(json, format: MetaDataFormat.Json, id: "v.json")]).Errors;
    }

    private static void Refused(string code, string fragment, params string[] extra)
    {
        var errors = Load(extra);
        Assert.True(errors.Any(e => e.Code.ToString() == code && e.Message.Contains(fragment, StringComparison.Ordinal)),
            $"expected {code} containing '{fragment}', got: {string.Join(" | ", errors.Select(e => $"{e.Code}: {e.Message}"))}");
    }

    private static object F(string name) => new Dictionary<string, object> { ["field"] = name };
    private static object V(object? value) => new Dictionary<string, object?> { ["value"] = value };
    private static object Fn(string fn, params object[] args) => new Dictionary<string, object> { ["fn"] = fn, ["args"] = args };
    private static object Cast(object arg, string to) => new Dictionary<string, object> { ["cast"] = arg, ["as"] = to };

    [Fact]
    public void Typed_functions_casts_paths_and_aggregate_reads_load()
    {
        var errors = Load(View(
            Computed("a", "string", Fn("splitPart", F("customerId.zip"), V("-"), V(1))),
            Computed("b", "string", Fn("concatWs", V(" "), F("ref"), F("n"))),
            Computed("c", "int", Fn("length", Fn("btrim", F("ref")))),
            Computed("d", "string", Cast(F("id"), "string")),
            Computed("e", "int", Cast(F("status"), "int")),
            """{ "field.timestamp": { "name": "last", "children": [ { "origin.aggregate": { "@agg": "max", "@of": "OrderEvent.createdAt", "@via": "Order.orderEvents" } } ] } }""",
            Computed("touched", "timestamp", Fn("greatest", F("at"), F("last"))),
            """{ "field.long": { "name": "ev", "children": [ { "origin.first": { "@of": "OrderEvent.id", "@via": "Order.orderEvents", "@orderBy": ["createdAt"], "@filter": { "customerId": { "eq": { "field": "customerId.id" } } } } } ] } }"""));
        Assert.Empty(errors);
    }

    [Fact]
    public void An_unknown_function_a_bad_arity_and_a_wrong_argument_are_refused()
    {
        Refused("ERR_UNKNOWN_EXPR_NODE", "unknown expression fn 'initcap'", View(Computed("a", "string", Fn("initcap", F("ref")))));
        Refused("ERR_UNKNOWN_EXPR_NODE", "'splitPart' requires at least 3 args", View(Computed("a", "string", Fn("splitPart", F("ref")))));
        Refused("ERR_INVALID_ORIGIN", "'lower' argument 1 must be a string, got int", View(Computed("a", "string", Fn("lower", F("n")))));
        Refused("ERR_INVALID_ORIGIN", "'greatest' arguments have differing types", View(Computed("a", "int", Fn("greatest", F("n"), F("id")))));
    }

    [Fact]
    public void A_cast_the_source_cannot_hold_is_refused()
    {
        Refused("ERR_INVALID_ORIGIN", "only an enum stored as an integer", View(Computed("a", "int", Cast(F("kind"), "int"))));
        Refused("ERR_INVALID_ORIGIN", "a timestamp cannot be cast to int", View(Computed("a", "int", Cast(F("at"), "int"))));
        Refused("ERR_UNKNOWN_EXPR_NODE", "requires 'as': one of", View(Computed("a", "string", Cast(F("id"), "enum"))));
    }

    [Fact]
    public void An_expression_over_an_aggregate_is_not_filterable()
    {
        Refused("ERR_BAD_ATTR_FILTER", "touched", $$"""
          { "object.projection": { "name": "V", "@filter": { "touched": { "isNull": false } }, "children": [
            { "source.rdb": { "@kind": "view", "@view": "v" } },
            { "field.long": { "name": "id", "extends": "Order.id" } },
            { "field.timestamp": { "name": "last", "children": [ { "origin.aggregate": { "@agg": "max", "@of": "OrderEvent.createdAt", "@via": "Order.orderEvents" } } ] } },
            {{Computed("touched", "timestamp", Fn("greatest", F("at"), F("last")))}} ] } }
        """);
    }

    [Fact]
    public void A_path_operand_that_does_not_resolve_is_refused()
    {
        Refused("ERR_BAD_ATTR_FILTER", "base-row path \"customerId.nope\"", View(
            """{ "field.long": { "name": "ev", "children": [ { "origin.first": { "@of": "OrderEvent.id", "@via": "Order.orderEvents", "@orderBy": ["createdAt"], "@filter": { "customerId": { "eq": { "field": "customerId.nope" } } } } } ] } }"""));
    }

    [Fact]
    public void A_check_condition_refuses_the_view_only_nodes()
    {
        Refused("ERR_BAD_ATTR_VALUE", "uses lower, which a CHECK condition cannot hold", """
          { "object.entity": { "name": "W", "children": [
            { "source.rdb": { "@table": "w" } }, { "field.long": { "name": "id" } }, { "field.string": { "name": "a" } }, { "field.string": { "name": "b" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "validator.requiredWhen": { "name": "r", "@field": "b", "@condition": { "op": "eq", "left": { "fn": "lower", "args": [ { "field": "a" } ] }, "right": { "value": "x" } } } } ] } }
        """);
    }

    [Fact]
    public void A_grain_needs_an_object_array_and_a_union_needs_one_shape()
    {
        Refused("ERR_BAD_ATTR_VALUE", "@grain \"zip\" must name a field.object array", """
          { "object.projection": { "name": "G", "@grain": "zip", "children": [
            { "source.rdb": { "@kind": "view", "@view": "g" } }, { "field.long": { "name": "customerId", "extends": "Customer.id" } } ] } }
        """);
        Assert.Empty(Load("""
          { "object.projection": { "name": "G", "@grain": "contacts", "@grainOrdinal": "pos", "children": [
            { "source.rdb": { "@kind": "view", "@view": "g" } }, { "field.long": { "name": "customerId", "extends": "Customer.id" } },
            { "field.int": { "name": "pos" } },
            { "field.string": { "name": "kind", "children": [ { "origin.passthrough": { "@from": "Contact.kind" } } ] } } ] } }
        """));
        Refused("ERR_BAD_ATTR_VALUE", "@unionAll needs @union", """
          { "object.projection": { "name": "A", "abstract": true, "children": [ { "field.long": { "name": "personId", "extends": "Customer.id" } } ] } },
          { "object.projection": { "name": "U", "extends": "A", "@unionAll": true, "children": [ { "source.rdb": { "@kind": "view", "@view": "u" } } ] } }
        """);
    }

    [Fact]
    public void The_db_column_type_text_spellings_load_and_an_oversize_max_length_is_refused()
    {
        foreach (var t in new[] { "text", "varchar", "character varying", "varchar(12)", "character varying(12)", "character(3)" })
            Assert.Empty(Load($$"""
              { "object.entity": { "name": "R", "children": [ { "source.rdb": { "@table": "r" } }, { "field.long": { "name": "id" } },
                { "field.string": { "name": "c", "@dbColumnType": "{{t}}" } }, { "identity.primary": { "name": "id", "@fields": "id" } } ] } }
            """));
        Refused("ERR_BAD_ATTR_VALUE", "@maxLength: 10 over '@dbColumnType: character(3)'", """
          { "object.entity": { "name": "R", "children": [ { "source.rdb": { "@table": "r" } }, { "field.long": { "name": "id" } },
            { "field.string": { "name": "c", "@dbColumnType": "character(3)", "@maxLength": 10 } }, { "identity.primary": { "name": "id", "@fields": "id" } } ] } }
        """);
        Refused("ERR_BAD_ATTR_VALUE", "'VARCHAR' is not a valid value", """
          { "object.entity": { "name": "R", "children": [ { "source.rdb": { "@table": "r" } }, { "field.long": { "name": "id" } },
            { "field.string": { "name": "c", "@dbColumnType": "VARCHAR" } }, { "identity.primary": { "name": "id", "@fields": "id" } } ] } }
        """);
    }

    // rc.21 part B: a passthrough walks a reference backwards when its holder declares a unique identity over its fields.
    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(true, true)]
    public void A_passthrough_over_a_reverse_hop_needs_a_unique_identity(bool unique, bool partial)
    {
        // A partial (@where) unique index is unique only over its subset: the hop stays to-many.
        var where = partial ? """, "@where": "\"note\" IS NOT NULL" """ : "";
        var secondary = unique ? $$"""{ "identity.secondary": { "name": "events_order_uq", "@fields": "orderId"{{where}} } },""" : "";
        unique = unique && !partial;
        var json = $$"""
          { "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "Order", "children": [ { "source.rdb": { "@table": "orders" } }, { "field.long": { "name": "id" } },
              { "identity.primary": { "@fields": "id" } } ] } },
            { "object.entity": { "name": "Receipt", "children": [ { "source.rdb": { "@table": "receipts" } }, { "field.long": { "name": "id" } },
              { "field.long": { "name": "orderId" } }, { "field.string": { "name": "note" } }, { "identity.primary": { "@fields": "id" } }, {{secondary}}
              { "identity.reference": { "name": "orderId", "@fields": "orderId", "@references": "Order" } } ] } },
            { "object.projection": { "name": "V", "children": [ { "source.rdb": { "@kind": "view", "@view": "v" } },
              { "field.long": { "name": "id", "extends": "Order.id" } },
              { "field.string": { "name": "note", "children": [ { "origin.passthrough": { "@from": "Receipt.note", "@via": "Order.receipts" } } ] } },
              { "identity.primary": { "name": "id", "extends": "Order.primary" } } ] } } ] } }
        """;
        var registry = Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });
        var errors = new MetaDataLoader(registry).Load([new InMemoryStringSource(json, format: MetaDataFormat.Json, id: "r.json")]).Errors;
        if (unique) Assert.Empty(errors);
        else Assert.Contains(errors, e => e.Code.ToString() == "ERR_ORIGIN_CARDINALITY");
    }

    // rc.21 part B fix round (I2): an extender whose view widened over a TPH base warns, unless scoped.
    [Theory]
    [InlineData("", true)]
    [InlineData("\"@filter\": { \"kind\": \"TRUCK\" },", false)]
    public void An_extender_whose_view_widened_over_a_tph_base_warns(string filter, bool warns)
    {
        var json = $$"""
          { "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "Vehicle", "@discriminator": "kind", "children": [
              { "source.rdb": { "@table": "vehicles" } }, { "field.long": { "name": "id" } }, { "field.string": { "name": "kind", "@maxLength": 10 } },
              { "identity.primary": { "@fields": "id" } } ] } },
            { "object.entity": { "name": "Truck", "extends": "Vehicle", "@discriminatorValue": "TRUCK", "children": [ { "field.string": { "name": "payloadClass" } } ] } },
            { "object.projection": { "name": "VehicleBase", "abstract": true, "children": [
              { "field.long": { "name": "vehicleId", "extends": "Vehicle.id" } }, { "identity.primary": { "name": "id", "extends": "Vehicle.primary" } } ] } },
            { "object.projection": { "name": "TruckRow", "extends": "VehicleBase", {{filter}} "children": [
              { "source.rdb": { "@kind": "view", "@view": "v_trucks" } },
              { "field.string": { "name": "payload", "extends": "Truck.payloadClass" } } ] } } ] } }
        """;
        var registry = Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });
        var result = new MetaDataLoader(registry).Load([new InMemoryStringSource(json, format: MetaDataFormat.Json, id: "t.json")]);
        Assert.Empty(result.Errors);
        var hit = result.Warnings.Where(w => w.Contains("TruckRow", StringComparison.Ordinal)).ToList();
        if (warns)
        {
            var w = Assert.Single(hit);
            Assert.Contains("only the subtype Truck carries, over the TPH base Vehicle with no @filter on its discriminator \"kind\"", w);
        }
        else Assert.Empty(hit);
    }

    // rc.21 part B fix round (I4): origin.function's declared signature is checked.
    [Theory]
    [InlineData("[\"id\"]", "[\"int\"]", "string", "argument 1 \"id\" is a field.long, but parameter 1 is declared int")]
    [InlineData("[\"id\"]", "[\"long\"]", "int", "@returns int, but the field is field.string")]
    [InlineData("[\"id\", \"zip\"]", "[\"long\"]", "string", "@params declares 1 parameter type(s) for 2 argument(s)")]
    [InlineData("[\"id\", \"zip\"]", "[\"long\", \"string\"]", "string", null)]
    public void Origin_function_checks_its_declared_signature(string args, string parameters, string returns, string? fragment)
    {
        var json = $$"""
          { "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "C2", "children": [ { "source.rdb": { "@table": "c2" } }, { "field.long": { "name": "id" } },
              { "field.string": { "name": "zip" } }, { "identity.primary": { "name": "id", "@fields": "id" } },
              { "field.string": { "name": "tier", "children": [ { "origin.function": { "@function": "tier_of", "@args": {{args}}, "@params": {{parameters}}, "@returns": "{{returns}}" } } ] } } ] } },
            { "object.projection": { "name": "P2", "children": [ { "source.rdb": { "@kind": "view", "@view": "p2" } },
              { "field.long": { "name": "id", "extends": "C2.id" } },
              { "field.string": { "name": "tier", "children": [ { "origin.passthrough": { "@from": "C2.tier" } } ] } },
              { "identity.primary": { "name": "id", "extends": "C2.id" } } ] } } ] } }
        """;
        var registry = Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });
        var errors = new MetaDataLoader(registry).Load([new InMemoryStringSource(json, format: MetaDataFormat.Json, id: "f.json")]).Errors;
        if (fragment is null) Assert.Empty(errors);
        else Assert.Contains(errors, e => e.Code.ToString() == "ERR_INVALID_ORIGIN" && e.Message.Contains(fragment, StringComparison.Ordinal));
    }

    // rc.21 part B fix round (M1, M4): casts Postgres has; a union member's own @union is refused.
    [Fact]
    public void A_boolean_casts_only_with_int_and_a_count_parameter_takes_only_an_int()
    {
        Refused("ERR_INVALID_ORIGIN", "a long cannot be cast to boolean; only an int can", View(Computed("a", "boolean", Cast(F("id"), "boolean"))));
        Refused("ERR_INVALID_ORIGIN", "'left' argument 2 must be an int, got long", View(Computed("a", "string", Fn("left", F("ref"), F("id")))));
        Assert.Empty(Load(View(Computed("a", "boolean", Cast(F("n"), "boolean")))));
    }

    [Fact]
    public void A_union_member_with_its_own_union_is_refused()
    {
        Refused("ERR_BAD_ATTR_VALUE", "member \"B\" declares its own @union", """
          { "object.projection": { "name": "A", "abstract": true, "children": [ { "field.long": { "name": "personId", "extends": "Customer.id" } } ] } },
          { "object.projection": { "name": "B", "abstract": true, "@union": ["C"], "children": [ { "field.long": { "name": "personId", "extends": "Order.customerId" } } ] } },
          { "object.projection": { "name": "C", "abstract": true, "children": [ { "field.long": { "name": "personId", "extends": "Order.id" } } ] } },
          { "object.projection": { "name": "U", "extends": "A", "@union": ["B"], "children": [ { "source.rdb": { "@kind": "view", "@view": "u" } } ] } }
        """);
    }
}
