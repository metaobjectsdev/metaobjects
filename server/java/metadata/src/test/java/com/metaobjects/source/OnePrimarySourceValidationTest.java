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
package com.metaobjects.source;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.*;

/**
 * Tests for the one-primary multi-source validation pass in
 * {@link com.metaobjects.loader.ValidationPhase}.
 *
 * <p>An object that declares one or more {@code source.*} children MUST have
 * exactly one whose effective role is {@code "primary"}. Objects with zero sources
 * are exempt (they are not persisted).</p>
 *
 * <p>Mirrors the pattern from {@link MetaSourceTest}.</p>
 */
public class OnePrimarySourceValidationTest extends SharedRegistryTestBase {

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private MetaDataLoader newTestLoader() {
        return createTestLoader("OnePrimarySourceValidationTest", Collections.emptyList());
    }

    /**
     * Load the given canonical JSON string through the full loader pipeline.
     * Propagates any {@link MetaDataException} thrown during parse or validation.
     */
    private MetaDataLoader loadThrough(String canonical, String id) {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(canonical, id)));
        return loader;
    }

    // Minimal wrapper: an object.entity with the given children JSON (excluding the
    // field.long id + identity.primary, which are appended automatically so every
    // loaded entity is structurally valid).
    private String entityWith(String childrenJson) {
        return "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
               "  { \"object.entity\": { \"name\": \"Product\", \"children\": [" +
               "    { \"field.long\": { \"name\": \"id\" } }," +
               childrenJson + "," +
               "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
               "  ] } }" +
               "] } }";
    }

    // -----------------------------------------------------------------------
    // Case 1 — single source (default role → primary) → OK
    // -----------------------------------------------------------------------

    @Test
    public void singleSourceDefaultRoleIsValid() {
        // No explicit @role; default is "primary" → one primary, no violation.
        String canonical = entityWith(
            "{ \"source.rdb\": { \"@table\": \"products\" } }");
        // Must not throw
        MetaDataLoader loader = loadThrough(canonical, "one-primary-single-default.json");
        assertNotNull("Loader must return a non-null root", loader.getRoot());
    }

    // -----------------------------------------------------------------------
    // Case 2 — primary + replica (two sources, one primary) → OK
    // -----------------------------------------------------------------------

    @Test
    public void primaryPlusReplicaIsValid() {
        // First source defaults to primary; second is explicitly replica.
        String canonical = entityWith(
            "{ \"source.rdb\": { \"name\": \"mainSrc\", \"@table\": \"products\" } }," +
            "{ \"source.rdb\": { \"name\": \"replicaSrc\", \"@table\": \"products_replica\"," +
            "    \"@role\": \"replica\" } }");
        MetaDataLoader loader = loadThrough(canonical, "one-primary-plus-replica.json");
        assertNotNull("Loader must return a non-null root", loader.getRoot());
    }

    // -----------------------------------------------------------------------
    // Case 3 — zero sources on an entity → OK (not persisted)
    // -----------------------------------------------------------------------

    @Test
    public void zeroSourcesIsValid() {
        String canonical = entityWith(
            "{ \"field.string\": { \"name\": \"label\" } }");
        MetaDataLoader loader = loadThrough(canonical, "one-primary-zero-sources.json");
        assertNotNull("Loader must return a non-null root", loader.getRoot());
    }

    // -----------------------------------------------------------------------
    // Case 4 — single source with @role: replica → ERR_SOURCE_NO_PRIMARY
    // -----------------------------------------------------------------------

    @Test
    public void singleReplicaSourceRaisesNoPrimary() {
        String canonical = entityWith(
            "{ \"source.rdb\": { \"@table\": \"products\", \"@role\": \"replica\" } }");
        try {
            loadThrough(canonical, "one-primary-only-replica.json");
            fail("Expected MetaDataException for no primary source");
        } catch (MetaDataException e) {
            boolean hasCode = e.getCode()
                .map(c -> c == ErrorCode.ERR_SOURCE_NO_PRIMARY)
                .orElse(false);
            boolean hasMsg = e.getMessage() != null &&
                e.getMessage().contains("ERR_SOURCE_NO_PRIMARY");
            assertTrue(
                "Exception must signal ERR_SOURCE_NO_PRIMARY (via code or message): "
                    + e.getMessage(),
                hasCode || hasMsg);
        }
    }

    // -----------------------------------------------------------------------
    // Case 5 — two sources both default-primary → ERR_SOURCE_MULTIPLE_PRIMARY
    // -----------------------------------------------------------------------

    @Test
    public void twoDefaultPrimarySourcesRaisesMultiplePrimary() {
        // Both sources omit @role, so both default to "primary".
        String canonical = entityWith(
            "{ \"source.rdb\": { \"name\": \"src1\", \"@table\": \"products\" } }," +
            "{ \"source.rdb\": { \"name\": \"src2\", \"@table\": \"products_v2\" } }");
        try {
            loadThrough(canonical, "one-primary-two-primaries.json");
            fail("Expected MetaDataException for multiple primary sources");
        } catch (MetaDataException e) {
            boolean hasCode = e.getCode()
                .map(c -> c == ErrorCode.ERR_SOURCE_MULTIPLE_PRIMARY)
                .orElse(false);
            boolean hasMsg = e.getMessage() != null &&
                e.getMessage().contains("ERR_SOURCE_MULTIPLE_PRIMARY");
            assertTrue(
                "Exception must signal ERR_SOURCE_MULTIPLE_PRIMARY (via code or message): "
                    + e.getMessage(),
                hasCode || hasMsg);
        }
    }
}
