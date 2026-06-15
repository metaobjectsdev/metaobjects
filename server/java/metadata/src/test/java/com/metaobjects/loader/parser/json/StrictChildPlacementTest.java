package com.metaobjects.loader.parser.json;

import com.metaobjects.MetaDataException;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.*;

/**
 * FR-033 (sub-step B2a) — structural-child placement enforcement at strict load.
 *
 * <p>The strict per-subtype constraint model (read from {@code spec/metamodel/*.json})
 * replaced Java's broad child rules with the same strict child graph TS enforces. A
 * STRUCTURAL child (field/identity/source/validator/relationship/… — NOT an attr) placed
 * under a parent whose registered child rules do NOT admit it must be rejected at load —
 * the structural analogue of {@code ERR_UNKNOWN_ATTR} for misplaced attrs.</p>
 *
 * <p>This is the Java mirror of the TS gating test
 * {@code server/typescript/packages/metadata/test/child-placement-enforcement.test.ts}.
 * Java enforces placement eagerly at {@code MetaData.addChild} via
 * {@code MetaDataRegistry.acceptsChild} (which consults the strict child graph), throwing
 * an {@link com.metaobjects.InvalidMetaDataException} (a {@link MetaDataException}) during
 * the parse. The thrown error carries {@link com.metaobjects.ErrorCode#ERR_CHILD_NOT_ALLOWED}
 * and a detail naming the parent, the rejected child ({@code type.subType 'name'}), and
 * the supported children — matching the cross-port {@code ERR_CHILD_NOT_ALLOWED} contract
 * in {@code fixtures/conformance/ERROR-CODES.json}.</p>
 *
 * <p>Two genuinely-misplaced cases are pinned:</p>
 * <ol>
 *   <li>A {@code relationship.*} child under an {@code object.projection} — the strict
 *       projection child set is field/identity/validator/layout/source, with NO
 *       relationship (a projection expresses derivation via {@code @via}, never a
 *       relationship child; see ADR-0028 / {@code spec/metamodel/object.json}).</li>
 *   <li>A structural child (a {@code field}) under an attr-only type
 *       ({@code validator.required}, whose strict child set is empty).</li>
 * </ol>
 */
public class StrictChildPlacementTest extends SharedRegistryTestBase {

    private MetaDataLoader newTestLoader() {
        return createTestLoader("StrictChildPlacement", Collections.emptyList());
    }

    /** Attempt a strict load of canonical JSON; returns the thrown exception (or null). */
    private MetaDataException loadExpectingThrow(String canonical, String id) {
        MetaDataLoader loader = newTestLoader();
        try {
            loader.load(List.of(new InMemoryStringSource(canonical, id)));
            return null;
        } catch (MetaDataException e) {
            return e;
        }
    }

    // -----------------------------------------------------------------------
    // 1 — A relationship child under object.projection is NOT admitted by the
    //     strict projection child graph → rejected at load.
    // -----------------------------------------------------------------------

    @Test
    public void relationshipUnderProjectionIsRejected() {
        // A projection's strict children omit relationship.* entirely.
        String canonical =
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Order\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"identity.primary\": { \"name\": \"pk\", \"@fields\": \"id\" } }"
            + "  ] } },"
            + "  { \"object.projection\": { \"name\": \"OrderView\", \"extends\": \"Order\","
            + "    \"children\": ["
            + "      { \"relationship.association\": { \"name\": \"bogus\","
            + "        \"@cardinality\": \"one\", \"@objectRef\": \"Order\" } }"
            + "    ] } }"
            + "] } }";

        MetaDataException e = loadExpectingThrow(canonical, "rel-under-projection.json");
        assertNotNull("a relationship child under object.projection must be REJECTED at "
                + "strict load (projection's strict child set has no relationship)", e);
        String msg = e.getMessage();
        assertTrue("error must name the misplaced relationship child; got: " + msg,
            msg != null && msg.contains("relationship"));
        assertTrue("error must name the projection parent; got: " + msg,
            msg != null && msg.contains("projection"));
    }

    // -----------------------------------------------------------------------
    // 2 — A structural (field) child under an attr-only type (validator.required,
    //     strict child set = []) → rejected at load.
    // -----------------------------------------------------------------------

    @Test
    public void fieldUnderValidatorIsRejected() {
        // validator.required admits no structural children — a field child is misplaced.
        String canonical =
            "{ \"metadata.root\": { \"package\": \"acme\", \"children\": ["
            + "  { \"object.entity\": { \"name\": \"Widget\", \"children\": ["
            + "    { \"field.long\": { \"name\": \"id\" } },"
            + "    { \"field.string\": { \"name\": \"code\", \"children\": ["
            + "      { \"validator.required\": { \"name\": \"req\", \"children\": ["
            + "        { \"field.string\": { \"name\": \"bogus\" } }"
            + "      ] } }"
            + "    ] } },"
            + "    { \"identity.primary\": { \"name\": \"pk\", \"@fields\": \"id\" } }"
            + "  ] } }"
            + "] } }";

        MetaDataException e = loadExpectingThrow(canonical, "field-under-validator.json");
        assertNotNull("a field child under an attr-only validator.required must be REJECTED "
                + "at strict load (validator's strict child set is empty)", e);
        String msg = e.getMessage();
        assertTrue("error must name the misplaced field child; got: " + msg,
            msg != null && msg.contains("field"));
        assertTrue("error must name the validator parent; got: " + msg,
            msg != null && msg.contains("validator"));
    }
}
