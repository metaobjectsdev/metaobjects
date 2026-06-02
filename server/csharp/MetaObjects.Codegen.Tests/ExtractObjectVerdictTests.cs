// Gold-standard "verdict oracle" proof for the Phase B runtime extract (ExtractObject).
//
// A representative adjudication-verdict object.value graph — scalars (incl. an enum with a
// @default), an array-of-enum, and two arrays-of-records — is extracted from a deliberately
// DIRTY XML response (preamble + whitespace, an empty array, an uncoercible enum value, an
// omitted defaulted field). The test proves the full metadata-driven pipeline:
// ExtractSchemaFor → engine → Assemble into a typed object graph with correct back-references,
// generalized @default fill, empty-array → empty-list, never-throws, and the OrThrow() gate.
//
// Sited in MetaObjects.Codegen.Tests — the test project that references the bridge's assembly
// (MetaObjects.Codegen) + Render + core — mirroring the Java port's siting in the `om` module.

using System.Collections.Generic;
using System.Linq;
using MetaObjects.Codegen.Runtime;
using MetaObjects.Loader;
using MetaObjects.Meta;
using MetaObjects.Render.Extract;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class ExtractObjectVerdictTests
{
    private const string Pkg = "com::example::verdict";

    // A generic adjudication-verdict metamodel (no private/domain names):
    //   Verdict: objective_complete boolean, objective_status string,
    //            arc_transition enum [ready|not_ready] @default "not_ready",
    //            tags enum-array [a|b|c], thread_checks + event_checks record-arrays;
    //   ThreadCheck: id string, resolved enum [yes|no], reason string;
    //   EventCheck:  id string, fires enum [yes|no], reason string.
    private const string VerdictMeta = """
    { "metadata.root": {
        "package": "com::example::verdict",
        "children": [
          { "object.value": { "name": "ThreadCheck", "children": [
            { "field.string": { "name": "id" } },
            { "field.enum":   { "name": "resolved", "@values": ["yes", "no"] } },
            { "field.string": { "name": "reason" } }
          ]}},
          { "object.value": { "name": "EventCheck", "children": [
            { "field.string": { "name": "id" } },
            { "field.enum":   { "name": "fires", "@values": ["yes", "no"] } },
            { "field.string": { "name": "reason" } }
          ]}},
          { "object.value": { "name": "Verdict", "children": [
            { "field.boolean": { "name": "objective_complete" } },
            { "field.string":  { "name": "objective_status" } },
            { "field.enum":    { "name": "arc_transition", "@values": ["ready", "not_ready"], "@default": "not_ready" } },
            { "field.enum":    { "name": "tags", "isArray": true, "@values": ["a", "b", "c"] } },
            { "field.object":  { "name": "thread_checks", "isArray": true, "@objectRef": "com::example::verdict::ThreadCheck" } },
            { "field.object":  { "name": "event_checks", "isArray": true, "@objectRef": "com::example::verdict::EventCheck" } }
          ]}}
        ]
      } }
    """;

    private static MetaRoot Load(string model)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "verdict.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    // -----------------------------------------------------------------------
    // The gold-standard dirty-XML extract.
    // -----------------------------------------------------------------------

    [Fact]
    public void DirtyXmlExtractsIntoTypedObjectGraph()
    {
        MetaRoot root = Load(VerdictMeta);
        MetaObject verdictMo = root.FindObject("Verdict")!;
        Assert.NotNull(verdictMo);

        // Dirty XML: a chat preamble + whitespace before the root; arc_transition OMITTED
        // (→ @default "not_ready" → DEFAULTED); tags contains an uncoercible member ("zzz")
        // alongside a valid one; event_checks is an EMPTY element (→ empty list, not null);
        // two well-formed thread_checks records.
        const string dirtyXml =
            "Sure — here is the verdict you asked for:\n\n" +
            "<Verdict>\n" +
            "  <objective_complete>true</objective_complete>\n" +
            "  <objective_status>partially met</objective_status>\n" +
            "  <tags>a</tags>\n" +
            "  <tags>zzz</tags>\n" +
            "  <thread_checks><id>T1</id><resolved>yes</resolved><reason>closed cleanly</reason></thread_checks>\n" +
            "  <thread_checks><id>T2</id><resolved>no</resolved><reason>still open</reason></thread_checks>\n" +
            "  <event_checks></event_checks>\n" +
            "</Verdict>\n" +
            "\nLet me know if you need anything else!";

        ExtractionResult<object> result = ExtractObject.Extract(verdictMo, dirtyXml, Format.Xml);

        // ---- never throws; produced a typed Verdict ValueObject with the right back-ref ----
        object verdict = result.Data;
        Assert.NotNull(verdict);
        var vo = Assert.IsType<ValueObject>(verdict);
        Assert.Same(verdictMo, vo.GetMetaData());

        // ---- scalars ----
        Assert.Equal(true, verdictMo.GetField("objective_complete")!.GetValue(verdict));
        Assert.Equal("partially met", verdictMo.GetField("objective_status")!.GetValue(verdict));

        // ---- @default fill: arc_transition was omitted → DEFAULTED to "not_ready" ----
        Assert.Equal("not_ready", verdictMo.GetField("arc_transition")!.GetValue(verdict));
        Assert.Equal(FieldExtraction.DEFAULTED, result.Report.States()["arc_transition"]);

        // ---- enum-array: valid element kept, uncoercible "zzz" dropped (partial extraction) ----
        var tags = (IReadOnlyList<object?>)verdictMo.GetField("tags")!.GetValue(verdict)!;
        Assert.NotNull(tags);
        Assert.Equal(new[] { "a" }, tags.Cast<string>());
        Assert.Equal(FieldExtraction.MALFORMED, result.Report.States()["tags"]);   // a malformed element
        Assert.Equal(FieldExtraction.EXTRACTED, result.Report.States()["tags[0]"]);
        Assert.Equal(FieldExtraction.MALFORMED, result.Report.States()["tags[1]"]);

        // ---- array-of-records: thread_checks fully populated as typed ValueObject children ----
        var threads = (IReadOnlyList<object>)verdictMo.GetField("thread_checks")!.GetValue(verdict)!;
        Assert.NotNull(threads);
        Assert.Equal(2, threads.Count);

        MetaObject threadMo = root.FindObject("ThreadCheck")!;
        var t0 = Assert.IsType<ValueObject>(threads[0]);
        Assert.Same(threadMo, t0.GetMetaData());   // nested record back-reference
        Assert.Equal("T1", threadMo.GetField("id")!.GetValue(t0));
        Assert.Equal("yes", threadMo.GetField("resolved")!.GetValue(t0));
        Assert.Equal("closed cleanly", threadMo.GetField("reason")!.GetValue(t0));

        var t1 = threads[1];
        Assert.Equal("T2", threadMo.GetField("id")!.GetValue(t1));
        Assert.Equal("no", threadMo.GetField("resolved")!.GetValue(t1));

        // ---- empty array → empty list (NOT null) ----
        var events = (IReadOnlyList<object>)verdictMo.GetField("event_checks")!.GetValue(verdict)!;
        Assert.NotNull(events);
        Assert.Empty(events);

        // ---- OrThrow(): no required field was lost, so it returns the data unharmed ----
        object same = result.OrThrow();
        Assert.Same(verdict, same);
    }

    // -----------------------------------------------------------------------
    // Attribute-bearing XML + @xmlText: attributes map to fields; a field marked
    // @xmlText reads its element's text body (the prompt/output domain marker).
    // Mirrors the Java MetaObjectExtractorVerdictTest.attributeXmlAndXmlTextExtractIntoTypedGraph
    // and the TS extract-object-verdict "@xmlText" test.
    // -----------------------------------------------------------------------

    [Fact]
    public void AttributeXmlAndXmlTextExtractIntoTypedGraph()
    {
        // Vibe.text is marked @xmlText → it receives the <vibes> element's text body, while
        // thread_id comes from the attribute. Check.{id,resolved} come from attributes on a
        // self-closing element. Leaf types declared before the Doc that @objectRef's them.
        const string meta = """
        { "metadata.root": {
            "package": "com::example::vibe",
            "children": [
              { "object.value": { "name": "Vibe", "children": [
                { "field.string": { "name": "thread_id" } },
                { "field.string": { "name": "text", "@xmlText": true } }
              ]}},
              { "object.value": { "name": "Check", "children": [
                { "field.string": { "name": "id" } },
                { "field.enum":   { "name": "resolved", "@values": ["yes", "no"] } }
              ]}},
              { "object.value": { "name": "Doc", "children": [
                { "field.object": { "name": "vibes",  "isArray": true, "@objectRef": "com::example::vibe::Vibe" } },
                { "field.object": { "name": "checks", "isArray": true, "@objectRef": "com::example::vibe::Check" } }
              ]}}
            ]
          } }
        """;

        var r = new MetaDataLoader().Load([new InMemoryStringSource(meta, id: "vibe.json")]);
        Assert.Empty(r.Errors);
        MetaRoot root = r.Root;
        MetaObject docMo = root.FindObject("Doc")!;
        Assert.NotNull(docMo);

        // Attribute-heavy XML: vibes carry a thread_id ATTRIBUTE + a text BODY (mixed content);
        // checks are self-closing all-attribute elements.
        const string xml =
            "<Doc>\n" +
            "  <vibes thread_id=\"TH-001\">Durk staggers but still blocks the trail.</vibes>\n" +
            "  <vibes thread_id=\"TH-002\">Skett's bow arm trembles.</vibes>\n" +
            "  <checks id=\"T1\" resolved=\"yes\"/>\n" +
            "  <checks id=\"T2\" resolved=\"no\"/>\n" +
            "</Doc>";

        ExtractionResult<object> result = ExtractObject.Extract(docMo, xml, Format.Xml);
        object doc = result.Data;
        Assert.NotNull(doc);

        // ---- @xmlText: attribute → thread_id field; element text body → text field ----
        MetaObject vibeMo = root.FindObject("Vibe")!;
        var vibes = (IReadOnlyList<object>)docMo.GetField("vibes")!.GetValue(doc)!;
        Assert.NotNull(vibes);
        Assert.Equal(2, vibes.Count);

        object v0 = vibes[0];
        Assert.Equal("TH-001", vibeMo.GetField("thread_id")!.GetValue(v0));
        Assert.Equal("Durk staggers but still blocks the trail.", vibeMo.GetField("text")!.GetValue(v0));
        Assert.Equal("Skett's bow arm trembles.", vibeMo.GetField("text")!.GetValue(vibes[1]));

        // ---- attribute-only self-closing elements → attributes mapped to fields ----
        MetaObject checkMo = root.FindObject("Check")!;
        var checks = (IReadOnlyList<object>)docMo.GetField("checks")!.GetValue(doc)!;
        Assert.Equal(2, checks.Count);
        Assert.Equal("T1", checkMo.GetField("id")!.GetValue(checks[0]));
        Assert.Equal("yes", checkMo.GetField("resolved")!.GetValue(checks[0]));
        Assert.Equal("no", checkMo.GetField("resolved")!.GetValue(checks[1]));

        Assert.False(result.Report.HasLostRequired());
    }

    // -----------------------------------------------------------------------
    // OrThrow() — the strict opt-in gate throws iff a required field was lost.
    // -----------------------------------------------------------------------

    [Fact]
    public void OrThrowThrowsWhenRequiredFieldLost()
    {
        const string requiredMeta = """
        { "metadata.root": {
            "package": "com::example::verdict",
            "children": [
              { "object.value": { "name": "Strict", "children": [
                { "field.string": { "name": "needed", "@required": true } }
              ]}}
            ]
          } }
        """;
        MetaRoot root = Load(requiredMeta);
        MetaObject strictMo = root.FindObject("Strict")!;

        // Empty JSON object — "needed" is absent → LOST_REQUIRED.
        ExtractionResult<object> result = ExtractObject.Extract(strictMo, "{}", Format.Json);

        Assert.True(result.Report.HasLostRequired());

        var ex = Assert.Throws<ExtractException>(() => result.OrThrow());
        Assert.Contains("needed", ex.LostRequired);
    }

    // -----------------------------------------------------------------------
    // Extract() NEVER throws — even on total garbage input.
    // -----------------------------------------------------------------------

    [Fact]
    public void ExtractNeverThrowsOnGarbage()
    {
        MetaRoot root = Load(VerdictMeta);
        MetaObject verdictMo = root.FindObject("Verdict")!;

        // Total garbage: no recognizable structure at all.
        ExtractionResult<object> result = ExtractObject.Extract(verdictMo, "%%% not even close %%%");

        Assert.NotNull(result);
        Assert.NotNull(result.Data);
        // arc_transition still defaults even on a degenerate response.
        Assert.Equal("not_ready", verdictMo.GetField("arc_transition")!.GetValue(result.Data));
    }

    // -----------------------------------------------------------------------
    // ExtractSchemaFor — the schema mirrors the metadata shape (sanity).
    // -----------------------------------------------------------------------

    [Fact]
    public void ExtractSchemaForMirrorsMetadata()
    {
        MetaRoot root = Load(VerdictMeta);
        MetaObject verdictMo = root.FindObject("Verdict")!;

        ExtractSchema schema = ExtractObject.ExtractSchemaFor(verdictMo, Format.Xml);
        Assert.Equal(Format.Xml, schema.Format);
        Assert.Equal("Verdict", schema.RootName);

        var byName = schema.Fields.ToDictionary(f => f.Name);

        // arc_transition: enum, non-array, carries the @default.
        FieldSpec arc = byName["arc_transition"];
        Assert.Equal(FieldKind.Enum, arc.Kind);
        Assert.False(arc.Array);
        Assert.Equal("not_ready", arc.DefaultValue);
        Assert.Equal(new[] { "ready", "not_ready" }, arc.EnumValues!);

        // tags: enum, array.
        FieldSpec tags = byName["tags"];
        Assert.Equal(FieldKind.Enum, tags.Kind);
        Assert.True(tags.Array);

        // thread_checks: object, array, with a nested schema.
        FieldSpec threads = byName["thread_checks"];
        Assert.Equal(FieldKind.Object, threads.Kind);
        Assert.True(threads.Array);
        Assert.NotNull(threads.Nested);
        Assert.Equal("ThreadCheck", threads.Nested!.RootName);
    }
}
