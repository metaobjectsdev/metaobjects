// ReportingValidationTests — FR-044 ValidateReporting behaviour the conformance corpus
// does not pin: exact message text, the inherited-member dedupe (one broken base member =
// one error; distinct inheritors each reported), the relative-date desugar, and F1's
// "operand values only" walk.
//
// C# parity port of selected cases from the TS reference suite
//   server/typescript/packages/metadata/test/reporting-validation.test.ts
// (the "relative dates" and "inherited members" blocks). Every expected message is the
// TS text verbatim — the ports share one message contract.

using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class ReportingValidationTests
{
    private static LoadResult Load(JsonNode doc) =>
        new MetaDataLoader().Load([new InMemoryStringSource(doc.ToJsonString(), id: "meta.shop.json")]);

    private static JsonNode Fixture(string name) =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(CorpusRoot.Path, name, "input", "meta.shop.json")))!;

    private static JsonArray RootChildren(JsonNode doc) => doc["metadata.root"]!["children"]!.AsArray();

    /// <summary>The body of the root-level object named <paramref name="name"/>.</summary>
    private static JsonObject ObjectBody(JsonNode doc, string name) =>
        RootChildren(doc)
            .Select(w => w!.AsObject().First().Value!.AsObject())
            .Single(b => (string?)b["name"] == name);

    private static JsonArray ChildrenOf(JsonNode doc, string name) => ObjectBody(doc, name)["children"]!.AsArray();

    private static JsonNode Wrap(string typeSubType, string json) => new JsonObject { [typeSubType] = JsonNode.Parse(json) };

    private static string Single(LoadResult r, ErrorCode code)
    {
        Assert.Equal([code], r.Errors.Select(e => e.Code));
        return r.Errors[0].Message;
    }

    private static JsonNode Positive() => Fixture("reporting-vocabulary");

    private static JsonNode Inherited() => Fixture("reporting-inherited-members");

    // -------------------------------------------------------------------------
    // Relative dates (F1 / F2)
    // -------------------------------------------------------------------------

    [Fact]
    public void F2_a_now_key_plus_other_keys_is_refused_on_a_reporting_host()
    {
        var m = Positive();
        ObjectBody(m, "DailyRevenue")["@filter"] =
            JsonNode.Parse("""{ "purchasedAt": { "gte": { "now": "-P7D", "x": 1 } } }""");
        string msg = Single(Load(m), ErrorCode.ERR_BAD_ATTR_FILTER);
        Assert.Equal(
            "report 'acme::shop::DailyRevenue': @filter on 'purchasedAt' has a malformed relative date " +
            "{\"now\":\"-P7D\",\"x\":1}; a relative date is exactly { now: \"<ISO-8601 duration>\" } with no other keys.",
            msg);
    }

    [Fact]
    public void F1_a_now_key_plus_other_keys_is_refused_on_a_non_reporting_host()
    {
        var m = Positive();
        RootChildren(m).Add(Wrap("object.projection", """
            { "name": "RecentPurchase",
              "@filter": { "purchasedAt": { "gte": { "now": "-P7D", "x": 1 } } },
              "children": [
                { "source.rdb": { "@kind": "view", "@view": "recent_purchases" } },
                { "field.long": { "name": "id", "extends": "Purchase.id" } },
                { "field.timestamp": { "name": "purchasedAt", "extends": "Purchase.purchasedAt" } },
                { "identity.primary": { "name": "id", "extends": "Purchase.id" } } ] }
            """));
        string msg = Single(Load(m), ErrorCode.ERR_BAD_ATTR_FILTER);
        Assert.Equal(
            "object.projection 'acme::shop::RecentPurchase': @filter uses a relative date ({ now: ... }), which is " +
            "legal only in the @filter of a segment, measure.aggregate or object.report.",
            msg);
    }

    [Fact]
    public void F2_a_relative_value_survives_desugaring_unchanged()
    {
        var m = Positive();
        ChildrenOf(m, "WorkoutEvent").Add(Wrap("segment.filter",
            """{ "name": "recent", "@filter": { "occurredAt": { "gte": { "now": "-P7D" } } } }"""));
        var r = Load(m);
        Assert.Empty(r.Errors);
        var seg = Assert.IsType<MetaSegment>(
            r.Root.Children().Single(c => c.Name == "WorkoutEvent").ChildByTypeAndName(TYPE_SEGMENT, "recent"));
        var clause = Assert.IsAssignableFrom<IReadOnlyDictionary<string, object?>>(seg.Filter()!["occurredAt"]);
        var relative = Assert.IsAssignableFrom<IReadOnlyDictionary<string, object?>>(clause[FILTER_OP_GTE]);
        Assert.Equal("-P7D", Assert.Single(relative).Value);
    }

    [Fact]
    public void F2_the_operator_less_shorthand_is_an_implicit_eq_and_refused_as_such()
    {
        // `{ f: { now: ... } }` is a relative VALUE (like any other shorthand value it means
        // `eq`), never the op `now`; F2 then refuses it because eq is not a range op.
        var m = Positive();
        ChildrenOf(m, "WorkoutEvent").Add(Wrap("segment.filter",
            """{ "name": "recent", "@filter": { "occurredAt": { "now": "-P7D" } } }"""));
        string msg = Single(Load(m), ErrorCode.ERR_BAD_ATTR_FILTER);
        Assert.Equal(
            "segment 'recent' on entity 'acme::shop::WorkoutEvent': @filter on 'occurredAt' puts a relative date " +
            "under op 'eq'; relative dates are legal only under gt, gte, lt and lte.",
            msg);
    }

    [Fact]
    public void F1_a_field_literally_named_now_is_a_field_not_a_relative_date()
    {
        var m = Positive();
        RootChildren(m).Add(Wrap("object.projection", """
            { "name": "NowView",
              "@filter": { "now": { "eq": 1 } },
              "children": [
                { "source.rdb": { "@kind": "view", "@view": "now_view" } },
                { "field.long": { "name": "id", "extends": "Purchase.id" } },
                { "field.int": { "name": "now" } },
                { "identity.primary": { "name": "id", "extends": "Purchase.id" } } ] }
            """));
        Assert.DoesNotContain(Load(m).Errors, e => e.Message.Contains("relative date", System.StringComparison.Ordinal));
    }

    [Fact]
    public void F1_a_field_named_now_inside_or_does_not_hide_a_real_relative_value_beside_it()
    {
        var m = Positive();
        RootChildren(m).Add(Wrap("object.projection", """
            { "name": "NowView",
              "@filter": { "or": [ { "now": { "eq": 1 } }, { "purchasedAt": { "gte": { "now": "-P7D" } } } ] },
              "children": [
                { "source.rdb": { "@kind": "view", "@view": "now_view" } },
                { "field.long": { "name": "id", "extends": "Purchase.id" } },
                { "field.int": { "name": "now" } },
                { "field.timestamp": { "name": "purchasedAt", "extends": "Purchase.purchasedAt" } },
                { "identity.primary": { "name": "id", "extends": "Purchase.id" } } ] }
            """));
        Assert.Single(Load(m).Errors, e => e.Message.Contains("relative date", System.StringComparison.Ordinal));
    }

    // -------------------------------------------------------------------------
    // Inherited members (ADR-0039) — one broken rule = one error
    // -------------------------------------------------------------------------

    [Fact]
    public void A_broken_member_on_an_abstract_base_is_reported_once_not_once_per_inheritor()
    {
        var m = Inherited();
        ChildrenOf(m, "BaseEvent")[3] = Wrap("measure.aggregate",
            """{ "name": "events", "@agg": "sum", "@of": "BaseEvent.nope" }""");
        string msg = Single(Load(m), ErrorCode.ERR_INVALID_MEASURE);
        Assert.Equal(
            "measure 'events' on entity 'acme::shop::BaseEvent': @of 'BaseEvent.nope' names no field 'nope' on " +
            "'acme::shop::BaseEvent'.",
            msg);
    }

    [Fact]
    public void A_broken_base_dimension_and_base_segment_filter_are_each_reported_once()
    {
        var m = Inherited();
        var kids = ChildrenOf(m, "BaseEvent");
        kids[2] = Wrap("dimension.time", """{ "name": "occurredAt", "@of": "BaseEvent.nope", "@grains": ["day", "week"] }""");
        kids.Add(Wrap("segment.filter", """{ "name": "recent", "@filter": { "nope": 1 } }"""));
        Assert.Equal(
            [ErrorCode.ERR_INVALID_DIMENSION, ErrorCode.ERR_BAD_ATTR_FILTER],
            Load(m).Errors.Select(e => e.Code));
    }

    [Fact]
    public void A_broken_base_via_is_reported_once()
    {
        var m = Inherited();
        ChildrenOf(m, "BaseEvent").Add(Wrap("dimension.attribute",
            """{ "name": "viaNothing", "@of": "BaseEvent.id", "@via": "BaseEvent.nope" }"""));
        Single(Load(m), ErrorCode.ERR_INVALID_DIMENSION);
    }

    [Fact]
    public void Two_inheritors_that_break_the_same_inherited_member_the_same_way_are_each_reported()
    {
        var m = Inherited();
        ChildrenOf(m, "WorkoutEvent").Add(Wrap("field.string", """{ "name": "occurredAt" }"""));
        RootChildren(m).Add(Wrap("object.entity", """
            { "name": "LoginEvent", "extends": "BaseEvent", "children": [
                { "source.rdb": { "@table": "login_events" } },
                { "field.string": { "name": "occurredAt" } },
                { "identity.primary": { "name": "id", "@fields": ["id"] } } ] }
            """));
        var errors = Load(m).Errors;
        Assert.Equal([ErrorCode.ERR_INVALID_DIMENSION, ErrorCode.ERR_INVALID_DIMENSION], errors.Select(e => e.Code));
        Assert.Contains("(inherited by 'acme::shop::WorkoutEvent')", errors[0].Message);
        Assert.Contains("(inherited by 'acme::shop::LoginEvent')", errors[1].Message);
    }

    [Fact]
    public void An_inheritor_whose_override_breaks_an_inherited_member_is_reported_naming_the_inheritor()
    {
        // WorkoutEvent overrides occurredAt as a string: the inherited time dimension is
        // fine on BaseEvent and broken on WorkoutEvent (D3).
        var m = Inherited();
        ChildrenOf(m, "WorkoutEvent").Add(Wrap("field.string", """{ "name": "occurredAt" }"""));
        string msg = Single(Load(m), ErrorCode.ERR_INVALID_DIMENSION);
        Assert.Equal(
            "dimension 'occurredAt' on entity 'acme::shop::BaseEvent' (inherited by 'acme::shop::WorkoutEvent'): a time " +
            "dimension's @of must be a field.date or field.timestamp, but 'BaseEvent.occurredAt' is field.string.",
            msg);
    }

    // -------------------------------------------------------------------------
    // Reports — message text for the cross-entity and repeat cases
    // -------------------------------------------------------------------------

    [Fact]
    public void R3_a_bare_measure_of_another_entity_names_its_owner()
    {
        var m = Positive();
        ObjectBody(m, "StoreTotals")["@measures"] = JsonNode.Parse("""["purchases", "starters"]""");
        string msg = Single(Load(m), ErrorCode.ERR_REPORT_FOREIGN_MEASURE);
        Assert.Equal(
            "report 'acme::shop::StoreTotals' lists measure 'starters', which belongs to 'acme::shop::WorkoutEvent', " +
            "not @from 'acme::shop::Purchase'. All measures of a report come from @from; make a second report over " +
            "'acme::shop::WorkoutEvent'.",
            msg);
    }

    [Fact]
    public void R6_a_measure_listed_twice_names_the_repeat()
    {
        var m = Positive();
        ObjectBody(m, "StoreTotals")["@measures"] = JsonNode.Parse("""["purchases", "purchases"]""");
        Assert.Equal(
            "report 'acme::shop::StoreTotals': @measures lists 'purchases' more than once.",
            Single(Load(m), ErrorCode.ERR_INVALID_REPORT));
    }
}
