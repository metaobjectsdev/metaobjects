// ReportingValidationTests — FR-044 ValidateReporting behaviour the conformance corpus
// does not pin: exact message text, the inherited-member dedupe (one broken base member =
// one error; distinct inheritors each reported), the relative-date desugar, and F1's
// "operand values only" walk.
//
// C# parity port of selected cases from the TS reference suite
//   server/typescript/packages/metadata/test/reporting-validation.test.ts
// (the "relative dates", "inherited members", "@spine (R8, R9)" and "measure @default
// (M7, M8)" blocks). Every expected message is the TS text verbatim — the ports share one
// message contract. The one exception is a fractional measure @default: this port's
// generic attr.int type check already refuses it with ERR_BAD_ATTR_VALUE (its own text),
// so no second, reporting-specific error is added; those cases pin the code, the node and
// that it is the only error.

using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using MetaObjects.Loader;
using MetaObjects.Meta;
using MetaObjects.Source;
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

    /// <summary>Replace the child of object <paramref name="objName"/> keyed
    /// <paramref name="typeSubType"/> and named <paramref name="childName"/> — selected by
    /// (type, name), never by index, so a fixture reorder cannot retarget the edit.</summary>
    private static void ReplaceChild(JsonNode doc, string objName, string typeSubType, string childName, string json)
    {
        var kids = ChildrenOf(doc, objName);
        int i = kids.Select((w, idx) => (w, idx))
            .Single(t => t.w!.AsObject().First().Key == typeSubType
                && (string?)t.w!.AsObject().First().Value!["name"] == childName).idx;
        kids[i] = Wrap(typeSubType, json);
    }

    private static string Single(LoadResult r, ErrorCode code)
    {
        Assert.Equal([code], r.Errors.Select(e => e.Code));
        return r.Errors[0].Message;
    }

    private static JsonNode Positive() => Fixture("reporting-vocabulary");

    private static JsonNode J(string json) => JsonNode.Parse(json)!;

    private static JsonNode Field(string subType, string name) =>
        Wrap($"field.{subType}", $$"""{ "name": "{{name}}" }""");

    private static JsonNode Primary() => Wrap("identity.primary", """{ "name": "id", "@fields": ["id"] }""");

    /// <summary>Set (or, with a null value, delete) attrs on a JSON body.</summary>
    private static void Patch(JsonObject body, (string Key, JsonNode? Value)[] attrs)
    {
        foreach (var (key, value) in attrs)
        {
            if (value is null) body.Remove(key);
            else body[key] = value;
        }
    }

    /// <summary>Patch the attrs of the root object (a report, say) named <paramref name="objName"/>.</summary>
    private static void PatchObject(JsonNode doc, string objName, params (string Key, JsonNode? Value)[] attrs) =>
        Patch(ObjectBody(doc, objName), attrs);

    /// <summary>Patch the attrs of the dimension / measure / segment <paramref name="childName"/> of <paramref name="objName"/>.</summary>
    private static void PatchMember(JsonNode doc, string objName, string childName, params (string Key, JsonNode? Value)[] attrs)
    {
        string[] memberTypes = [TYPE_DIMENSION, TYPE_MEASURE, TYPE_SEGMENT];
        var body = ChildrenOf(doc, objName)
            .Select(w => w!.AsObject().First())
            .Single(kv => memberTypes.Contains(kv.Key.Split('.')[0]) && (string?)kv.Value!["name"] == childName)
            .Value!.AsObject();
        Patch(body, attrs);
    }

    private static string? JsonPathOf(MetaError e) => (e.Envelope as JsonSource)?.JsonPath;

    // -------------------------------------------------------------------------
    // R8 / R9 — a report's @spine (Table B of
    // docs/superpowers/plans/2026-10-09-fr-044-zero-rows-and-measure-defaults.md)
    // -------------------------------------------------------------------------

    /// <summary>Append report <c>ProgramPurchases</c> over Purchase with <c>@spine: Purchase.program</c>;
    /// <paramref name="attrs"/> override (a null value deletes).</summary>
    private static void AddSpineReport(JsonNode doc, params (string Key, JsonNode? Value)[] attrs)
    {
        RootChildren(doc).Add(Wrap("object.report", """
            { "name": "ProgramPurchases", "@from": "Purchase", "@spine": "Purchase.program",
              "@dimensions": ["programTitle"], "@measures": ["purchases", "revenue"] }
            """));
        PatchObject(doc, "ProgramPurchases", attrs);
    }

    /// <summary>Program -> Coach -> Agency, both to-one, plus Purchase dimensions at the end of each hop.</summary>
    private static void AddCoachChain(JsonNode doc)
    {
        var program = ChildrenOf(doc, "Program");
        program.Add(Field("long", "coachId"));
        program.Add(Wrap("identity.reference", """{ "name": "coachRef", "@references": "Coach", "@fields": ["coachId"] }"""));
        program.Add(Wrap("relationship.association", """{ "name": "coach", "@objectRef": "Coach", "@cardinality": "one" }"""));
        RootChildren(doc).Add(Wrap("object.entity", """
            { "name": "Coach", "children": [
                { "source.rdb": { "@table": "coaches" } },
                { "field.long": { "name": "id" } },
                { "field.string": { "name": "name" } },
                { "field.long": { "name": "agencyId" } },
                { "identity.primary": { "name": "id", "@fields": ["id"] } },
                { "identity.reference": { "name": "agencyRef", "@references": "Agency", "@fields": ["agencyId"] } },
                { "relationship.association": { "name": "agency", "@objectRef": "Agency", "@cardinality": "one" } } ] }
            """));
        RootChildren(doc).Add(Wrap("object.entity", """
            { "name": "Agency", "children": [
                { "source.rdb": { "@table": "agencies" } },
                { "field.long": { "name": "id" } },
                { "field.string": { "name": "name" } },
                { "identity.primary": { "name": "id", "@fields": ["id"] } } ] }
            """));
        var purchase = ChildrenOf(doc, "Purchase");
        purchase.Add(Wrap("dimension.attribute",
            """{ "name": "coachName", "@of": "Coach.name", "@via": "Purchase.program.coach" }"""));
        purchase.Add(Wrap("dimension.attribute",
            """{ "name": "agencyName", "@of": "Agency.name", "@via": "Purchase.program.coach.agency" }"""));
    }

    /// <summary>A dimension of Purchase reaching Program.title through the identity.reference, not the relationship.</summary>
    private static JsonNode ProgramTitleByRef() =>
        Wrap("dimension.attribute", """{ "name": "programTitleByRef", "@of": "Program.title", "@via": "Purchase.programRef" }""");

    [Fact]
    public void R8_a_spine_report_whose_dimensions_are_all_reached_through_the_spine_loads_clean()
    {
        var m = Positive();
        AddSpineReport(m);
        Assert.Empty(Load(m).Errors);
    }

    [Fact]
    public void R8_a_to_many_spine_hop_is_refused_naming_the_report_and_the_hops_entity()
    {
        var m = Positive();
        ChildrenOf(m, "Program").Add(Wrap("measure.aggregate",
            """{ "name": "programs", "@agg": "count", "@of": "Program.id" }"""));
        RootChildren(m).Add(Wrap("object.report", """
            { "name": "ProgramReach", "@from": "Program", "@spine": "Program.purchases", "@measures": ["programs"] }
            """));
        Assert.Equal(
            "report 'acme::shop::ProgramReach': @spine 'Program.purchases' crosses relationship 'purchases' on " +
            "'acme::shop::Program', which is not to-one. A @spine follows only @cardinality: one relationships " +
            "and identity.reference hops, so each fact row joins at most one row of the spine entity and is never " +
            "counted twice.",
            Single(Load(m), ErrorCode.ERR_INVALID_REPORT));
    }

    [Fact]
    public void R8_a_spine_whose_owner_is_another_entity_is_refused()
    {
        var m = Positive();
        AddSpineReport(m, ("@spine", "Program.purchases"));
        Assert.Equal(
            "report 'acme::shop::ProgramPurchases': @spine 'Program.purchases' must start at @from 'acme::shop::Purchase'.",
            Single(Load(m), ErrorCode.ERR_INVALID_REPORT));
    }

    [Fact]
    public void R8_a_spine_hop_that_names_nothing_is_refused_naming_from_as_the_hops_entity()
    {
        var m = Positive();
        AddSpineReport(m, ("@spine", "Purchase.nope"));
        Assert.Equal(
            "report 'acme::shop::ProgramPurchases': @spine 'Purchase.nope' names 'nope', which is not a relationship " +
            "or identity.reference of 'acme::shop::Purchase'.",
            Single(Load(m), ErrorCode.ERR_INVALID_REPORT));
    }

    [Fact]
    public void R8_a_spine_with_no_hop_is_refused()
    {
        var m = Positive();
        AddSpineReport(m, ("@spine", "Purchase"));
        Assert.Equal(
            "report 'acme::shop::ProgramPurchases': @spine 'Purchase' must be Owner.hop[.hop...], starting at " +
            "@from 'acme::shop::Purchase'.",
            Single(Load(m), ErrorCode.ERR_INVALID_REPORT));
    }

    [Fact]
    public void D2s_to_many_wording_is_unchanged_by_the_walks_wording_argument()
    {
        var m = Positive();
        ChildrenOf(m, "Program").Add(Wrap("dimension.attribute",
            """{ "name": "buyerEmail", "@of": "Purchase.customerEmail", "@via": "Program.purchases" }"""));
        Assert.Equal(
            "dimension 'buyerEmail' on entity 'acme::shop::Program': @via 'Program.purchases' crosses relationship " +
            "'purchases' on 'acme::shop::Program', which is not to-one. A dimension follows only @cardinality: one " +
            "relationships and identity.reference hops, so grouping can never multiply the measured rows.",
            Single(Load(m), ErrorCode.ERR_INVALID_DIMENSION));
    }

    [Theory]
    [InlineData("Purchase", "@via 'Purchase' must be Owner.hop[.hop...], starting at the owning entity.")]
    [InlineData("WorkoutEvent.program", "@via 'WorkoutEvent.program' must start at the owning entity 'acme::shop::Purchase'.")]
    [InlineData("Purchase.nope",
        "@via 'Purchase.nope' names 'nope', which is not a relationship or identity.reference of 'acme::shop::Purchase'.")]
    public void D2s_own_wording_is_unchanged_by_the_walks_wording_argument(string via, string body)
    {
        var m = Positive();
        PatchMember(m, "Purchase", "programTitle", ("@via", via));
        Assert.Equal(
            "dimension 'programTitle' on entity 'acme::shop::Purchase': " + body,
            Single(Load(m), ErrorCode.ERR_INVALID_DIMENSION));
    }

    [Fact]
    public void R8_the_error_source_is_the_report_node()
    {
        var m = Positive();
        AddSpineReport(m, ("@spine", "Purchase.nope"));
        var errors = Load(m).Errors;
        Assert.EndsWith("['object.report']", JsonPathOf(Assert.Single(errors)));
    }

    [Fact]
    public void R8_failing_skips_R9_a_broken_spine_with_an_off_spine_dimension_is_one_error()
    {
        var m = Positive();
        AddSpineReport(m, ("@spine", "Purchase.nope"), ("@dimensions", J("""["purchasedAt:day"]""")));
        Assert.Contains("@spine 'Purchase.nope' names 'nope'", Single(Load(m), ErrorCode.ERR_INVALID_REPORT));
    }

    [Fact]
    public void R8_an_inherited_spine_owner_written_as_the_abstract_base_loads_clean()
    {
        var m = Inherited();
        RootChildren(m).Add(Wrap("object.entity", """
            { "name": "Program", "children": [
                { "source.rdb": { "@table": "programs" } },
                { "field.long": { "name": "id" } },
                { "field.string": { "name": "title" } },
                { "identity.primary": { "name": "id", "@fields": ["id"] } } ] }
            """));
        var baseEvent = ChildrenOf(m, "BaseEvent");
        baseEvent.Add(Field("long", "programId"));
        baseEvent.Add(Wrap("identity.reference", """{ "name": "programRef", "@references": "Program", "@fields": ["programId"] }"""));
        baseEvent.Add(Wrap("relationship.association", """{ "name": "program", "@objectRef": "Program", "@cardinality": "one" }"""));
        baseEvent.Add(Wrap("dimension.attribute", """{ "name": "programTitle", "@of": "Program.title", "@via": "BaseEvent.program" }"""));
        RootChildren(m).Add(Wrap("object.report", """
            { "name": "ProgramEvents", "@from": "WorkoutEvent", "@spine": "BaseEvent.program",
              "@dimensions": ["programTitle"], "@measures": ["events"] }
            """));
        Assert.Empty(Load(m).Errors);
    }

    [Fact]
    public void R9_a_spine_report_with_no_dimensions_is_refused()
    {
        var m = Positive();
        AddSpineReport(m, ("@dimensions", null));
        Assert.Equal(
            "report 'acme::shop::ProgramPurchases': @spine 'Purchase.program' needs at least one dimension. The " +
            "report's rows are the dimension tuples of 'acme::shop::Program'; with no dimension it would be one " +
            "totals row.",
            Single(Load(m), ErrorCode.ERR_INVALID_REPORT));
    }

    [Fact]
    public void R9_a_dimension_with_no_via_read_from_the_fact_row_is_refused()
    {
        var m = Positive();
        AddSpineReport(m, ("@dimensions", J("""["programTitle", "program"]""")));
        Assert.Equal(
            "report 'acme::shop::ProgramPurchases': dimension 'program' is read from @from 'acme::shop::Purchase', so " +
            "it has no value in a row that has no facts. With @spine 'Purchase.program' every dimension must be " +
            "reached through it: declare the dimension over a field of 'acme::shop::Program' (or an entity to-one " +
            "from it) with an @via that begins 'Purchase.program'.",
            Single(Load(m), ErrorCode.ERR_INVALID_REPORT));
    }

    [Fact]
    public void R9_a_time_dimension_over_a_fact_column_is_refused()
    {
        var m = Positive();
        AddSpineReport(m, ("@dimensions", J("""["programTitle", "purchasedAt:day"]""")));
        Assert.Contains(
            "report 'acme::shop::ProgramPurchases': dimension 'purchasedAt' is read from @from",
            Single(Load(m), ErrorCode.ERR_INVALID_REPORT));
    }

    [Fact]
    public void R9_each_offending_dimension_is_reported_once_even_when_listed_at_two_grains()
    {
        var m = Positive();
        AddSpineReport(m, ("@dimensions", J("""["program", "purchasedAt:day", "purchasedAt:week", "programTitle"]""")));
        var errors = Load(m).Errors;
        Assert.Equal([ErrorCode.ERR_INVALID_REPORT, ErrorCode.ERR_INVALID_REPORT], errors.Select(e => e.Code));
        Assert.Contains("dimension 'program' is read from @from", errors[0].Message);
        Assert.Contains("dimension 'purchasedAt' is read from @from", errors[1].Message);
    }

    [Fact]
    public void R9_a_dimension_through_a_second_reference_to_the_same_entity_is_refused()
    {
        var m = Positive();
        var purchase = ChildrenOf(m, "Purchase");
        purchase.Add(Field("long", "giftProgramId"));
        purchase.Add(Wrap("identity.reference",
            """{ "name": "giftProgramRef", "@references": "Program", "@fields": ["giftProgramId"] }"""));
        purchase.Add(ProgramTitleByRef());
        purchase.Add(Wrap("dimension.attribute",
            """{ "name": "giftProgramTitle", "@of": "Program.title", "@via": "Purchase.giftProgramRef" }"""));
        AddSpineReport(m, ("@spine", "Purchase.programRef"),
            ("@dimensions", J("""["programTitleByRef", "giftProgramTitle"]""")));
        Assert.Equal(
            "report 'acme::shop::ProgramPurchases': dimension 'giftProgramTitle' is reached by @via " +
            "'Purchase.giftProgramRef', which does not begin with the hops of @spine 'Purchase.programRef'. Hop names " +
            "are compared as written: if both name the same join, write the same hops; otherwise the dimension is " +
            "not reached through the spine.",
            Single(Load(m), ErrorCode.ERR_INVALID_REPORT));
    }

    [Fact]
    public void R9_a_dimension_whose_own_via_fails_D2_is_reported_once_by_D2_not_also_by_R9()
    {
        var m = Positive();
        PatchMember(m, "Purchase", "programTitle", ("@via", "Purchase.programm"));
        AddSpineReport(m);
        Assert.Contains("@via 'Purchase.programm' names 'programm'", Single(Load(m), ErrorCode.ERR_INVALID_DIMENSION));
    }

    [Fact]
    public void R9_the_same_join_named_by_the_relationship_in_spine_and_by_the_reference_in_via_is_refused()
    {
        var m = Positive();
        ChildrenOf(m, "Purchase").Add(ProgramTitleByRef());
        AddSpineReport(m, ("@spine", "Purchase.program"), ("@dimensions", J("""["programTitleByRef"]""")));
        string msg = Single(Load(m), ErrorCode.ERR_INVALID_REPORT);
        Assert.Contains("dimension 'programTitleByRef' is reached by @via 'Purchase.programRef'", msg);
        Assert.Contains("@spine 'Purchase.program'", msg);
    }

    [Fact]
    public void R9_the_owner_segment_is_not_compared_an_fqn_spine_owner_and_a_bare_dimension_via()
    {
        var m = Positive();
        AddSpineReport(m, ("@spine", "acme::shop::Purchase.program"));
        Assert.Empty(Load(m).Errors);
    }

    [Fact]
    public void R9_a_time_dimension_over_a_column_of_the_spine_entity_is_legal()
    {
        var m = Positive();
        ChildrenOf(m, "Program").Add(Field("timestamp", "publishedAt"));
        ChildrenOf(m, "Purchase").Add(Wrap("dimension.time", """
            { "name": "programPublishedAt", "@of": "Program.publishedAt", "@via": "Purchase.program", "@grains": ["month"] }
            """));
        AddSpineReport(m, ("@dimensions", J("""["programTitle", "programPublishedAt:month"]""")));
        Assert.Empty(Load(m).Errors);
    }

    [Fact]
    public void R9_a_two_hop_spine_with_a_dimension_at_it_and_one_beyond_it_is_legal()
    {
        var m = Positive();
        AddCoachChain(m);
        AddSpineReport(m, ("@spine", "Purchase.program.coach"), ("@dimensions", J("""["coachName", "agencyName"]""")));
        Assert.Empty(Load(m).Errors);
    }

    [Fact]
    public void R9_a_dimension_that_stops_short_of_a_two_hop_spine_is_refused()
    {
        var m = Positive();
        AddCoachChain(m);
        AddSpineReport(m, ("@spine", "Purchase.program.coach"), ("@dimensions", J("""["coachName", "programTitle"]""")));
        Assert.Contains(
            "dimension 'programTitle' is reached by @via 'Purchase.program'",
            Single(Load(m), ErrorCode.ERR_INVALID_REPORT));
    }

    // -------------------------------------------------------------------------
    // M7 / M8 — where a measure's @default can apply (Table B)
    // -------------------------------------------------------------------------

    [Fact]
    public void M7_default_on_a_count_is_refused_on_the_measure_node()
    {
        var m = Positive();
        PatchMember(m, "Purchase", "purchases", ("@default", 0));
        var errors = Load(m).Errors;
        var e = Assert.Single(errors);
        Assert.Equal(ErrorCode.ERR_INVALID_MEASURE, e.Code);
        Assert.Equal(
            "measure 'purchases' on entity 'acme::shop::Purchase': @default cannot apply to @agg: count. A count is " +
            "never null (it is 0 when nothing matches); remove @default.",
            e.Message);
        Assert.Contains("['measure.aggregate']", JsonPathOf(e));
    }

    [Fact]
    public void M7_default_on_a_distinct_count_of_a_tuple_is_refused()
    {
        var m = Positive();
        PatchMember(m, "WorkoutEvent", "daysEngaged", ("@default", 0));
        string msg = Single(Load(m), ErrorCode.ERR_INVALID_MEASURE);
        Assert.Contains("measure 'daysEngaged'", msg);
        Assert.Contains("@default cannot apply to @agg: count", msg);
    }

    [Fact]
    public void M8_default_on_a_max_of_a_timestamp_is_refused()
    {
        var m = Positive();
        PatchMember(m, "WorkoutEvent", "lastActivityAt", ("@default", 0));
        Assert.Equal(
            "measure 'lastActivityAt' on entity 'acme::shop::WorkoutEvent': @default is a number, but " +
            "'WorkoutEvent.occurredAt', the @of of @agg 'max', is a field.timestamp. A default is supported on " +
            "numeric measures only.",
            Single(Load(m), ErrorCode.ERR_INVALID_MEASURE));
    }

    [Fact]
    public void A_non_integer_default_on_a_count_reports_M7_and_the_attribute_type_error()
    {
        var m = Positive();
        PatchMember(m, "Purchase", "purchases", ("@default", "zero"));
        var errors = Load(m).Errors;
        Assert.Equal(
            [ErrorCode.ERR_BAD_ATTR_VALUE, ErrorCode.ERR_INVALID_MEASURE],
            errors.Select(e => e.Code).OrderBy(c => c.ToString(), System.StringComparer.Ordinal));
        Assert.Contains(
            "measure 'purchases' on entity 'acme::shop::Purchase': @default cannot apply to @agg: count.",
            errors.Single(e => e.Code == ErrorCode.ERR_INVALID_MEASURE).Message);
    }

    [Theory]
    // entity, measure, the fraction, the measure's wrapper key
    [InlineData("Purchase", "revenue", 0.5, "measure.aggregate")]          // a sum
    [InlineData("WorkoutEvent", "avgDaysPerStarter", 0.5, "measure.ratio")] // a ratio
    [InlineData("Purchase", "purchases", 0.5, "measure.aggregate")]         // a count: M7 is skipped
    [InlineData("WorkoutEvent", "lastActivityAt", -1.5, "measure.aggregate")] // a max of a timestamp: M8 is skipped
    public void A_fractional_default_is_ERR_BAD_ATTR_VALUE_on_the_measure_node_and_the_only_error(
        string entity, string measure, double value, string wrapper)
    {
        var m = Positive();
        PatchMember(m, entity, measure, ("@default", value));
        var e = Assert.Single(Load(m).Errors);
        Assert.Equal(ErrorCode.ERR_BAD_ATTR_VALUE, e.Code);
        Assert.Contains("'@default'", e.Message);
        Assert.Contains($"['{wrapper}']", JsonPathOf(e));
    }

    [Fact]
    public void A_fractional_default_on_a_sum_declared_on_an_abstract_base_is_reported_once()
    {
        var m = Inherited();
        ReplaceChild(m, "BaseEvent", "measure.aggregate", "events",
            """{ "name": "events", "@agg": "sum", "@of": "BaseEvent.id", "@default": 0.5 }""");
        Assert.Contains("'@default'", Single(Load(m), ErrorCode.ERR_BAD_ATTR_VALUE));
    }

    [Fact]
    public void Default_on_a_sum_an_avg_a_min_of_an_int_and_a_ratio_is_fine()
    {
        var m = Positive();
        PatchMember(m, "Purchase", "revenue", ("@default", 0));
        ChildrenOf(m, "Purchase").Add(Wrap("measure.aggregate",
            """{ "name": "avgRevenue", "@agg": "avg", "@of": "Purchase.amountCents", "@default": 0 }"""));
        ChildrenOf(m, "WorkoutEvent").Add(Wrap("measure.aggregate",
            """{ "name": "firstDay", "@agg": "min", "@of": "WorkoutEvent.dayNumber", "@default": 1 }"""));
        PatchMember(m, "WorkoutEvent", "avgDaysPerStarter", ("@default", 0));
        Assert.Empty(Load(m).Errors);
    }

    [Fact]
    public void A_measure_that_breaks_M4_and_declares_default_reports_M4_only()
    {
        var m = Positive();
        PatchMember(m, "Purchase", "revenue", ("@of", "Purchase.status"), ("@default", 0));
        string msg = Single(Load(m), ErrorCode.ERR_INVALID_MEASURE);
        Assert.Contains("field.string", msg);
        Assert.DoesNotContain("@default", msg);
    }

    [Fact]
    public void A_measure_that_breaks_M1_and_declares_default_on_a_count_reports_M1_only()
    {
        var m = Positive();
        PatchMember(m, "Purchase", "purchases", ("@of", "Purchase.nope"), ("@default", 0));
        string msg = Single(Load(m), ErrorCode.ERR_INVALID_MEASURE);
        Assert.Contains("names no field 'nope'", msg);
        Assert.DoesNotContain("@default", msg);
    }

    [Fact]
    public void M7_on_a_count_declared_on_an_abstract_base_is_reported_once()
    {
        var m = Inherited();
        ReplaceChild(m, "BaseEvent", "measure.aggregate", "events",
            """{ "name": "events", "@agg": "count", "@of": "BaseEvent.id", "@default": 0 }""");
        Assert.Contains("measure 'events' on entity 'acme::shop::BaseEvent'", Single(Load(m), ErrorCode.ERR_INVALID_MEASURE));
    }

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
        // The projection is otherwise valid, so the model loads clean: nothing reads `now` as a relative date.
        Assert.Empty(Load(m).Errors);
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
        ReplaceChild(m, "BaseEvent", "measure.aggregate", "events",
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
        ReplaceChild(m, "BaseEvent", "dimension.time", "occurredAt",
            """{ "name": "occurredAt", "@of": "BaseEvent.nope", "@grains": ["day", "week"] }""");
        ChildrenOf(m, "BaseEvent").Add(Wrap("segment.filter", """{ "name": "recent", "@filter": { "nope": 1 } }"""));
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

    [Fact]
    public void R5_a_writable_source_names_every_read_only_kind()
    {
        var m = Positive();
        ObjectBody(m, "StoreTotals")["children"] = JsonNode.Parse("""[{ "source.rdb": { "@table": "store_totals" } }]""");
        Assert.Equal(
            "report 'acme::shop::StoreTotals': source.rdb is writable; a report is read-only, so its source must " +
            "declare a read-only @kind (view, materializedView, storedProc or tableFunction).",
            Single(Load(m), ErrorCode.ERR_INVALID_REPORT));
    }

    [Fact]
    public void R6_an_attribute_dimension_and_a_measure_with_the_same_name_collide()
    {
        // An attribute dimension derives its bare name, so dimension `revenue` and measure
        // `revenue` would both become report field `revenue`.
        var m = Positive();
        ChildrenOf(m, "Purchase").Add(Wrap("dimension.attribute", """{ "name": "revenue", "@of": "Purchase.status" }"""));
        ObjectBody(m, "StoreTotals")["@dimensions"] = JsonNode.Parse("""["revenue"]""");
        Assert.Equal(
            "report 'acme::shop::StoreTotals': dimension item 'revenue' and measure 'revenue' both derive report " +
            "field 'revenue'. Report field names must be unique; rename the measure or drop one item.",
            Single(Load(m), ErrorCode.ERR_INVALID_REPORT));
    }
}
