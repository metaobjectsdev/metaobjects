package com.metaobjects.generator.spring;

import com.metaobjects.MetaData;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import com.metaobjects.object.MetaObject;
import com.metaobjects.template.MetaTemplate;
import com.metaobjects.template.TemplateConstants;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * Test-only helper: write a literal JSON fixture string to a temp file and
 * spin up a {@link MetaDataLoader} pointed at it. Mirrors the
 * {@code loadString} helper in {@code metadata-ktx} (Kotlin), reimplemented
 * inline here because the Spring module is a plain Java module and pulling
 * {@code metadata-ktx} into its test scope would force Kotlin into the
 * test classpath for no other reason.
 *
 * <p>Each call creates a fresh, isolated loader so tests don't bleed state.
 * The shared registry (via {@code SharedRegistryTestBase}) is still picked
 * up because {@code MetaDataLoader} delegates to the same singleton
 * {@code MetaDataRegistry}.</p>
 */
public final class SpringTestFixtures {

    private SpringTestFixtures() { /* no instances */ }

    // -------------------------------------------------------------------------
    // Fixtures
    // -------------------------------------------------------------------------

    /**
     * Inline metadata declaring one {@code object.value} for output-codegen unit tests.
     * Package: {@code acme::ai}.
     * Fields: {@code text} (string, required), {@code confidence} (enum, required,
     * values HIGH/OK/LOW, alias medium→OK), {@code note} (string, optional).
     */
    static final String EXTRACT_VO_FIXTURE = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "AnswerOutputPayload", "children": [
                { "field.string":  { "name": "text",       "@required": true } },
                { "field.enum":    { "name": "confidence", "@required": true,
                                    "@values": ["HIGH","OK","LOW"],
                                    "@enumAlias": { "medium": "OK" } } },
                { "field.string":  { "name": "note" } }
            ] } }
          ] }
        }
        """;

    /**
     * Inline metadata for {@link OutputFormatSpecEmitter} unit tests.
     * Package: {@code acme::ai}.
     *
     * <p>VO: {@code AnswerOutputPayload} with fields:
     * <ul>
     *   <li>{@code text}: string, {@code @required: true}, {@code @example: "hello"},
     *       {@code @instruction: "one sentence"}</li>
     *   <li>{@code confidence}: enum, {@code @required: true},
     *       values HIGH/OK/LOW, {@code @enumDoc: {HIGH:"Directly supported.",OK:"Inference."}}</li>
     *   <li>{@code note}: string, optional</li>
     * </ul>
     *
     * <p>Template: {@code template.output} named {@code AnswerOutput},
     * {@code @payloadRef: AnswerOutputPayload}, {@code @textRef: "ai/answer"},
     * {@code @format: "xml"}, {@code @promptStyle: "guide"}.
     */
    static final String PROMPT_VO_FIXTURE = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "AnswerOutputPayload", "children": [
                { "field.string": { "name": "text",       "@required": true,
                                   "@example": "hello", "@instruction": "one sentence" } },
                { "field.enum":   { "name": "confidence", "@required": true,
                                   "@values": ["HIGH","OK","LOW"],
                                   "@enumDoc": { "HIGH": "Directly supported.", "OK": "Inference." } } },
                { "field.string": { "name": "note" } }
            ] } },
            { "template.output": {
                "name": "AnswerOutput",
                "@payloadRef": "AnswerOutputPayload",
                "@textRef": "ai/answer",
                "@format": "xml",
                "@promptStyle": "guide"
            } }
          ] }
        }
        """;

    /**
     * Inline metadata combining {@link #EXTRACT_VO_FIXTURE}'s {@code AnswerOutputPayload}
     * VO with a {@code template.output} named {@code AnswerOutput} ({@code @format: json})
     * for end-to-end {@link SpringOutputParserGenerator} extract-codegen tests.
     * Package: {@code acme::ai}.
     */
    static final String EXTRACT_OUTPUT_FIXTURE = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "AnswerOutputPayload", "children": [
                { "field.string":  { "name": "text",       "@required": true } },
                { "field.enum":    { "name": "confidence", "@required": true,
                                    "@values": ["HIGH","OK","LOW"],
                                    "@enumAlias": { "medium": "OK" } } },
                { "field.enum":    { "name": "priority",   "@required": true,
                                    "@values": ["HIGH","OK","LOW"],
                                    "@normalize": "none",
                                    "@coerceDefault": "LOW" } },
                { "field.string":  { "name": "note" } }
            ] } },
            { "template.output": {
                "name": "AnswerOutput",
                "@payloadRef": "AnswerOutputPayload",
                "@textRef": "ai/answer",
                "@format": "json"
            } }
          ] }
        }
        """;

    /**
     * Plan 2.1 nested fixture: an {@code object.value} payload with a single nested
     * object field AND an array-of-objects field, plus a {@code template.output}
     * (json) referencing it. Proves the runtime-delegating {@code extractLenient(loader, text)}
     * populates nested + array-of-object components (the historical FR-010 codegen gap).
     * Package: {@code acme::ai}.
     *
     * <ul>
     *   <li>{@code NestedAnswerPayload}: {@code title} (string, required),
     *       {@code address} (object → {@code AddressPayload}, single),
     *       {@code items} (object → {@code LineItemPayload}, array).</li>
     *   <li>{@code AddressPayload}: {@code city} (string), {@code zip} (string).</li>
     *   <li>{@code LineItemPayload}: {@code sku} (string), {@code qty} (int).</li>
     * </ul>
     */
    static final String EXTRACT_NESTED_FIXTURE = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "AddressPayload", "children": [
                { "field.string": { "name": "city" } },
                { "field.string": { "name": "zip" } }
            ] } },
            { "object.value": { "name": "LineItemPayload", "children": [
                { "field.string": { "name": "sku" } },
                { "field.int":    { "name": "qty" } }
            ] } },
            { "object.value": { "name": "NestedAnswerPayload", "children": [
                { "field.string": { "name": "title", "@required": true } },
                { "field.object": { "name": "address", "@objectRef": "acme::ai::AddressPayload" } },
                { "field.object": { "name": "items", "@objectRef": "acme::ai::LineItemPayload",
                                    "isArray": true } }
            ] } },
            { "template.output": {
                "name": "NestedAnswer",
                "@payloadRef": "NestedAnswerPayload",
                "@textRef": "ai/nested",
                "@format": "json"
            } }
          ] }
        }
        """;

    /**
     * Typed-enums fixture: a json {@code template.output} whose payload carries a scalar
     * {@code field.enum} ({@code priority}, values LOW/HIGH) AND an enum array
     * ({@code labels}, values A/B). Proves the strict {@code <Name>Payload} record types the
     * enum component as a generated nested Java {@code enum} (single → {@code Priority};
     * array → {@code List<Labels>}) and the extract mapper coerces via {@code valueOf}.
     * Package: {@code acme::ai}. VO: {@code OrderPayload}; template: {@code Order}.
     */
    static final String TYPED_ENUM_FIXTURE = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "OrderPayload", "children": [
                { "field.string": { "name": "title", "@required": true } },
                { "field.enum":   { "name": "priority", "@required": true,
                                    "@values": ["LOW","HIGH"] } },
                { "field.enum":   { "name": "labels", "isArray": true, "@required": true,
                                    "@values": ["A","B"] } }
            ] } },
            { "template.output": {
                "name": "Order",
                "@payloadRef": "OrderPayload",
                "@textRef": "ai/order",
                "@format": "json"
            } }
          ] }
        }
        """;

    /**
     * Shared-abstract-enum fixture: an abstract {@code field.enum Priority} (values LOW/HIGH)
     * plus two payload fields ({@code currentPriority}, {@code previousPriority}) that
     * {@code extends} it. Proves the generator emits EXACTLY ONE nested {@code enum Priority}
     * (named for the super, deduped) and types BOTH fields {@code Priority}.
     * Package: {@code acme::orders}. VO: {@code TicketPayload}; template: {@code Ticket}.
     */
    static final String SHARED_ENUM_FIXTURE = """
        {
          "metadata.root": { "package": "acme::orders", "children": [
            { "field.enum": { "name": "Priority", "abstract": true, "@values": ["LOW","HIGH"] } },
            { "object.value": { "name": "TicketPayload", "children": [
                { "field.string": { "name": "ticketId", "@required": true } },
                { "field.enum":   { "name": "currentPriority",  "@required": true, "extends": "Priority" } },
                { "field.enum":   { "name": "previousPriority", "@required": true, "extends": "Priority" } }
            ] } },
            { "template.output": {
                "name": "Ticket",
                "@payloadRef": "TicketPayload",
                "@textRef": "orders/ticket",
                "@format": "json"
            } }
          ] }
        }
        """;

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /**
     * Write {@code fixtureJson} to a temp file under {@code parent} and return
     * a fresh {@link MetaDataLoader} initialised against it.
     *
     * @param parent     test-local temp directory the fixture file is written under
     * @param baseName   filename stem (will be suffixed with {@code .json})
     * @param fixtureJson literal canonical-JSON fixture text
     */
    public static MetaDataLoader loadFixture(Path parent, String baseName, String fixtureJson) throws IOException {
        Path fixture = parent.resolve(baseName + ".json");
        Files.writeString(fixture, fixtureJson);
        URI uri = URIHelper.toURI("model:file:" + fixture.toAbsolutePath().toString().replace('\\', '/'));
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL,
            "spring-test-" + baseName);
        loader.setSourceURIs(List.of(uri));
        loader.init();
        return loader;
    }

    /**
     * Load the inline {@code fixtureJson} string into a fresh loader (writing to
     * a system temp file) and return the named value-object, resolved by short
     * name or FQN. Throws {@link IllegalStateException} when the VO cannot be
     * found, so test failures are explicit rather than silent NPE.
     *
     * @param fixtureJson canonical-JSON fixture text
     * @param voName      short name or FQN of the target {@code object.value}
     */
    static MetaObject loadVo(String fixtureJson, String voName) throws IOException {
        Path tmp = Files.createTempDirectory("spring-test-vo");
        MetaDataLoader loader = loadFixture(tmp, "vo-fixture", fixtureJson);
        for (MetaObject mo : loader.getMetaObjects()) {
            String fqn = mo.getName();
            String shortName = fqn.contains("::") ? fqn.substring(fqn.lastIndexOf("::") + 2) : fqn;
            if (fqn.equals(voName) || shortName.equals(voName)) {
                return mo;
            }
        }
        throw new IllegalStateException(
            "MetaObject '" + voName + "' not found in fixture. Available: " + loader.getMetaObjects());
    }

    /**
     * Load the inline {@code fixtureJson} string into a fresh loader and return the
     * named {@code template.output} (or {@code template.prompt}), resolved by short
     * name or FQN. Iterates {@link MetaDataLoader#getRoot()}'s children looking for
     * a {@link MetaTemplate} with a matching name.
     *
     * <p>Throws {@link IllegalStateException} when the template cannot be found.</p>
     *
     * @param fixtureJson   canonical-JSON fixture text
     * @param templateName  short name or FQN of the target {@code template.*}
     */
    static MetaTemplate loadTemplate(String fixtureJson, String templateName) throws IOException {
        Path tmp = Files.createTempDirectory("spring-test-tmpl");
        MetaDataLoader loader = loadFixture(tmp, "tmpl-fixture", fixtureJson);
        for (MetaData child : loader.getRoot().getChildren()) {
            if (!(child instanceof MetaTemplate t)) continue;
            String fqn = t.getName();
            String shortName = fqn.contains("::") ? fqn.substring(fqn.lastIndexOf("::") + 2) : fqn;
            if (fqn.equals(templateName) || shortName.equals(templateName)) {
                return t;
            }
        }
        throw new IllegalStateException(
            "MetaTemplate '" + templateName + "' not found in fixture.");
    }

    /**
     * Convenience overload that loads both the VO and its associated template
     * from the same fixture JSON in a single loader pass. Returns a two-element
     * array: {@code [0]} = the {@link MetaObject} VO, {@code [1]} = the
     * {@link MetaTemplate}.
     *
     * @param fixtureJson  canonical-JSON fixture text
     * @param voName       short name or FQN of the target {@code object.value}
     * @param templateName short name or FQN of the target {@code template.*}
     */
    static Object[] loadVoAndTemplate(String fixtureJson, String voName, String templateName)
            throws IOException {
        Path tmp = Files.createTempDirectory("spring-test-vt");
        MetaDataLoader loader = loadFixture(tmp, "vt-fixture", fixtureJson);

        MetaObject foundVo = null;
        for (MetaObject mo : loader.getMetaObjects()) {
            String fqn = mo.getName();
            String shortName = fqn.contains("::") ? fqn.substring(fqn.lastIndexOf("::") + 2) : fqn;
            if (fqn.equals(voName) || shortName.equals(voName)) {
                foundVo = mo;
                break;
            }
        }
        if (foundVo == null) {
            throw new IllegalStateException(
                "MetaObject '" + voName + "' not found in fixture.");
        }

        MetaTemplate foundTmpl = null;
        for (MetaData child : loader.getRoot().getChildren()) {
            if (!(child instanceof MetaTemplate t)) continue;
            String fqn = t.getName();
            String shortName = fqn.contains("::") ? fqn.substring(fqn.lastIndexOf("::") + 2) : fqn;
            if (fqn.equals(templateName) || shortName.equals(templateName)) {
                foundTmpl = t;
                break;
            }
        }
        if (foundTmpl == null) {
            throw new IllegalStateException(
                "MetaTemplate '" + templateName + "' not found in fixture.");
        }

        return new Object[]{ foundVo, foundTmpl };
    }
}
