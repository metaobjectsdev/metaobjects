package com.metaobjects.field;

import org.junit.Test;

import java.util.Arrays;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * FR-037 R1 — the {@code @mutability} tightening order is load-bearing, so it is pinned.
 *
 * <p>{@code ValidationPhase.mutabilityRank()} is an INDEX comparison over
 * {@link MetaField#MUTABILITY_MODES} ("declaration order IS the tightening order", as the
 * constant's own javadoc says), so reordering that list silently inverts "may only tighten"
 * with nothing to catch it. Kotlin inherits this same constant through the JVM loader, so
 * this pin covers both JVM ports.
 *
 * <p>The shared conformance corpus cannot stand in for this. Its inheritance fixtures pair
 * only {@code readOnly} with {@code readWrite} — the two ENDPOINTS — so a full reversal is
 * caught but a reorder that moves ONLY {@code writeOnce} is not.
 * {@code error-field-mutability-downgrade-writeonce} closes the behavioural half cross-port;
 * this closes the structural half in the port whose rank function reads the list.
 *
 * <p>Mirrors the TypeScript pin (metadata/test/fr037-field-mutability.test.ts), which was the
 * only such pin in any port until now.
 */
public class FieldMutabilityOrderTest {

    @Test
    public void declarationOrderIsTheTighteningOrder() {
        // Loosest first. The downgrade rule is rank(child) >= rank(parent), so this
        // order IS the rule.
        assertEquals(
                Arrays.asList("readWrite", "writeOnce", "readOnly"),
                MetaField.MUTABILITY_MODES);
    }

    @Test
    public void modeSpellings() {
        // The wire spellings travel cross-port; a typo here is a silent divergence.
        assertEquals("readWrite", MetaField.MUTABILITY_READ_WRITE);
        assertEquals("writeOnce", MetaField.MUTABILITY_WRITE_ONCE);
        assertEquals("readOnly", MetaField.MUTABILITY_READ_ONLY);
    }

    /**
     * The specific relationship the corpus never exercises. Stated as an explicit rank
     * comparison rather than inferred from the list above, so a future change that keeps the
     * list's CONTENTS but alters how rank is derived still fails here.
     */
    @Test
    public void writeOnceRanksBetweenTheTwoEndpoints() {
        int readWrite = MetaField.MUTABILITY_MODES.indexOf(MetaField.MUTABILITY_READ_WRITE);
        int writeOnce = MetaField.MUTABILITY_MODES.indexOf(MetaField.MUTABILITY_WRITE_ONCE);
        int readOnly = MetaField.MUTABILITY_MODES.indexOf(MetaField.MUTABILITY_READ_ONLY);
        assertTrue("readWrite must rank looser than writeOnce", readWrite < writeOnce);
        assertTrue("writeOnce must rank looser than readOnly", writeOnce < readOnly);
    }
}
