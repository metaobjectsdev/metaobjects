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

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Tests for {@link ValidationPhase#validateDbColumnType} (R6 Plan 2b). The
 * {@code @dbColumnType} physical attribute is validated own-only against:
 * <ol>
 *   <li>a closed value set ({@code uuid|jsonb} — {@code timestamp_with_tz} was retired
 *       in ADR-0036 Wave 2); and</li>
 *   <li>the legal (logical-subtype × value) pairing.</li>
 * </ol>
 * Both violations surface {@link ErrorCode#ERR_BAD_ATTR_VALUE}, mirroring the
 * {@code field.enum} {@code @values} precedent and the cross-port contract.
 */
public class DbColumnTypeValidationTest extends SharedRegistryTestBase {

    private MetaDataLoader newTestLoader() {
        return createTestLoader("DbColumnTypeValidationTest", Collections.emptyList());
    }

    private void loadThrough(String canonical, String id) {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(canonical, id)));
    }

    private void assertBadAttrValue(String canonical, String id) {
        try {
            loadThrough(canonical, id);
            fail("expected ERR_BAD_ATTR_VALUE for " + id);
        } catch (MetaDataException e) {
            assertEquals("expected ERR_BAD_ATTR_VALUE",
                ErrorCode.ERR_BAD_ATTR_VALUE, e.getCode().orElse(null));
        }
    }

    // ---- Legal pairings load cleanly -------------------------------------

    @Test
    public void uuidOnStringIsLegal() {
        String canonical = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Asset\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"field.string\": { \"name\": \"externalId\", \"@dbColumnType\": \"uuid\" } }," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }" +
            "] } }";
        loadThrough(canonical, "uuid-on-string-ok.json"); // must not throw
    }

    @Test
    public void jsonbOnStringIsLegal() {
        String canonical = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Asset\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"field.string\": { \"name\": \"payload\", \"@dbColumnType\": \"jsonb\" } }," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }" +
            "] } }";
        loadThrough(canonical, "jsonb-on-string-ok.json"); // must not throw
    }

    @Test
    public void retiredTimestampTzValueIsRejected() {
        // ADR-0036 Wave 2: timestamp_with_tz is a RETIRED @dbColumnType value (the legal set
        // shrank to {uuid, jsonb}). It no longer loads on field.timestamp — it trips Rule 1
        // (unrecognized value) → ERR_BAD_ATTR_VALUE. Timezone-awareness now lives in
        // field.timestamp (instant by default) + @localTime (the naive opt-out).
        String canonical = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Asset\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"field.timestamp\": { \"name\": \"recordedAt\", \"@dbColumnType\": \"timestamp_with_tz\" } }," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }" +
            "] } }";
        assertBadAttrValue(canonical, "retired-timestamptz-rejected.json");
    }

    @Test
    public void localTimeBooleanOnTimestampIsLegal() {
        // ADR-0036 Wave 2: @localTime (boolean) is the naive wall-clock opt-out on
        // field.timestamp — registered, so it loads cleanly (strict-provenance friendly).
        String canonical = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Asset\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"field.timestamp\": { \"name\": \"observedAt\", \"@localTime\": true } }," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }" +
            "] } }";
        loadThrough(canonical, "localtime-on-timestamp-ok.json"); // must not throw
    }

    // ---- Illegal pairings + unknown value → ERR_BAD_ATTR_VALUE -----------

    @Test
    public void timestampTzOnStringIsRejected() {
        // The shared error-dbcolumntype-illegal-pairing fixture exercises this exact shape.
        // Post ADR-0036 Wave 2 the trigger shifted from an illegal pairing (Rule 2) to an
        // unrecognized value (Rule 1 — timestamp_with_tz is retired), but it is still
        // ERR_BAD_ATTR_VALUE either way (the shared fixture asserts only the code).
        String canonical = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Asset\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"field.string\": { \"name\": \"recordedAt\", \"@dbColumnType\": \"timestamp_with_tz\" } }," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }" +
            "] } }";
        assertBadAttrValue(canonical, "timestamptz-on-string-illegal.json");
    }

    @Test
    public void uuidOnTimestampIsIllegalPairing() {
        String canonical = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Asset\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"field.timestamp\": { \"name\": \"when\", \"@dbColumnType\": \"uuid\" } }," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }" +
            "] } }";
        assertBadAttrValue(canonical, "uuid-on-timestamp-illegal.json");
    }

    @Test
    public void uuidArrayValueIsRejected() {
        // dbColumnType:uuid_array was REMOVED (Phase 1, dbColumnType slim-and-derive):
        // a native uuid[] column is now DERIVED from field.uuid + isArray:true, not declared.
        String canonical = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Asset\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"field.string\": { \"name\": \"tags\", \"@dbColumnType\": \"uuid_array\" } }," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }" +
            "] } }";
        assertBadAttrValue(canonical, "uuid-array-removed.json");
    }

    @Test
    public void textArrayValueIsRejected() {
        // dbColumnType:text_array was REMOVED (Phase 1): a native text[] column is now
        // DERIVED from field.string + isArray:true, not declared.
        String canonical = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Asset\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"field.string\": { \"name\": \"tags\", \"@dbColumnType\": \"text_array\" } }," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }" +
            "] } }";
        assertBadAttrValue(canonical, "text-array-removed.json");
    }

    @Test
    public void textValueIsRejected() {
        // The vestigial dbColumnType:text value is REMOVED (Phase 1): a no-maxLength
        // field.string already defaults to a text column — `text` is not an opt-in.
        String canonical = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Asset\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"field.string\": { \"name\": \"body\", \"@dbColumnType\": \"text\" } }," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }" +
            "] } }";
        assertBadAttrValue(canonical, "text-value-removed.json");
    }

    @Test
    public void unrecognizedValueIsRejected() {
        String canonical = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Asset\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"field.string\": { \"name\": \"col\", \"@dbColumnType\": \"tsvector\" } }," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }" +
            "] } }";
        assertBadAttrValue(canonical, "unknown-dbcolumntype.json");
    }

    // ---- Own-only: an illegal value INHERITED via extends is not re-flagged
    //      on the concrete node (it is flagged on the declaring node). Here the
    //      concrete child declares NO @dbColumnType of its own, so the pass is a
    //      no-op for it. ----------------------------------------------------

    @Test
    public void ownOnlyDoesNotReflagInheritedAttr() {
        // Abstract base declares a LEGAL @dbColumnType; concrete child inherits it
        // and declares none of its own. The child must load cleanly (own-only).
        String canonical = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"field.string\": { \"name\": \"baseExtId\", \"abstract\": true, \"@dbColumnType\": \"uuid\" } }," +
            "  { \"object.entity\": { \"name\": \"Asset\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"field.string\": { \"name\": \"externalId\", \"extends\": \"baseExtId\" } }," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }" +
            "] } }";
        loadThrough(canonical, "own-only-inherited.json"); // must not throw
    }

    @Test
    public void noDbColumnTypeIsAlwaysFine() {
        String canonical = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Asset\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"field.string\": { \"name\": \"label\" } }," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }" +
            "] } }";
        loadThrough(canonical, "no-dbcolumntype.json"); // must not throw
    }

    @Test
    public void errorMessageNamesFieldValueAndLegalSet() {
        // A genuine illegal pairing (Rule 2): uuid is legal only on field.string, so on
        // field.timestamp the message names the field, the value, and the required subtype.
        String canonical = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Asset\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"field.timestamp\": { \"name\": \"recordedAt\", \"@dbColumnType\": \"uuid\" } }," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }" +
            "] } }";
        try {
            loadThrough(canonical, "msg-shape.json");
            fail("expected ERR_BAD_ATTR_VALUE");
        } catch (MetaDataException e) {
            String msg = e.getMessage();
            assertTrue("message should name the field: " + msg, msg.contains("recordedAt"));
            assertTrue("message should name the value: " + msg, msg.contains("uuid"));
            assertTrue("message should name the required subtype: " + msg,
                msg.contains("field.string"));
        }
    }
}
