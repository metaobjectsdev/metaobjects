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

import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Tests for {@link ValidationPhase#validateEntityHasPrimaryIdentity}, the
 * non-fatal advisory pass that records a warning when a concrete
 * {@code object.entity} with at least one field has no primary identity.
 *
 * <p>Mirrors the TS {@code subtype-rules.ts} and C# {@code ValidationPasses}
 * warning shape. Warning text is matched exactly (cross-language contract;
 * the shared {@code subtype-entity-missing-primary-warning} fixture asserts
 * this same text byte-for-byte).</p>
 */
public class EntityHasPrimaryIdentityValidationTest extends SharedRegistryTestBase {

    private MetaDataLoader newTestLoader() {
        return createTestLoader("EntityHasPrimaryIdentityValidationTest",
            Collections.emptyList());
    }

    private MetaDataLoader loadThrough(String canonical, String id) {
        MetaDataLoader loader = newTestLoader();
        loader.load(List.of(new InMemoryStringSource(canonical, id)));
        return loader;
    }

    private static final String EXPECTED_WARNING_FOR_SUBSCRIBER =
        "entity object 'Subscriber' has no primary identity "
            + "(add an identity child or mark @isAbstract: true)";

    // -----------------------------------------------------------------------
    // Case 1 — concrete entity, fields, no identity → warning
    // -----------------------------------------------------------------------

    @Test
    public void concreteEntityWithoutPrimaryIdentityEmitsWarning() {
        String canonical = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Subscriber\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"field.string\": { \"name\": \"email\" } }" +
            "  ] } }" +
            "] } }";

        MetaDataLoader loader = loadThrough(canonical, "no-primary-identity.json");
        List<String> warnings = loader.getWarnings();
        assertEquals("expected exactly one warning", 1, warnings.size());
        assertEquals(EXPECTED_WARNING_FOR_SUBSCRIBER, warnings.get(0));
    }

    // -----------------------------------------------------------------------
    // Case 2 — concrete entity with a primary identity → no warning
    // -----------------------------------------------------------------------

    @Test
    public void concreteEntityWithPrimaryIdentityEmitsNoWarning() {
        String canonical = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Subscriber\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"field.string\": { \"name\": \"email\" } }," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }" +
            "] } }";

        MetaDataLoader loader = loadThrough(canonical, "has-primary-identity.json");
        assertTrue("expected no warnings, got " + loader.getWarnings(),
            loader.getWarnings().isEmpty());
    }

    // -----------------------------------------------------------------------
    // Case 3 — abstract entity (no identity, no warning)
    // -----------------------------------------------------------------------

    @Test
    public void abstractEntityWithoutPrimaryIdentityEmitsNoWarning() {
        String canonical = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"BaseRecord\", \"abstract\": true, \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"field.string\": { \"name\": \"name\" } }" +
            "  ] } }" +
            "] } }";

        MetaDataLoader loader = loadThrough(canonical, "abstract-no-identity.json");
        assertTrue("abstract entities should be exempt; got " + loader.getWarnings(),
            loader.getWarnings().isEmpty());
    }

    // -----------------------------------------------------------------------
    // Case 4 — entity with zero fields ALSO warns (aligns with TS/C#:
    //          any concrete entity-without-primary-identity warns, regardless
    //          of field count)
    // -----------------------------------------------------------------------

    @Test
    public void emptyEntityEmitsWarning() {
        String canonical = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Empty\" } }" +
            "] } }";

        MetaDataLoader loader = loadThrough(canonical, "empty-entity.json");
        assertEquals(1, loader.getWarnings().size());
        assertEquals(
            "entity object 'Empty' has no primary identity (add an identity child or mark @isAbstract: true)",
            loader.getWarnings().get(0));
    }

    // -----------------------------------------------------------------------
    // Case 5 — concrete entity extending abstract base with primary identity
    //          → no warning (inherited identity counts)
    // -----------------------------------------------------------------------

    @Test
    public void concreteEntityInheritingPrimaryIdentityEmitsNoWarning() {
        String canonical = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"BaseRecord\", \"abstract\": true, \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }," +
            "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
            "  ] } }," +
            "  { \"object.entity\": { \"name\": \"Subscriber\", \"extends\": \"BaseRecord\", \"children\": [" +
            "    { \"field.string\": { \"name\": \"email\" } }" +
            "  ] } }" +
            "] } }";

        MetaDataLoader loader = loadThrough(canonical, "inherits-identity.json");
        assertTrue("inheriting primary identity should not warn; got "
                + loader.getWarnings(),
            loader.getWarnings().isEmpty());
    }

    // -----------------------------------------------------------------------
    // Case 6 — clearWarnings on consecutive load() calls
    // -----------------------------------------------------------------------

    @Test
    public void warningsResetAcrossLoadCalls() {
        MetaDataLoader loader = newTestLoader();

        String firstBatch = "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Subscriber\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }" +
            "  ] } }" +
            "] } }";
        loader.load(List.of(new InMemoryStringSource(firstBatch, "batch-1.json")));
        assertEquals(1, loader.getWarnings().size());

        // Second load — should reset accumulator before running validation.
        // (Reload a clean fixture; warning count for this batch should be 0.)
        // NB: we cannot un-add the previously-loaded Subscriber from the tree,
        // so the second load re-visits it and would re-warn — that is the
        // expected behaviour. The contract is "warnings reflect this batch's
        // validation", and the validation pass IS re-run over the full tree.
        //
        // FR5c: reuse the SAME source id so the merge-attribution code does
        // not see a NEW contributor on the second load and emit a
        // WARN_DUPLICATE_DECLARATION (which would be correct per FR5c
        // semantics but is orthogonal to this test's intent — verifying that
        // {@code load()} resets the per-batch warning accumulator).
        loader.load(List.of(new InMemoryStringSource(firstBatch, "batch-1.json")));
        // Still exactly one warning (one Subscriber, one missing-identity).
        assertEquals(1, loader.getWarnings().size());
    }
}
