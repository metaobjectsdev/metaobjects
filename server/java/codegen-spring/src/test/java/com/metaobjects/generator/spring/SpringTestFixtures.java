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
final class SpringTestFixtures {

    private SpringTestFixtures() { /* no instances */ }

    // -------------------------------------------------------------------------
    // Fixtures
    // -------------------------------------------------------------------------

    /**
     * Inline metadata declaring one {@code object.value} for
     * {@link RecoverSchemaEmitter} unit tests. Package: {@code acme::ai}.
     * Fields: {@code text} (string, required), {@code confidence} (enum, required,
     * values HIGH/OK/LOW, alias medium→OK), {@code note} (string, optional).
     */
    static final String RECOVER_VO_FIXTURE = """
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
     * Inline metadata declaring an {@code object.value} whose single enum field has
     * 12 {@code @enumAlias} entries — more than the 10-pair limit of
     * {@code java.util.Map.of}. Used by {@link RecoverSchemaEmitterTest} to verify that
     * {@link RecoverSchemaEmitter} emits {@code Map.ofEntries} instead of {@code Map.of}.
     * Package: {@code acme::ai}. VO: {@code BigAliasPayload}.
     * Field: {@code label} (enum, required, values HIGH/LOW, aliases a1..a12 → HIGH).
     */
    static final String RECOVER_BIG_ALIAS_FIXTURE = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "BigAliasPayload", "children": [
                { "field.enum": { "name": "label", "@required": true,
                                  "@values": ["HIGH","LOW"],
                                  "@enumAlias": {
                                    "a1": "HIGH", "a2": "HIGH", "a3": "HIGH",
                                    "a4": "HIGH", "a5": "HIGH", "a6": "HIGH",
                                    "a7": "HIGH", "a8": "HIGH", "a9": "HIGH",
                                    "a10": "HIGH", "a11": "HIGH", "a12": "HIGH"
                                  } } }
            ] } }
          ] }
        }
        """;

    /**
     * FR-011 fixture: an {@code object.value} carrying an object-level {@code @normalize}
     * default, plus enum fields exercising {@code @coerceDefault} and normalize resolution.
     * Package: {@code acme::ai}. VO: {@code Fr011Payload}.
     * <ul>
     *   <li>{@code status}: enum HIGH/OK/LOW, owns {@code @coerceDefault: "LOW"}, no own
     *       {@code @normalize} → inherits the object default {@code "collapse"}.</li>
     *   <li>{@code phase}: enum HIGH/OK/LOW, owns {@code @normalize: "none"} (overrides object).</li>
     *   <li>{@code plain}: enum HIGH/OK/LOW, no FR-011 attrs but inherits object {@code "collapse"}.</li>
     * </ul>
     */
    static final String RECOVER_FR011_FIXTURE = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "Fr011Payload", "@normalize": "collapse", "children": [
                { "field.enum": { "name": "status", "@required": true,
                                  "@values": ["HIGH","OK","LOW"],
                                  "@coerceDefault": "LOW" } },
                { "field.enum": { "name": "phase", "@required": true,
                                  "@values": ["HIGH","OK","LOW"],
                                  "@normalize": "none" } },
                { "field.enum": { "name": "plain", "@required": false,
                                  "@values": ["HIGH","OK","LOW"] } }
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
     * Inline metadata combining {@link #RECOVER_VO_FIXTURE}'s {@code AnswerOutputPayload}
     * VO with a {@code template.output} named {@code AnswerOutput} ({@code @format: json})
     * for end-to-end {@link SpringOutputParserGenerator} recover-codegen tests.
     * Package: {@code acme::ai}.
     */
    static final String RECOVER_OUTPUT_FIXTURE = """
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
     * (json) referencing it. Proves the runtime-delegating {@code recover(loader, text)}
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
    static final String RECOVER_NESTED_FIXTURE = """
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
    static MetaDataLoader loadFixture(Path parent, String baseName, String fixtureJson) throws IOException {
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
