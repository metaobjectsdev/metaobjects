package com.metaobjects.generator.spring;

import com.metaobjects.MetaData;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.generator.util.RestSurfaceGate;
import com.metaobjects.object.MetaObject;
import com.metaobjects.template.MetaTemplate;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Pins each generator's extracted static {@code appliesTo(...)} skip predicate to
 * the SAME inclusion decision the generator's inline per-node guard makes. A future
 * api-docs IR builder calls these predicates to decide which nodes to document, so
 * the predicate must agree with the generators (drift-proof).
 *
 * <p>One fixture carries every shape the predicates discriminate on:</p>
 * <ul>
 *   <li>{@code Author} — a concrete table entity (writable).</li>
 *   <li>{@code SalesReport} — a {@code @kind="view"} {@code object.projection}
 *       (read-only, and KEYLESS: it declares no {@code identity.primary}).</li>
 *   <li>{@code AbstractEntity} — an {@code abstract} entity.</li>
 *   <li>{@code Address} — an {@code object.value} (not an entity).</li>
 *   <li>{@code SummaryOutput} — a {@code template.output @format=json} with a
 *       {@code @payloadRef} resolving to an {@code object.value}.</li>
 *   <li>{@code PlainPrompt} — a valid {@code template.prompt} (its {@code @payloadRef}
 *       resolves to a VO) declaring NO {@code @responseRef}. It renders (so the
 *       render-helper predicate accepts it) and exercises the inbound predicates'
 *       negative path: the output parser / render-helper / output-prompt generators
 *       skip prompts. The loader enforces {@code @payloadRef} present + VO-resolving
 *       at load time, so a non-VO / missing-payloadRef template cannot be constructed
 *       here — the generators' defensive non-VO skip branch is unreachable in a valid
 *       load, so the predicates' false cases are exercised via node type instead.</li>
 *   <li>{@code GreetingCall} — a concrete entity extending {@code LlmCallBase} with a
 *       nested {@code template.prompt} carrying {@code @responseRef}.</li>
 * </ul>
 */
public class SpringAppliesToTest {

    private static final String FIXTURE = """
        {
          "metadata.root": { "package": "acme::shop", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "name", "@maxLength": 100 } },
                { "source.rdb":   { "@table": "authors" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.projection": { "name": "SalesReport", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "regionName", "@maxLength": 100 } },
                { "source.rdb":   { "@table": "v_sales_report", "@kind": "view" } }
            ] } },
            { "object.entity": { "name": "AbstractEntity", "abstract": true, "children": [
                { "field.long":   { "name": "id" } },
                { "source.rdb":   { "@table": "abstract_table" } }
            ] } },
            { "object.value": { "name": "Address", "children": [
                { "field.string": { "name": "street" } }
            ] } },
            { "object.value": { "name": "SummaryPayload", "children": [
                { "field.string": { "name": "text", "@required": true } }
            ] } },
            { "template.output": {
                "name": "SummaryOutput",
                "@payloadRef": "SummaryPayload",
                "@textRef": "summary/output",
                "@format": "json"
            } },
            { "template.prompt": {
                "name": "PlainPrompt",
                "@payloadRef": "SummaryPayload",
                "@textRef": "plain/prompt"
            } },
            { "template.prompt": {
                "name": "RespondingPrompt",
                "@payloadRef": "SummaryPayload",
                "@responseRef": "SummaryPayload",
                "@textRef": "responding/prompt"
            } },
            { "object.value": { "name": "GreetResponse", "children": [
                { "field.string": { "name": "greeting", "@required": true } }
            ] } },
            { "object.entity": { "name": "GreetingCall",
              "extends": "metaobjects::ai::LlmCallBase", "children": [
                { "source.rdb":   { "@table": "llm_call" } },
                { "identity.primary": { "name": "pk", "@fields": ["traceId"] } },
                { "template.prompt": {
                    "name": "greetingPrompt",
                    "@payloadRef": "acme::shop::GreetResponse",
                    "@responseRef": "acme::shop::GreetResponse"
                } }
            ] } }
          ] }
        }
        """;

    /**
     * Build a fresh loader from the inline fixture the same way the trace-helper
     * compile-run test does — a plain {@code MetaDataLoader} loading an
     * {@link InMemoryStringSource}. (Not {@code SharedRegistryTestBase}: the
     * nested {@code template.prompt}-on-entity vocabulary the LlmCallBase shape
     * needs is registered by loading the template classes, which this path does.)
     */
    private MetaDataLoader loader() {
        // The SHIPPED base, via the `libraries` opt-in: `trace-helper` keys on the `ai`
        // manifest's ANCHOR now (FR-043 §6) and compares the full name, so a bespoke
        // `acme::shop::LlmCallBase` no longer matches — which is the latent bug that
        // change removes, and which this fixture used to depend on.
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "spring-applies-to");
        loader.setLibraries(java.util.Collections.singletonList("ai"));
        loader.init();
        loader.load(List.of(new InMemoryStringSource(FIXTURE, "applies-to/meta.json")));
        return loader;
    }

    private static MetaTemplate template(MetaDataLoader loader, String shortName) {
        for (MetaData child : loader.getRoot().getChildren()) {
            if (child instanceof MetaTemplate t && t.getShortName().equals(shortName)) {
                return t;
            }
        }
        throw new IllegalStateException("template not found: " + shortName);
    }

    // === entity-based predicates =============================================

    @Test
    public void repositoryAppliesToPersistedReadSurfaces() throws Exception {
        MetaDataLoader loader = loader();
        MetaObject author = loader.getMetaObjectByName("acme::shop::Author");
        MetaObject report = loader.getMetaObjectByName("acme::shop::SalesReport");
        MetaObject abstractEntity = loader.getMetaObjectByName("acme::shop::AbstractEntity");
        MetaObject address = loader.getMetaObjectByName("acme::shop::Address");

        assertTrue("table entity emits a repository", SpringRepositoryGenerator.appliesTo(author));
        // F22: INVERTED, and the SHAPE of the repository inverted with it. A view-kind
        // projection has a list route, so it has a consumer seam — a READ-ONLY one
        // (list/count/findById, nothing that writes). It used to emit nothing, which is
        // why a projection got no REST surface in Java at all.
        assertTrue("view-kind projection emits a read-only repository",
            SpringRepositoryGenerator.appliesTo(report));
        assertFalse("abstract entity emits nothing", SpringRepositoryGenerator.appliesTo(abstractEntity));
        assertFalse("value object is neither an entity nor a projection",
            SpringRepositoryGenerator.appliesTo(address));
    }

    @Test
    public void controllerAppliesToPersistedReadSurfaces() throws Exception {
        MetaDataLoader loader = loader();
        MetaObject author = loader.getMetaObjectByName("acme::shop::Author");
        MetaObject report = loader.getMetaObjectByName("acme::shop::SalesReport");
        MetaObject abstractEntity = loader.getMetaObjectByName("acme::shop::AbstractEntity");
        MetaObject address = loader.getMetaObjectByName("acme::shop::Address");

        assertTrue(SpringControllerGenerator.appliesTo(author));
        // F22: INVERTED — a view-kind projection now gets a READ-ONLY controller (reads
        // served, every write verb answering 405). WHICH of the two shapes is emitted is
        // RestSurfaceGate.isReadOnly's answer, not this predicate's.
        assertTrue(SpringControllerGenerator.appliesTo(report));
        assertTrue(RestSurfaceGate.isReadOnly(report));
        assertFalse(RestSurfaceGate.isReadOnly(author));
        assertFalse(SpringControllerGenerator.appliesTo(abstractEntity));
        assertFalse(SpringControllerGenerator.appliesTo(address));
    }

    @Test
    public void filterAllowlistAppliesToPersistedReadSurfaces() throws Exception {
        MetaDataLoader loader = loader();
        MetaObject author = loader.getMetaObjectByName("acme::shop::Author");
        MetaObject report = loader.getMetaObjectByName("acme::shop::SalesReport");
        MetaObject abstractEntity = loader.getMetaObjectByName("acme::shop::AbstractEntity");
        MetaObject address = loader.getMetaObjectByName("acme::shop::Address");

        assertTrue(SpringFilterAllowlistGenerator.appliesTo(author));
        // F22: INVERTED — the filter grammar does not care that the source cannot be
        // written, and the emitted read-only controller IMPORTS this allowlist by name.
        // Leaving this one behind is what a half-widened gate looks like: a controller
        // referencing a type nothing generated, with the build still exiting 0.
        assertTrue(SpringFilterAllowlistGenerator.appliesTo(report));
        assertFalse(SpringFilterAllowlistGenerator.appliesTo(abstractEntity));
        assertFalse(SpringFilterAllowlistGenerator.appliesTo(address));
    }

    @Test
    public void dtoAppliesToConcreteEntityOnly() throws Exception {
        MetaDataLoader loader = loader();
        MetaObject author = loader.getMetaObjectByName("acme::shop::Author");
        MetaObject report = loader.getMetaObjectByName("acme::shop::SalesReport");
        MetaObject abstractEntity = loader.getMetaObjectByName("acme::shop::AbstractEntity");
        MetaObject address = loader.getMetaObjectByName("acme::shop::Address");

        // DTO is emitted for every CONCRETE entity regardless of source kind
        // (the view entity still gets a DTO; only its controller/repository are skipped).
        assertTrue(SpringDtoGenerator.appliesTo(author));
        assertTrue(SpringDtoGenerator.appliesTo(report));
        assertFalse("abstract entity gets only the opt-in interface shape, not a record",
            SpringDtoGenerator.appliesTo(abstractEntity));
        assertFalse("value object is not an entity", SpringDtoGenerator.appliesTo(address));
    }

    // === LlmTraceHelper predicate ===========================================

    @Test
    public void traceHelperAppliesToLlmCallWithResponseRef() throws Exception {
        MetaDataLoader loader = loader();
        MetaObject greetingCall = loader.getMetaObjectByName("acme::shop::GreetingCall");
        MetaObject author = loader.getMetaObjectByName("acme::shop::Author");
        MetaObject base = loader.getMetaObjectByName("metaobjects::ai::LlmCallBase");

        assertTrue("concrete LlmCallBase subclass with prompt @responseRef emits a trace helper",
            LlmTraceHelperGenerator.appliesTo(greetingCall));
        assertFalse("a plain entity does not extend LlmCallBase",
            LlmTraceHelperGenerator.appliesTo(author));
        assertFalse("the abstract base itself emits nothing",
            LlmTraceHelperGenerator.appliesTo(base));
    }

    // === template-based predicates ==========================================

    @Test
    public void renderHelperAppliesToEveryRenderableTemplate() throws Exception {
        MetaDataLoader loader = loader();
        MetaTemplate summaryOutput = template(loader, "SummaryOutput");
        MetaTemplate plainPrompt = template(loader, "PlainPrompt");

        // BOTH subtypes render (ADR-0052 — the subtype axis is direction, and a prompt
        // renders an outbound body just as an output does). This assertion used to read
        // assertFalse for the prompt, which is what left a template.prompt with no
        // generated render helper on this port: an adopter could parse a model's reply
        // from generated code but had to hand-roll the call that produced the prompt.
        assertTrue("a template.output renders",
            SpringRenderHelperGenerator.appliesTo(summaryOutput, loader));
        assertTrue("a template.prompt renders too — only what comes BACK differs",
            SpringRenderHelperGenerator.appliesTo(plainPrompt, loader));
        // The remaining negative is the only one the loader permits: it enforces
        // @payloadRef present and VO-resolving, so a non-VO / payload-less template
        // cannot be constructed, and a non-template node is what is left.
        assertFalse("a non-template node renders nothing",
            SpringRenderHelperGenerator.appliesTo(
                loader.getMetaObjectByName("acme::shop::Author"), loader));
    }

    // ADR-0052 — the two inbound predicates. Both negatives matter and they fail for
    // DIFFERENT reasons, which is what makes this pair a real test of the rule:
    // SummaryOutput is excluded by DIRECTION (a template.output renders outbound and
    // parses nothing, whatever its @format — and its @format is json, the value that
    // used to make it apply), PlainPrompt by having declared no response at all.

    @Test
    public void outputPromptAppliesToARespondingPromptOnly() throws Exception {
        MetaDataLoader loader = loader();
        MetaTemplate respondingPrompt = template(loader, "RespondingPrompt");
        MetaTemplate summaryOutput = template(loader, "SummaryOutput");
        MetaTemplate plainPrompt = template(loader, "PlainPrompt");

        assertTrue("a prompt declaring @responseRef gets a response-format fragment",
            SpringOutputPromptGenerator.appliesTo(respondingPrompt, loader));
        assertFalse("template.output is outbound only — no fragment even at @format=json",
            SpringOutputPromptGenerator.appliesTo(summaryOutput, loader));
        assertFalse("a prompt with no @responseRef elicits no typed reply",
            SpringOutputPromptGenerator.appliesTo(plainPrompt, loader));
    }

    @Test
    public void outputParserAppliesToARespondingPromptOnly() throws Exception {
        MetaDataLoader loader = loader();
        MetaTemplate respondingPrompt = template(loader, "RespondingPrompt");
        MetaTemplate summaryOutput = template(loader, "SummaryOutput");
        MetaTemplate plainPrompt = template(loader, "PlainPrompt");

        assertTrue("a prompt declaring @responseRef gets a parser",
            SpringOutputParserGenerator.appliesTo(respondingPrompt, loader));
        assertFalse("template.output is outbound only — no parser for text we just rendered",
            SpringOutputParserGenerator.appliesTo(summaryOutput, loader));
        assertFalse("a prompt with no @responseRef has nothing to parse",
            SpringOutputParserGenerator.appliesTo(plainPrompt, loader));
    }
}
