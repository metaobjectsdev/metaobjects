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
 * Tests for {@link ValidationPhase#validateFieldMap}. A {@code field.map} is an
 * open-keyed {@code Map<String, V>} stored in a single jsonb column. The value
 * type is set by EXACTLY ONE of {@code @valueType} (a scalar value subtype) or
 * {@code @objectRef} (a value-object). Both rule violations surface
 * {@link ErrorCode#ERR_BAD_ATTR_VALUE}, mirroring the cross-port contract
 * (TS {@code validateFieldMap}, Python {@code _validate_field_map},
 * C# {@code ValidateFieldMap}).
 */
public class FieldMapValidationTest extends SharedRegistryTestBase {

    private MetaDataLoader newTestLoader() {
        return createTestLoader("FieldMapValidationTest", Collections.emptyList());
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

    /** A small entity wrapping a single field.map node with the given inline JSON. */
    private static String entityWithMap(String mapNode) {
        return "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.value\": { \"name\": \"Money\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"amount\" } }" +
            "  ] } }," +
            "  { \"object.entity\": { \"name\": \"Catalog\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            mapNode + "," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }" +
            "] } }";
    }

    // ---- Legal shapes load cleanly ---------------------------------------

    @Test
    public void valueTypeOnlyIsLegal() {
        String canonical = entityWithMap(
            "{ \"field.map\": { \"name\": \"labels\", \"@valueType\": \"string\" } }");
        loadThrough(canonical, "map-valuetype-only-ok.json"); // must not throw
    }

    @Test
    public void objectRefOnlyIsLegal() {
        String canonical = entityWithMap(
            "{ \"field.map\": { \"name\": \"prices\", \"@objectRef\": \"Money\" } }");
        loadThrough(canonical, "map-objectref-only-ok.json"); // must not throw
    }

    // ---- Exactly-one-of violations → ERR_BAD_ATTR_VALUE ------------------

    @Test
    public void neitherValueTypeNorObjectRefIsRejected() {
        String canonical = entityWithMap(
            "{ \"field.map\": { \"name\": \"opaque\" } }");
        assertBadAttrValue(canonical, "map-neither.json");
    }

    @Test
    public void bothValueTypeAndObjectRefIsRejected() {
        String canonical = entityWithMap(
            "{ \"field.map\": { \"name\": \"conflict\", \"@valueType\": \"string\", \"@objectRef\": \"Money\" } }");
        assertBadAttrValue(canonical, "map-both.json");
    }

    // ---- @valueType must name a scalar subtype → ERR_BAD_ATTR_VALUE ------

    @Test
    public void nonScalarValueTypeIsRejected() {
        // "object" is not a scalar value subtype — a value-object-valued map must
        // use @objectRef, not @valueType.
        String canonical = entityWithMap(
            "{ \"field.map\": { \"name\": \"bad\", \"@valueType\": \"object\" } }");
        assertBadAttrValue(canonical, "map-nonscalar-valuetype.json");
    }

    // ---- Message shape ---------------------------------------------------

    @Test
    public void errorMessageNamesFieldAndExactlyOneRule() {
        String canonical = entityWithMap(
            "{ \"field.map\": { \"name\": \"opaque\" } }");
        try {
            loadThrough(canonical, "map-msg-shape.json");
            fail("expected ERR_BAD_ATTR_VALUE");
        } catch (MetaDataException e) {
            String msg = e.getMessage();
            assertTrue("message should name the field: " + msg, msg.contains("opaque"));
            assertTrue("message should name @valueType: " + msg, msg.contains("@valueType"));
            assertTrue("message should name @objectRef: " + msg, msg.contains("@objectRef"));
        }
    }
}
