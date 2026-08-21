package com.metaobjects.conformance;

import com.metaobjects.MetaData;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.parser.json.CanonicalJsonParser;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

import static org.junit.Assert.*;

/**
 * WA5 gate: the aligned cross-language vocabulary (object.entity/value +
 * source.rdb + @kind/@role + origin.passthrough + camelCase) loads and
 * canonical-round-trips byte-faithfully in Java. Negatively asserts that
 * none of the retired vocabulary (source.dbTable/dbView, object.pojo/map/
 * proxy, @javaRuntime) leaks back into canonical output.
 *
 * <p>Scope note: only {@code origin.passthrough} is exercised here; the
 * other origin subtypes ({@code origin.aggregate}, {@code origin.computed},
 * {@code origin.first}) are covered by their own conformance corpus fixtures.</p>
 */
public class AlignedVocabularyTest extends SharedRegistryTestBase {

    private static final String FIXTURE = "{ \"metadata.root\": { \"package\": \"acme::commerce\", \"children\": [" +
        "  { \"object.entity\": { \"name\": \"Program\", \"children\": [" +
        "    { \"source.rdb\":   { \"@role\": \"primary\", \"@table\": \"programs\" } }," +
        "    { \"field.long\":   { \"name\": \"id\" } }," +
        "    { \"field.string\": { \"name\": \"title\" } }," +
        "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
        "  ] } }," +
        "  { \"object.entity\": { \"name\": \"ProgramSummary\", \"extends\": \"Program\", \"children\": [" +
        "    { \"source.rdb\": { \"@kind\": \"view\", \"@role\": \"replica\", \"@table\": \"v_program\" } }," +
        "    { \"field.string\": { \"name\": \"displayTitle\", \"children\": [" +
        "      { \"origin.passthrough\": { \"@from\": \"Program.title\" } }" +
        "    ] } }," +
        "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
        "  ] } }," +
        "  { \"object.value\": { \"name\": \"Money\", \"children\": [" +
        "    { \"field.long\": { \"name\": \"cents\" } }" +
        "  ] } }" +
        "] } }";

    @Test public void alignedVocabularyLoadsAndRoundTrips() {
        MetaDataLoader loader = createTestLoader("AlignedVocabularyTest", Collections.emptyList());
        CanonicalJsonParser parser = new CanonicalJsonParser(loader, "aligned.json");
        parser.loadFromStream(new ByteArrayInputStream(FIXTURE.getBytes(StandardCharsets.UTF_8)));

        // Subtypes are case-preserved and present
        MetaData program = loader.getRoot().getChildOfType("object", "acme::commerce::Program");
        assertEquals("entity", program.getSubType());
        MetaData summary = loader.getRoot().getChildOfType("object", "acme::commerce::ProgramSummary");
        assertEquals("entity", summary.getSubType());
        MetaData money   = loader.getRoot().getChildOfType("object", "acme::commerce::Money");
        assertEquals("value", money.getSubType());

        // Canonical round-trip preserves the exact casing + attrs
        String json = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());
        assertTrue("expected object.entity", json.contains("\"object.entity\""));
        assertTrue("expected object.value",  json.contains("\"object.value\""));
        assertTrue("expected source.rdb",    json.contains("\"source.rdb\""));
        assertTrue("expected origin.passthrough", json.contains("\"origin.passthrough\""));
        assertTrue("expected @kind: view",   json.contains("\"@kind\": \"view\""));
        assertTrue("expected @role: primary",json.contains("\"@role\": \"primary\""));
        assertTrue("expected @role: replica",json.contains("\"@role\": \"replica\""));
        assertTrue("expected @table",        json.contains("\"@table\""));
        assertTrue("expected @from",         json.contains("\"@from\""));

        // Must NOT contain any retired vocabulary
        assertFalse("must not leak source.dbTable", json.contains("\"source.dbTable\""));
        assertFalse("must not leak source.dbView",  json.contains("\"source.dbView\""));
        assertFalse("must not leak object.pojo",    json.contains("\"object.pojo\""));
        assertFalse("must not leak object.map",     json.contains("\"object.map\""));
        assertFalse("must not leak object.proxy",   json.contains("\"object.proxy\""));
        assertFalse("must not leak @javaRuntime",   json.contains("javaRuntime"));
    }
}
