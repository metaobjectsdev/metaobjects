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

import com.metaobjects.MetaDataException;
import com.metaobjects.MetaRoot;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;

/**
 * Issue #368 fix round 1, finding 2 — a dedupe test that can actually fail.
 *
 * <p>{@link ValidationPhase#run(MetaRoot, MetaDataLoader)} already collapses findings
 * by {@code code + envelope.toString()} ({@code ValidationPhase.dedupe}), and
 * {@code JsonSource} is a record with value-based {@code toString()} — so four visits
 * of the SAME physical relationship (one entity declaring it, three inheriting it
 * unmodified) produce byte-identical exceptions (same code, same source instance,
 * same message) regardless of whether {@code validateRelationshipsM2M}'s own
 * {@code checkedRels} (an {@code IdentityHashMap}-backed dedupe set) does anything at
 * all. A test that only calls {@code loader.load(...)} and checks the FINAL
 * error count (as {@code Issue368RelationshipReferenceValidationTest}'s dedupe tests
 * do) would pass identically with {@code checkedRels} deleted.</p>
 *
 * <p>This test lives in {@code com.metaobjects.loader} (not
 * {@code com.metaobjects.relationship}, where the rest of the #368 test suite lives)
 * specifically to reach the package-private {@link ValidationPhase#validateRelationshipsM2M}
 * directly and assert on the size of the RAW list it returns — bypassing {@code run()}'s
 * own dedupe entirely. Deleting {@code checkedRels} (making every relationship node
 * always pass the identity check) would make this assert 4, not 1, so it is a genuine
 * regression guard for that mechanism specifically.</p>
 */
public class Issue368RuleDDedupeUnitTest extends SharedRegistryTestBase {

    private MetaDataLoader newTestLoader() {
        return createTestLoader("Issue368RuleDDedupeUnitTest", Collections.emptyList());
    }

    @Test
    public void ruleDDedupeIsGenuineNotJustRunLevelEnvelopeCollapse() {
        // A declares one broken M:N-only-attr-on-non-M:N relationship ("program",
        // @through set but @cardinality: "one"). B, C and D each extend A WITHOUT
        // overriding "program" -- so all four entities' effective relationship set
        // (obj.getRelationships()) contains the literal SAME MetaRelationship object.
        String doc =
            "{ \"metadata.root\": { \"package\": \"repro\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Program\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"A\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"relationship.composition\": { \"name\": \"program\", \"@objectRef\": \"Program\", \"@cardinality\": \"one\", \"@through\": \"X\" } },"
            + "    { \"identity.primary\": { \"name\": \"id\", \"@fields\": \"id\" } } ] } },"
            + "  { \"object.entity\": { \"name\": \"B\", \"extends\": \"A\" } },"
            + "  { \"object.entity\": { \"name\": \"C\", \"extends\": \"A\" } },"
            + "  { \"object.entity\": { \"name\": \"D\", \"extends\": \"A\" } }"
            + "] } }";

        MetaDataLoader loader = newTestLoader();
        MetaRoot root;
        try {
            loader.load(List.of(new InMemoryStringSource(doc, "dedupe-unit.json")));
            root = loader.getRoot();
        } catch (MetaDataException e) {
            // Expected -- the model is deliberately invalid. The tree is already
            // fully built (parse + extends resolution happen before validation), so
            // getRoot() is still usable for a direct, fresh call below.
            root = loader.getRoot();
        }

        // Call the pass directly -- a SECOND, INDEPENDENT invocation, not reading
        // anything cached by the load() above -- and inspect its raw return value.
        // run()'s dedupe(collected) is never involved here.
        List<MetaDataException> raw = ValidationPhase.validateRelationshipsM2M(root);
        assertEquals(
            "checkedRels must dedupe A's single relationship across A + 3 inheriting "
                + "children (B, C, D) to exactly one raw finding from "
                + "validateRelationshipsM2M itself -- got: " + raw,
            1, raw.size());
    }
}
