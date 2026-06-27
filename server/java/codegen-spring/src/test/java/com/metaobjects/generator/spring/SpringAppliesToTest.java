package com.metaobjects.generator.spring;

import com.metaobjects.MetaData;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
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
 *   <li>{@code SalesReport} — a {@code @kind="view"} entity (read-only).</li>
 *   <li>{@code AbstractEntity} — an {@code abstract} entity.</li>
 *   <li>{@code Address} — an {@code object.value} (not an entity).</li>
 *   <li>{@code SummaryOutput} — a {@code template.output @format=json} with a
 *       {@code @payloadRef} resolving to an {@code object.value}.</li>
 *   <li>{@code PlainPrompt} — a valid {@code template.prompt} (its {@code @payloadRef}
 *       resolves to a VO). It exercises the {@code template.output}-only predicates'
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
            { "object.entity": { "name": "LlmCallBase", "abstract": true, "children": [
                { "field.uuid":   { "name": "traceId" } },
                { "field.string": { "name": "status" } }
            ] } },
            { "object.value": { "name": "GreetResponse", "children": [
                { "field.string": { "name": "greeting", "@required": true } }
            ] } },
            { "object.entity": { "name": "GreetingCall",
              "extends": "acme::shop::LlmCallBase", "children": [
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
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "spring-applies-to");
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
    public void repositoryAppliesToTableEntityOnly() throws Exception {
        MetaDataLoader loader = loader();
        MetaObject author = loader.getMetaObjectByName("acme::shop::Author");
        MetaObject report = loader.getMetaObjectByName("acme::shop::SalesReport");
        MetaObject abstractEntity = loader.getMetaObjectByName("acme::shop::AbstractEntity");
        MetaObject address = loader.getMetaObjectByName("acme::shop::Address");

        assertTrue("table entity emits a repository", SpringRepositoryGenerator.appliesTo(author));
        assertFalse("view-kind entity has no writable repository", SpringRepositoryGenerator.appliesTo(report));
        assertFalse("abstract entity emits nothing", SpringRepositoryGenerator.appliesTo(abstractEntity));
        assertFalse("value object is not an entity", SpringRepositoryGenerator.appliesTo(address));
    }

    @Test
    public void controllerAppliesToTableEntityOnly() throws Exception {
        MetaDataLoader loader = loader();
        MetaObject author = loader.getMetaObjectByName("acme::shop::Author");
        MetaObject report = loader.getMetaObjectByName("acme::shop::SalesReport");
        MetaObject abstractEntity = loader.getMetaObjectByName("acme::shop::AbstractEntity");
        MetaObject address = loader.getMetaObjectByName("acme::shop::Address");

        assertTrue(SpringControllerGenerator.appliesTo(author));
        assertFalse(SpringControllerGenerator.appliesTo(report));
        assertFalse(SpringControllerGenerator.appliesTo(abstractEntity));
        assertFalse(SpringControllerGenerator.appliesTo(address));
    }

    @Test
    public void filterAllowlistAppliesToTableEntityOnly() throws Exception {
        MetaDataLoader loader = loader();
        MetaObject author = loader.getMetaObjectByName("acme::shop::Author");
        MetaObject report = loader.getMetaObjectByName("acme::shop::SalesReport");
        MetaObject abstractEntity = loader.getMetaObjectByName("acme::shop::AbstractEntity");
        MetaObject address = loader.getMetaObjectByName("acme::shop::Address");

        assertTrue(SpringFilterAllowlistGenerator.appliesTo(author));
        assertFalse(SpringFilterAllowlistGenerator.appliesTo(report));
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
        MetaObject base = loader.getMetaObjectByName("acme::shop::LlmCallBase");

        assertTrue("concrete LlmCallBase subclass with prompt @responseRef emits a trace helper",
            LlmTraceHelperGenerator.appliesTo(greetingCall));
        assertFalse("a plain entity does not extend LlmCallBase",
            LlmTraceHelperGenerator.appliesTo(author));
        assertFalse("the abstract base itself emits nothing",
            LlmTraceHelperGenerator.appliesTo(base));
    }

    // === template-based predicates ==========================================

    @Test
    public void payloadAppliesToAnyTemplateWithValueObjectPayloadRef() throws Exception {
        MetaDataLoader loader = loader();
        MetaTemplate summaryOutput = template(loader, "SummaryOutput");
        MetaTemplate plainPrompt = template(loader, "PlainPrompt");
        MetaObject author = loader.getMetaObjectByName("acme::shop::Author");
        assertNotNull(summaryOutput);

        // Payload records are emitted for EVERY template subtype (prompt/output/toolcall)
        // that carries a VO @payloadRef — both the output and the prompt apply here.
        assertTrue(SpringPayloadGenerator.appliesTo(summaryOutput, loader));
        assertTrue(SpringPayloadGenerator.appliesTo(plainPrompt, loader));
        // A non-template node never applies.
        assertFalse("an object.entity is not a template", SpringPayloadGenerator.appliesTo(author, loader));
    }

    @Test
    public void renderHelperAppliesToOutputWithValueObjectPayloadRef() throws Exception {
        MetaDataLoader loader = loader();
        MetaTemplate summaryOutput = template(loader, "SummaryOutput");
        MetaTemplate plainPrompt = template(loader, "PlainPrompt");

        assertTrue(SpringRenderHelperGenerator.appliesTo(summaryOutput, loader));
        assertFalse(SpringRenderHelperGenerator.appliesTo(plainPrompt, loader));
    }

    @Test
    public void outputPromptAppliesToJsonXmlOutputWithPayloadRef() throws Exception {
        MetaDataLoader loader = loader();
        MetaTemplate summaryOutput = template(loader, "SummaryOutput");
        MetaTemplate plainPrompt = template(loader, "PlainPrompt");

        assertTrue("json output with VO payloadRef gets a prompt fragment",
            SpringOutputPromptGenerator.appliesTo(summaryOutput, loader));
        assertFalse(SpringOutputPromptGenerator.appliesTo(plainPrompt, loader));
    }

    @Test
    public void outputParserAppliesToOutputWithPayloadRef() throws Exception {
        MetaDataLoader loader = loader();
        MetaTemplate summaryOutput = template(loader, "SummaryOutput");
        MetaTemplate plainPrompt = template(loader, "PlainPrompt");

        assertTrue(SpringOutputParserGenerator.appliesTo(summaryOutput, loader));
        assertFalse(SpringOutputParserGenerator.appliesTo(plainPrompt, loader));
    }
}
