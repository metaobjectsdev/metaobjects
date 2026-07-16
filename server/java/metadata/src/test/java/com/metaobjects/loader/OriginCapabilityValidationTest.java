/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.metaobjects.loader;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * #195 — per-capability origin VALIDATION parity for the Java port.
 *
 * <p>Mirrors the TS reference
 * {@code server/typescript/packages/metadata/test/loader-origin-validation.test.ts}
 * (commit 63943d0c). Java's origin validation is EAGER-THROW (the first failing
 * rule throws a {@link MetaDataException}) where TS accumulates; each error case
 * here therefore asserts the exception the equivalent TS {@code .some(...)}
 * matcher looked for. The rule ORDER in
 * {@link ValidationPhase#validateOriginNode} matches the TS pass so the "first"
 * error thrown is the one under test.</p>
 *
 * <p>Covers the four #195 capabilities: {@code origin.aggregate @agg:any|all}
 * (predicate quantifiers), {@code @agg:collect} (array rollup), {@code origin.computed}
 * (expression tree), and {@code origin.first} (argmax-then-project).</p>
 */
public class OriginCapabilityValidationTest extends SharedRegistryTestBase {

    private MetaDataLoader newTestLoader() {
        return createTestLoader("OriginCapabilityValidationTest", Collections.emptyList());
    }

    // =========================================================================
    // Model builders — a Session/Turn graph + a projection carrying one
    // configurable origin field, and a LlmCall graph for origin.computed.
    // =========================================================================

    /** A Session/Turn graph + SessionSummary projection carrying {@code originFieldJson}. */
    private static String sessionModel(String originFieldJson) {
        return "{ \"metadata.root\": {"
            + "\"package\": \"acme::sessions\","
            + "\"children\": ["
            + "  { \"object.entity\": {"
            + "    \"name\": \"Session\","
            + "    \"children\": ["
            + "      { \"source.rdb\": { \"@table\": \"sessions\" } },"
            + "      { \"field.long\": { \"name\": \"id\" } },"
            + "      { \"relationship.association\": { \"name\": \"turns\", \"@objectRef\": \"Turn\", \"@cardinality\": \"many\" } },"
            + "      { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } }"
            + "    ]"
            + "  } },"
            + "  { \"object.entity\": {"
            + "    \"name\": \"Turn\","
            + "    \"children\": ["
            + "      { \"source.rdb\": { \"@table\": \"turns\" } },"
            + "      { \"field.long\": { \"name\": \"id\" } },"
            + "      { \"field.boolean\": { \"name\": \"success\" } },"
            + "      { \"field.string\": { \"name\": \"label\" } },"
            + "      { \"field.timestamp\": { \"name\": \"createdAt\" } },"
            + "      { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } }"
            + "    ]"
            + "  } },"
            + "  { \"object.projection\": {"
            + "    \"name\": \"SessionSummary\","
            + "    \"children\": ["
            + "      { \"source.rdb\": { \"@kind\": \"view\", \"@view\": \"v_session\" } },"
            + "      { \"field.long\": { \"name\": \"id\", \"extends\": \"Session.id\" } },"
            + "      " + originFieldJson + ","
            + "      { \"identity.primary\": { \"name\": \"id\", \"extends\": \"Session.id\" } }"
            + "    ]"
            + "  } }"
            + "] } }";
    }

    /** A LlmCall graph + LlmCallSummary projection carrying {@code fieldJson}. */
    private static String computedModel(String fieldJson) {
        return "{ \"metadata.root\": {"
            + "\"package\": \"acme::observability\","
            + "\"children\": ["
            + "  { \"object.entity\": {"
            + "    \"name\": \"LlmCall\","
            + "    \"children\": ["
            + "      { \"source.rdb\": { \"@table\": \"llm_calls\" } },"
            + "      { \"field.long\": { \"name\": \"id\" } },"
            + "      { \"field.string\": { \"name\": \"payloadJson\" } },"
            + "      { \"field.long\": { \"name\": \"durationMs\" } },"
            + "      { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } }"
            + "    ]"
            + "  } },"
            + "  { \"object.projection\": {"
            + "    \"name\": \"LlmCallSummary\","
            + "    \"children\": ["
            + "      { \"source.rdb\": { \"@kind\": \"view\", \"@view\": \"v_llm\" } },"
            + "      { \"field.long\": { \"name\": \"id\", \"extends\": \"LlmCall.id\" } },"
            + "      " + fieldJson + ","
            + "      { \"identity.primary\": { \"name\": \"id\", \"extends\": \"LlmCall.id\" } }"
            + "    ]"
            + "  } }"
            + "] } }";
    }

    // =========================================================================
    // Assertion helpers.
    // =========================================================================

    /** Load {@code json}; assert it loads with NO error thrown. */
    private void assertLoads(String json) {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(json, "meta.test.json")));
    }

    /**
     * Load {@code json}; assert a {@link MetaDataException} with {@code code} is
     * thrown whose message contains AT LEAST ONE of {@code tokensAnyOf} (case-
     * insensitive — mirrors the TS regex alternations like {@code /isArray|array/}).
     */
    private void assertOriginError(String json, ErrorCode code, String... tokensAnyOf) {
        MetaDataLoader loader = newTestLoader();
        try {
            loader.load(List.of(new InMemoryStringSource(json, "meta.test.json")));
            fail("expected MetaDataException code=" + code);
        } catch (MetaDataException ex) {
            assertTrue("expected code " + code + " got " + ex.getCode()
                    + " msg=" + ex.getMessage(),
                ex.getCode().map(c -> c == code).orElse(false));
            String msg = ex.getMessage() == null ? "" : ex.getMessage().toLowerCase();
            boolean matched = false;
            for (String t : tokensAnyOf) {
                if (msg.contains(t.toLowerCase())) { matched = true; break; }
            }
            assertTrue("message did not contain any of " + java.util.Arrays.toString(tokensAnyOf)
                    + "; msg=" + ex.getMessage(), matched);
        }
    }

    // =========================================================================
    // origin.aggregate @agg any|all
    // =========================================================================

    @Test
    public void any_booleanFieldFilterVia_noOf_loads() {
        assertLoads(sessionModel(
            "{ \"field.boolean\": { \"name\": \"hasError\", \"children\": ["
            + "{ \"origin.aggregate\": { \"@agg\": \"any\", \"@via\": \"Session.turns\", \"@filter\": { \"success\": false } } } ] } }"));
    }

    @Test
    public void all_vacuousTruthQuantifier_loads() {
        assertLoads(sessionModel(
            "{ \"field.boolean\": { \"name\": \"allOk\", \"children\": ["
            + "{ \"origin.aggregate\": { \"@agg\": \"all\", \"@via\": \"Session.turns\", \"@filter\": { \"success\": true } } } ] } }"));
    }

    @Test
    public void any_withoutFilter_invalidOrigin() {
        assertOriginError(sessionModel(
            "{ \"field.boolean\": { \"name\": \"hasError\", \"children\": ["
            + "{ \"origin.aggregate\": { \"@agg\": \"any\", \"@via\": \"Session.turns\" } } ] } }"),
            ErrorCode.ERR_INVALID_ORIGIN, "@filter");
    }

    @Test
    public void any_withOf_forbidden_invalidOrigin() {
        assertOriginError(sessionModel(
            "{ \"field.boolean\": { \"name\": \"hasError\", \"children\": ["
            + "{ \"origin.aggregate\": { \"@agg\": \"any\", \"@via\": \"Session.turns\", \"@filter\": { \"success\": false }, \"@of\": \"Turn.success\" } } ] } }"),
            ErrorCode.ERR_INVALID_ORIGIN, "@of");
    }

    @Test
    public void any_onNonBooleanField_invalidOrigin() {
        assertOriginError(sessionModel(
            "{ \"field.string\": { \"name\": \"hasError\", \"children\": ["
            + "{ \"origin.aggregate\": { \"@agg\": \"any\", \"@via\": \"Session.turns\", \"@filter\": { \"success\": false } } } ] } }"),
            ErrorCode.ERR_INVALID_ORIGIN, "boolean");
    }

    @Test
    public void any_onIsArrayField_inverseRule_invalidOrigin() {
        assertOriginError(sessionModel(
            "{ \"field.boolean\": { \"name\": \"hasError\", \"isArray\": true, \"children\": ["
            + "{ \"origin.aggregate\": { \"@agg\": \"any\", \"@via\": \"Session.turns\", \"@filter\": { \"success\": false } } } ] } }"),
            ErrorCode.ERR_INVALID_ORIGIN, "isArray", "array");
    }

    // =========================================================================
    // origin.aggregate @agg collect
    // =========================================================================

    @Test
    public void collect_isArrayFieldOfVia_loads() {
        assertLoads(sessionModel(
            "{ \"field.string\": { \"name\": \"labels\", \"isArray\": true, \"children\": ["
            + "{ \"origin.aggregate\": { \"@agg\": \"collect\", \"@of\": \"Turn.label\", \"@via\": \"Session.turns\", \"@distinct\": true } } ] } }"));
    }

    @Test
    public void collect_onNonArrayField_invalidOrigin() {
        assertOriginError(sessionModel(
            "{ \"field.string\": { \"name\": \"labels\", \"children\": ["
            + "{ \"origin.aggregate\": { \"@agg\": \"collect\", \"@of\": \"Turn.label\", \"@via\": \"Session.turns\" } } ] } }"),
            ErrorCode.ERR_INVALID_ORIGIN, "isArray", "array");
    }

    @Test
    public void collect_elementTypeMustMatchOfSubtype_invalidOrigin() {
        assertOriginError(sessionModel(
            "{ \"field.long\": { \"name\": \"labels\", \"isArray\": true, \"children\": ["
            + "{ \"origin.aggregate\": { \"@agg\": \"collect\", \"@of\": \"Turn.label\", \"@via\": \"Session.turns\" } } ] } }"),
            ErrorCode.ERR_INVALID_ORIGIN, "type", "subType", "match");
    }

    @Test
    public void distinct_onNonCollectAggregate_invalidOrigin() {
        assertOriginError(sessionModel(
            "{ \"field.long\": { \"name\": \"turnCount\", \"children\": ["
            + "{ \"origin.aggregate\": { \"@agg\": \"count\", \"@of\": \"Turn.id\", \"@via\": \"Session.turns\", \"@distinct\": true } } ] } }"),
            ErrorCode.ERR_INVALID_ORIGIN, "distinct");
    }

    @Test
    public void orderBy_withDistinct_onCollect_invalidOrigin() {
        assertOriginError(sessionModel(
            "{ \"field.string\": { \"name\": \"labels\", \"isArray\": true, \"children\": ["
            + "{ \"origin.aggregate\": { \"@agg\": \"collect\", \"@of\": \"Turn.label\", \"@via\": \"Session.turns\", \"@distinct\": true, \"@orderBy\": [\"label:asc\"] } } ] } }"),
            ErrorCode.ERR_INVALID_ORIGIN, "orderBy");
    }

    @Test
    public void nonCollect_onIsArrayField_inverseRule_invalidOrigin() {
        assertOriginError(sessionModel(
            "{ \"field.long\": { \"name\": \"turnCount\", \"isArray\": true, \"children\": ["
            + "{ \"origin.aggregate\": { \"@agg\": \"count\", \"@of\": \"Turn.id\", \"@via\": \"Session.turns\" } } ] } }"),
            ErrorCode.ERR_INVALID_ORIGIN, "isArray", "array");
    }

    // =========================================================================
    // origin.computed
    // =========================================================================

    @Test
    public void computed_isNotNullOverBaseField_booleanField_loads() {
        assertLoads(computedModel(
            "{ \"field.boolean\": { \"name\": \"hasPayload\", \"children\": ["
            + "{ \"origin.computed\": { \"@expr\": { \"op\": \"isNotNull\", \"arg\": { \"field\": \"payloadJson\" } } } } ] } }"));
    }

    @Test
    public void computed_inferredBooleanVsDeclaredString_typeMismatch() {
        assertOriginError(computedModel(
            "{ \"field.string\": { \"name\": \"hasPayload\", \"children\": ["
            + "{ \"origin.computed\": { \"@expr\": { \"op\": \"isNotNull\", \"arg\": { \"field\": \"payloadJson\" } } } } ] } }"),
            ErrorCode.ERR_COMPUTED_TYPE_MISMATCH, "field.");
    }

    @Test
    public void computed_fieldRefToNonExistentBaseField_invalidOrigin() {
        assertOriginError(computedModel(
            "{ \"field.boolean\": { \"name\": \"hasPayload\", \"children\": ["
            + "{ \"origin.computed\": { \"@expr\": { \"op\": \"isNotNull\", \"arg\": { \"field\": \"nope\" } } } } ] } }"),
            ErrorCode.ERR_INVALID_ORIGIN, "nope");
    }

    @Test
    public void computed_unknownExpressionOp_unknownExprNode() {
        assertOriginError(computedModel(
            "{ \"field.boolean\": { \"name\": \"hasPayload\", \"children\": ["
            + "{ \"origin.computed\": { \"@expr\": { \"op\": \"regexp\", \"arg\": { \"field\": \"payloadJson\" } } } } ] } }"),
            ErrorCode.ERR_UNKNOWN_EXPR_NODE, "regexp", "unknown");
    }

    // =========================================================================
    // origin.first
    // =========================================================================

    @Test
    public void first_ofViaOrderByFilter_nonRequiredField_loads() {
        assertLoads(sessionModel(
            "{ \"field.string\": { \"name\": \"latestLabel\", \"children\": ["
            + "{ \"origin.first\": { \"@of\": \"Turn.label\", \"@via\": \"Session.turns\", \"@orderBy\": [\"createdAt:desc\"], \"@filter\": { \"success\": true } } } ] } }"));
    }

    @Test
    public void first_onRequiredField_invalidOrigin() {
        assertOriginError(sessionModel(
            "{ \"field.string\": { \"name\": \"latestLabel\", \"@required\": true, \"children\": ["
            + "{ \"origin.first\": { \"@of\": \"Turn.label\", \"@via\": \"Session.turns\", \"@orderBy\": [\"createdAt:desc\"] } } ] } }"),
            ErrorCode.ERR_INVALID_ORIGIN, "required");
    }

    @Test
    public void first_ofTypePreservation_longVsString_invalidOrigin() {
        assertOriginError(sessionModel(
            "{ \"field.long\": { \"name\": \"latestLabel\", \"children\": ["
            + "{ \"origin.first\": { \"@of\": \"Turn.label\", \"@via\": \"Session.turns\", \"@orderBy\": [\"createdAt:desc\"] } } ] } }"),
            ErrorCode.ERR_INVALID_ORIGIN, "type", "subType", "match");
    }

    @Test
    public void first_orderByKeyThatDoesNotResolve_invalidOrigin() {
        assertOriginError(sessionModel(
            "{ \"field.string\": { \"name\": \"latestLabel\", \"children\": ["
            + "{ \"origin.first\": { \"@of\": \"Turn.label\", \"@via\": \"Session.turns\", \"@orderBy\": [\"nope:desc\"] } } ] } }"),
            ErrorCode.ERR_INVALID_ORIGIN, "nope", "orderBy");
    }
}
