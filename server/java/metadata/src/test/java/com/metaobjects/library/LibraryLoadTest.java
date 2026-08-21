package com.metaobjects.library;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import org.junit.Test;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * #332 — the Java port can load the MetaObjects-shipped library packages, so
 * {@code extends: "metaobjects::ai::LlmCallBase"} resolves.
 *
 * <p>The port shipped {@code LlmTraceHelperGenerator} with no way to load the metadata that
 * generator exists to consume: no {@code libraries} loader option and no embed. A generator
 * shipped without its input. Its tests stayed green only by declaring a bespoke
 * {@code LlmCallBase} inline under a different package — the bypass ADR-0024 already named
 * — which is how a port can ship a generator it cannot feed and never notice.</p>
 *
 * <p>The NEGATIVE arm is the half that proves the opt-in is doing the work: without it the
 * same model must still fail. A positive-only test keeps passing if the library is quietly
 * made unconditional, which would put its top-level nodes into the model — and the
 * generated output — of every project that never asked for one.</p>
 */
public class LibraryLoadTest {

    private static final String MODEL = String.join("\n",
        "{",
        "  \"metadata.root\": {",
        "    \"package\": \"acme::trace\",",
        "    \"children\": [",
        "      { \"object.entity\": {",
        "          \"name\": \"AgentCall\",",
        "          \"extends\": \"metaobjects::ai::LlmCallBase\",",
        "          \"children\": [",
        "            { \"source.rdb\": { \"@table\": \"agent_call\" } },",
        "            { \"identity.primary\": { \"name\": \"pk\", \"@fields\": [\"spanId\"] } }",
        "          ]",
        "      } }",
        "    ]",
        "  }",
        "}");

    private Path writeModel() throws IOException {
        Path dir = Files.createTempDirectory("mo-library-load-");
        Files.write(dir.resolve("trace.json"), MODEL.getBytes(StandardCharsets.UTF_8));
        return dir;
    }

    @Test
    public void librariesOptInMakesTheShippedBaseResolvable() throws IOException {
        Path dir = writeModel();
        MetaDataLoader loader = MetaDataLoader.fromDirectory(
            "library-load-positive", dir, new com.metaobjects.loader.DirectorySource.Options(),
            Collections.singletonList("ai"));

        // The library's own nodes are in the model...
        MetaObject base = loader.getMetaObjectByName("metaobjects::ai::LlmCallBase");
        assertNotNull("the shipped abstract base must load", base);

        // ...and the project's entity resolves its super against them, inheriting the fields.
        MetaObject agentCall = loader.getMetaObjectByName("acme::trace::AgentCall");
        assertNotNull("the project entity must load", agentCall);
        assertNotNull("traceId is inherited through extends, not declared here",
            agentCall.getMetaField("traceId"));
        assertTrue("no load errors expected", loader.getErrors().isEmpty());
    }

    @Test
    public void withoutTheOptInTheSameModelDoesNotResolve() throws IOException {
        Path dir = writeModel();
        MetaDataLoader loader = null;
        String failure = null;
        try {
            loader = MetaDataLoader.fromDirectory(
                "library-load-negative", dir, new com.metaobjects.loader.DirectorySource.Options());
        } catch (RuntimeException expected) {
            // The whole chain: the loader wraps the real diagnostic in a "Failed to load
            // from directory <path>" envelope that names nothing, so asserting on the top
            // message alone would prove only that SOMETHING went wrong.
            StringBuilder sb = new StringBuilder();
            for (Throwable t = expected; t != null; t = t.getCause()) {
                sb.append(t.getMessage()).append('\n');
            }
            failure = sb.toString();
        }
        if (loader != null) {
            assertNull("the shipped base must NOT be present without the opt-in",
                loader.getMetaObjectByName("metaobjects::ai::LlmCallBase"));
            assertFalse("an unresolved super must be reported, not silently accepted",
                loader.getErrors().isEmpty());
            failure = loader.getErrors().toString();
        }
        // Named, not merely non-empty: a bare "it failed" assertion would pass if the model
        // failed for any unrelated reason, which would make this arm prove nothing about
        // whether the opt-in is what supplies the base.
        assertTrue("the failure must name the unresolved library super, got: " + failure,
            failure != null && failure.contains("LlmCallBase"));
    }

    @Test
    public void anUnknownPackageContributesNoSourcesAndIsNotAnError() {
        // The cross-port contract for the PROGRAMMATIC door. A caller asking for a package
        // this version does not ship must still be able to load its own metadata; the
        // callers that read the name from a human (the Maven mojo) validate first.
        assertTrue(LibrarySources.librarySources(Arrays.asList("nosuchpackage")).isEmpty());
        assertTrue(LibrarySources.librarySources(null).isEmpty());
    }

    @Test
    public void knownPackagesNamesWhatThisBuildShips() {
        List<String> known = LibrarySources.knownPackages();
        assertTrue("the ai package ships", known.contains("ai"));
        assertEquals("sorted, so a diagnostic listing them is stable",
            new java.util.TreeSet<>(known).stream().collect(java.util.stream.Collectors.toList()),
            known);
    }

    /**
     * The freshness gate: the embed must equal the canonical tree byte for byte.
     *
     * <p>Skipped when the repo-root {@code library/} tree is unreachable — that is the
     * published-jar case, where there is nothing to compare against. In a checkout, which is
     * where this test actually runs, the comparison is live.</p>
     */
    @Test
    public void theEmbedIsByteIdenticalToTheCanonicalTree() {
        for (Map.Entry<String, String> e : EmbeddedLibrary.CONTENT.entrySet()) {
            String onDisk;
            try {
                onDisk = LibrarySources.onDiskContent(e.getKey());
            } catch (IOException io) {
                throw new UncheckedIOException(io);
            }
            if (onDisk == null) continue; // not a checkout — nothing to compare
            assertEquals(
                "EmbeddedLibrary is stale for ref \"" + e.getKey()
                    + "\" — run: bun run scripts/generate-embedded-library.ts",
                onDisk, e.getValue());
        }
    }
}
