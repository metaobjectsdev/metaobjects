/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.loader;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.source.ErrorSource;
import com.metaobjects.source.ResolvedSource;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * FR5d — reference-resolution errors emit {@code format=resolved} with
 * {@code referrer} + {@code target}.
 *
 * <p>Covers the five reference sites listed in
 * {@code docs/superpowers/specs/2026-05-25-fr5d-reference-resolution-errors.md}:</p>
 * <ol>
 *   <li>{@code extends:} — {@code ERR_UNRESOLVED_SUPER}</li>
 *   <li>{@code @payloadRef} on {@code template.*} — {@code ERR_INVALID_TEMPLATE}</li>
 *   <li>{@code @requiredSlots} field-on-payload ref ({@code template.*})</li>
 *   <li>{@code @via} path on origin — {@code ERR_INVALID_ORIGIN}</li>
 *   <li>{@code @of} / {@code @from} path on origin — {@code ERR_INVALID_ORIGIN}</li>
 * </ol>
 *
 * <p>Per the FR5d cross-port-safety stance (option b in the prompt), Java emits
 * the new {@code format=resolved} envelope but the cross-port fixtures stay on
 * the FR5a {@code format=json} envelope until all four ports ship FR5d. These
 * unit tests assert the in-process Java shape directly.</p>
 *
 * <p>Mirrors the TS reference in
 * {@code server/typescript/packages/metadata/test/fr5d-reference-resolution-errors.test.ts}.</p>
 *
 * <p><strong>Referrer FQN contract:</strong> the FR5d {@code referrer} is the
 * bare (short) name of the declaring node, matching the TS reference — TS's
 * {@code MetaData.fqn()} does NOT propagate the root {@code package:} to
 * root-level objects (so {@code obj.fqn()} returns {@code "Premium"}, not
 * {@code "acme::Premium"}). Java's {@code MetaData.getName()} DOES propagate the
 * root package, so the FR5d throw sites use {@link com.metaobjects.MetaData#getShortName()}
 * to emit the same bare form. Cross-port byte-identical envelopes.</p>
 */
public class Fr5dReferenceResolutionTest extends SharedRegistryTestBase {

    private MetaDataLoader newTestLoader() {
        return createTestLoader("Fr5dReferenceResolutionTest", Collections.emptyList());
    }

    /**
     * Assert that {@code ex} carries a {@link ResolvedSource} envelope with the
     * expected code, referrer FQN, and target ref string. {@code expectedFiles}
     * is optional — when non-null, the resolved envelope's {@code files} must
     * match exactly.
     */
    private static void assertResolved(MetaDataException ex,
                                       ErrorCode expectedCode,
                                       String expectedReferrer,
                                       String expectedTarget,
                                       List<String> expectedFiles) {
        assertTrue("expected error code " + expectedCode + ", got: " + ex.getCode(),
            ex.getCode().map(c -> c == expectedCode).orElse(false));
        assertTrue("expected populated envelope on FR5d error",
            ex.getEnvelope().isPresent());
        ErrorSource envelope = ex.getEnvelope().get();
        assertTrue("envelope must be a ResolvedSource (format=resolved), got "
                + envelope.getClass().getSimpleName(),
            envelope instanceof ResolvedSource);
        ResolvedSource rs = (ResolvedSource) envelope;
        assertEquals("format must be 'resolved'", "resolved", rs.format());
        assertEquals("referrer FQN mismatch", expectedReferrer, rs.referrer());
        assertEquals("target ref mismatch", expectedTarget, rs.target());
        if (expectedFiles != null) {
            assertEquals("resolved envelope files mismatch", expectedFiles, rs.files());
        } else {
            assertNotNull("files must always be present on a resolved envelope",
                rs.files());
        }
    }

    // =========================================================================
    // 1 — extends: emits format=resolved
    // =========================================================================

    @Test
    public void extendsUnresolved_referrerIsEntityFqn_targetIsMissingSuper() {
        String canonical = "{ \"metadata.root\": {"
            + "\"package\": \"acme\","
            + "\"children\": ["
            + "  { \"object.entity\": {"
            + "    \"name\": \"Premium\","
            + "    \"extends\": \"DoesNotExist\","
            + "    \"children\": ["
            + "      { \"field.long\": { \"name\": \"id\" } },"
            + "      { \"identity.primary\": { \"@fields\": \"id\" } }"
            + "    ]"
            + "  } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        try {
            loader.load(List.of(new InMemoryStringSource(canonical, "meta.bad.json")));
            fail("expected MetaDataException for unresolved extends");
        } catch (MetaDataException ex) {
            // FR5d referrer is the bare (short) name, matching TS/C#/Python —
            // the reference contract does not propagate the root `package:` to
            // root-level objects.
            assertResolved(ex,
                ErrorCode.ERR_UNRESOLVED_SUPER,
                "Premium",
                "DoesNotExist",
                List.of("meta.bad.json"));
        }
    }

    // =========================================================================
    // 2 — @payloadRef emits format=resolved
    // =========================================================================

    @Test
    public void payloadRefUnresolved_referrerIsTemplateFqn_targetIsBadPayloadRef() {
        // Template @payloadRef points at a non-existent VO.
        String canonical = "{ \"metadata.root\": {"
            + "\"package\": \"acme::ai\","
            + "\"children\": ["
            + "  { \"object.entity\": {"
            + "    \"name\": \"Npc\","
            + "    \"children\": ["
            + "      { \"field.string\": { \"name\": \"name\" } },"
            + "      { \"identity.primary\": { \"@fields\": \"name\" } }"
            + "    ]"
            + "  } },"
            + "  { \"template.prompt\": {"
            + "    \"name\": \"npcTurn\","
            + "    \"@payloadRef\": \"NpcPromptPayload\","
            + "    \"@textRef\": \"npc/turn\","
            + "    \"@format\": \"xml\""
            + "  } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        try {
            loader.load(List.of(new InMemoryStringSource(canonical, "meta.ai.json")));
            fail("expected MetaDataException for unresolved @payloadRef");
        } catch (MetaDataException ex) {
            // FR5d referrer is the bare template name (matches TS/C#/Python).
            assertResolved(ex,
                ErrorCode.ERR_INVALID_TEMPLATE,
                "npcTurn",
                "NpcPromptPayload",
                List.of("meta.ai.json"));
        }
    }

    @Test
    public void requiredSlotsMissingField_targetIsPayloadRefDotSlot() {
        // @requiredSlots references a field that doesn't exist on the payload VO.
        String canonical = "{ \"metadata.root\": {"
            + "\"package\": \"acme::ai\","
            + "\"children\": ["
            + "  { \"object.value\": {"
            + "    \"name\": \"PromptPayload\","
            + "    \"children\": [ { \"field.string\": { \"name\": \"name\" } } ]"
            + "  } },"
            + "  { \"template.prompt\": {"
            + "    \"name\": \"tmpl\","
            + "    \"@payloadRef\": \"PromptPayload\","
            + "    \"@textRef\": \"tmpl/x\","
            + "    \"@format\": \"xml\","
            + "    \"@requiredSlots\": [\"name\", \"doesNotExist\"]"
            + "  } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        try {
            loader.load(List.of(new InMemoryStringSource(canonical, "meta.ai.json")));
            fail("expected MetaDataException for missing @requiredSlots field");
        } catch (MetaDataException ex) {
            assertResolved(ex,
                ErrorCode.ERR_INVALID_TEMPLATE,
                "tmpl",
                "PromptPayload.doesNotExist",
                List.of("meta.ai.json"));
            // Message must name the bad slot for human readability.
            assertTrue("message should name the missing slot, got: " + ex.getMessage(),
                ex.getMessage().contains("doesNotExist"));
        }
    }

    // =========================================================================
    // 3 — @via emits format=resolved, with deepest-valid-prefix in the message
    // =========================================================================

    @Test
    public void viaToNonExistentRelationship_targetIsFullRef_messageNamesDeepestValidPrefix() {
        String canonical = "{ \"metadata.root\": {"
            + "\"package\": \"acme::commerce\","
            + "\"children\": ["
            + "  { \"object.entity\": {"
            + "    \"name\": \"Program\","
            + "    \"children\": ["
            + "      { \"field.long\": { \"name\": \"id\" } },"
            + "      { \"field.string\": { \"name\": \"title\" } },"
            + "      { \"identity.primary\": { \"@fields\": \"id\" } }"
            + "    ]"
            + "  } },"
            + "  { \"object.entity\": {"
            + "    \"name\": \"ProgramSummary\","
            + "    \"extends\": \"Program\","
            + "    \"children\": ["
            + "      { \"source.rdb\": { \"@kind\": \"view\", \"@table\": \"v_program_summary\" } },"
            + "      { \"field.int\": { \"name\": \"weekCount\", \"children\": ["
            + "        { \"origin.aggregate\": {"
            + "          \"@agg\": \"count\","
            + "          \"@of\": \"Program.id\","
            + "          \"@via\": \"Program.notARealRelationship\""
            + "        } }"
            + "      ] } },"
            + "      { \"identity.primary\": { \"@fields\": \"id\" } }"
            + "    ]"
            + "  } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        try {
            loader.load(List.of(new InMemoryStringSource(canonical, "meta.commerce.json")));
            fail("expected MetaDataException for invalid @via path");
        } catch (MetaDataException ex) {
            assertResolved(ex,
                ErrorCode.ERR_INVALID_ORIGIN,
                "ProgramSummary::weekCount",
                "Program.notARealRelationship",
                List.of("meta.commerce.json"));
            // Deepest-valid-prefix is "Program" — the entity resolved before the
            // relationship hop failed.
            assertTrue(
                "message must name the deepest valid prefix, got: " + ex.getMessage(),
                ex.getMessage().contains("Deepest valid prefix was \"Program\""));
        }
    }

    @Test
    public void multiHopVia_deepestValidPrefixNamesHopThatDidResolve() {
        String canonical = "{ \"metadata.root\": {"
            + "\"package\": \"acme::commerce\","
            + "\"children\": ["
            + "  { \"object.entity\": {"
            + "    \"name\": \"Week\","
            + "    \"children\": ["
            + "      { \"field.long\": { \"name\": \"id\" } },"
            + "      { \"identity.primary\": { \"@fields\": \"id\" } }"
            + "    ]"
            + "  } },"
            + "  { \"object.entity\": {"
            + "    \"name\": \"Program\","
            + "    \"children\": ["
            + "      { \"field.long\": { \"name\": \"id\" } },"
            + "      { \"relationship.association\": { \"name\": \"weeks\", \"@objectRef\": \"Week\" } },"
            + "      { \"identity.primary\": { \"@fields\": \"id\" } }"
            + "    ]"
            + "  } },"
            + "  { \"object.entity\": {"
            + "    \"name\": \"ProgramSummary\","
            + "    \"extends\": \"Program\","
            + "    \"children\": ["
            + "      { \"source.rdb\": { \"@kind\": \"view\", \"@table\": \"v\" } },"
            + "      { \"field.int\": { \"name\": \"deepCount\", \"children\": ["
            + "        { \"origin.aggregate\": {"
            + "          \"@agg\": \"count\","
            + "          \"@of\": \"Week.id\","
            + "          \"@via\": \"Program.weeks.notReal\""
            + "        } }"
            + "      ] } },"
            + "      { \"identity.primary\": { \"@fields\": \"id\" } }"
            + "    ]"
            + "  } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        try {
            loader.load(List.of(new InMemoryStringSource(canonical, "meta.json")));
            fail("expected MetaDataException for invalid multi-hop @via");
        } catch (MetaDataException ex) {
            assertResolved(ex,
                ErrorCode.ERR_INVALID_ORIGIN,
                "ProgramSummary::deepCount",
                "Program.weeks.notReal",
                null);
            // The walk got past Program.weeks (resolved to Week) and failed on
            // .notReal — so the deepest-valid-prefix is "Program.weeks".
            assertTrue(
                "message must name multi-hop deepest valid prefix, got: " + ex.getMessage(),
                ex.getMessage().contains("Deepest valid prefix was \"Program.weeks\""));
        }
    }

    // =========================================================================
    // 4 — @of / @from emits format=resolved
    // =========================================================================

    @Test
    public void aggregateOf_nonExistentEntity_referrerIsProjectionFqnDoubleColonField() {
        String canonical = "{ \"metadata.root\": {"
            + "\"package\": \"acme::commerce\","
            + "\"children\": ["
            + "  { \"object.entity\": {"
            + "    \"name\": \"Program\","
            + "    \"children\": ["
            + "      { \"field.long\": { \"name\": \"id\" } },"
            + "      { \"relationship.association\": { \"name\": \"weeks\", \"@objectRef\": \"Week\" } },"
            + "      { \"identity.primary\": { \"@fields\": \"id\" } }"
            + "    ]"
            + "  } },"
            + "  { \"object.entity\": {"
            + "    \"name\": \"Week\","
            + "    \"children\": ["
            + "      { \"field.long\": { \"name\": \"id\" } },"
            + "      { \"identity.primary\": { \"@fields\": \"id\" } }"
            + "    ]"
            + "  } },"
            + "  { \"object.entity\": {"
            + "    \"name\": \"ProgramSummary\","
            + "    \"extends\": \"Program\","
            + "    \"children\": ["
            + "      { \"source.rdb\": { \"@kind\": \"view\", \"@table\": \"v\" } },"
            + "      { \"field.int\": { \"name\": \"weekCount\", \"children\": ["
            + "        { \"origin.aggregate\": {"
            + "          \"@agg\": \"count\","
            + "          \"@of\": \"GhostEntity.id\","
            + "          \"@via\": \"Program.weeks\""
            + "        } }"
            + "      ] } },"
            + "      { \"identity.primary\": { \"@fields\": \"id\" } }"
            + "    ]"
            + "  } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        try {
            loader.load(List.of(new InMemoryStringSource(canonical, "meta.json")));
            fail("expected MetaDataException for unresolved @of entity");
        } catch (MetaDataException ex) {
            assertResolved(ex,
                ErrorCode.ERR_INVALID_ORIGIN,
                "ProgramSummary::weekCount",
                "GhostEntity.id",
                null);
        }
    }

    @Test
    public void aggregateOf_existingEntityButMissingField_targetIsFullRef() {
        String canonical = "{ \"metadata.root\": {"
            + "\"package\": \"acme::commerce\","
            + "\"children\": ["
            + "  { \"object.entity\": {"
            + "    \"name\": \"Program\","
            + "    \"children\": ["
            + "      { \"field.long\": { \"name\": \"id\" } },"
            + "      { \"relationship.association\": { \"name\": \"weeks\", \"@objectRef\": \"Week\" } },"
            + "      { \"identity.primary\": { \"@fields\": \"id\" } }"
            + "    ]"
            + "  } },"
            + "  { \"object.entity\": {"
            + "    \"name\": \"Week\","
            + "    \"children\": ["
            + "      { \"field.long\": { \"name\": \"id\" } },"
            + "      { \"identity.primary\": { \"@fields\": \"id\" } }"
            + "    ]"
            + "  } },"
            + "  { \"object.entity\": {"
            + "    \"name\": \"ProgramSummary\","
            + "    \"extends\": \"Program\","
            + "    \"children\": ["
            + "      { \"source.rdb\": { \"@kind\": \"view\", \"@table\": \"v\" } },"
            + "      { \"field.int\": { \"name\": \"weekCount\", \"children\": ["
            + "        { \"origin.aggregate\": {"
            + "          \"@agg\": \"count\","
            + "          \"@of\": \"Week.ghostField\","
            + "          \"@via\": \"Program.weeks\""
            + "        } }"
            + "      ] } },"
            + "      { \"identity.primary\": { \"@fields\": \"id\" } }"
            + "    ]"
            + "  } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        try {
            loader.load(List.of(new InMemoryStringSource(canonical, "meta.json")));
            fail("expected MetaDataException for unresolved @of field");
        } catch (MetaDataException ex) {
            assertResolved(ex,
                ErrorCode.ERR_INVALID_ORIGIN,
                "ProgramSummary::weekCount",
                "Week.ghostField",
                null);
            assertTrue("message should name the missing field, got: " + ex.getMessage(),
                ex.getMessage().contains("ghostField"));
        }
    }

    // =========================================================================
    // 5 — resolved-envelope shape contracts
    // =========================================================================

    @Test
    public void resolvedSourceCarriesReferrerFilesSoEditorsCanJump() {
        // Smallest-possible extends failure — verify files[] is exactly the
        // input source id and jsonPath is non-empty (anchored to the offending
        // node's declaration, not the root of the file).
        String canonical = "{ \"metadata.root\": {"
            + "\"package\": \"p\","
            + "\"children\": ["
            + "  { \"object.entity\": {"
            + "    \"name\": \"A\","
            + "    \"extends\": \"Ghost\","
            + "    \"children\": ["
            + "      { \"field.long\": { \"name\": \"id\" } },"
            + "      { \"identity.primary\": { \"@fields\": \"id\" } }"
            + "    ]"
            + "  } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        try {
            loader.load(List.of(new InMemoryStringSource(canonical, "input/A.json")));
            fail("expected MetaDataException for unresolved extends");
        } catch (MetaDataException ex) {
            ErrorSource env = ex.getEnvelope().orElseThrow();
            assertTrue("envelope must be a ResolvedSource", env instanceof ResolvedSource);
            ResolvedSource rs = (ResolvedSource) env;
            assertEquals(List.of("input/A.json"), rs.files());
            // jsonPath is populated by the parser so the IDE/editor can pinpoint
            // the `extends:` declaration on disk.
            assertNotNull("jsonPath must be populated from the referrer's source",
                rs.jsonPath());
            assertTrue("jsonPath should be anchored under $, got: " + rs.jsonPath(),
                rs.jsonPath().contains("$"));
        }
    }

    @Test
    public void resolvedFromHelperReadsFilesAndJsonPathFromJsonSource() {
        com.metaobjects.source.JsonSource js = new com.metaobjects.source.JsonSource(
            List.of("path/to/file.json"), "$.foo.bar");
        ResolvedSource rs = ResolvedSource.from(js, "pkg::Referrer", "MissingTarget");
        assertEquals(List.of("path/to/file.json"), rs.files());
        assertEquals("$.foo.bar", rs.jsonPath());
        assertEquals("pkg::Referrer", rs.referrer());
        assertEquals("MissingTarget", rs.target());
        assertEquals("resolved", rs.format());
    }

    @Test
    public void resolvedFromHelperHandlesCodeSourceFallback() {
        // CodeSource has no files/jsonPath; the resolved envelope falls back to
        // empty files[] and null jsonPath. Mirrors the TS helper's behaviour.
        com.metaobjects.source.CodeSource cs = new com.metaobjects.source.CodeSource("test");
        ResolvedSource rs = ResolvedSource.from(cs, "p::R", "Tgt");
        assertEquals(List.of(), rs.files());
        assertEquals(null, rs.jsonPath());
        assertEquals("p::R", rs.referrer());
        assertEquals("Tgt", rs.target());
    }
}
