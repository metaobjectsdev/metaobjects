package com.metaobjects.generator.spring;

import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import com.metaobjects.object.MetaObject;

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
}
