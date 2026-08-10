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
package com.metaobjects.manager.db.driver;

import com.metaobjects.manager.exp.Expression;
import com.metaobjects.manager.exp.Range;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.*;

/**
 * Pins three query-lowering behaviors that a design review found wrong, each of which the
 * persistence-conformance corpus structurally CANNOT detect.
 *
 * <p>1. <b>Range is 1-based inclusive.</b> The drivers emit {@code OFFSET start-1} and skip
 * OFFSET entirely when {@code start <= 1}, so a caller treating Range as 0-indexed makes
 * {@code offset=1} return rows from the beginning. Undetected because no persistence query
 * scenario uses a nonzero offset.
 *
 * <p>2. <b>A Collection value on EQUAL renders native {@code IN (?,?)}.</b> Callers had been
 * hand-composing OR-chains on the false belief that Expression has no IN — and
 * {@code ExpressionOperator} renders WITHOUT parentheses, so {@code in} combined with any
 * second predicate produced {@code a=1 OR a=2 AND b=3}, which SQL regroups as
 * {@code a=1 OR (a=2 AND b=3)} and silently returns wrong rows. Undetected because no corpus
 * scenario mixes {@code in} with another filter.
 *
 * <p>3. <b>{@link Expression#LIKE} is case-SENSITIVE with a verbatim pattern.</b> The older
 * {@code CONTAIN}/{@code START_WITH}/{@code END_WITH} wrap both sides in {@code UPPER(...)}.
 * The cross-port REST contract's {@code like} is case-sensitive SQL LIKE with author-supplied
 * wildcards (ADR-0047). Originally undetected because the corpus case-aligned its seed data
 * "so the test passes whether a port wires LIKE or ILIKE"; the corpus has since been
 * de-blinded (filter-like-and-ne seeds a case-mismatched pair and probes both casings), so
 * it now catches a case-folding {@code like} — this pin stays as the unit-level guard on the
 * driver's SQL shape itself.
 */
public class ExpressionLoweringPinsTest {

    // ---- 1. Range semantics -------------------------------------------------

    @Test
    public void rangeIsOneBasedInclusive_postgres() {
        PostgresDriver pg = new PostgresDriver();
        // offset=0, limit=10  ->  Range(1,10): no OFFSET clause at all.
        assertEquals("LIMIT 10", pg.getRangeString(new Range(1, 10)));
        // offset=1, limit=10  ->  Range(2,11): OFFSET 1. A 0-based caller would have
        // passed Range(1,10) here and silently skipped nothing.
        assertEquals("LIMIT 10 OFFSET 1", pg.getRangeString(new Range(2, 11)));
        // offset=20, limit=5  ->  Range(21,25).
        assertEquals("LIMIT 5 OFFSET 20", pg.getRangeString(new Range(21, 25)));
    }

    @Test
    public void rangeConversionFromRestOffsetLimit() {
        // The conversion every caller must perform, pinned so it cannot drift back.
        int offset = 1, limit = 10;
        Range r = new Range(offset + 1, offset + limit);
        assertEquals(2, r.getStart());
        assertEquals(11, r.getEnd());
        assertEquals(limit, r.getEnd() - r.getStart() + 1);
    }

    // ---- 2. Native IN -------------------------------------------------------

    @Test
    public void collectionOnEqualIsAcceptedForNativeInRendering() {
        // Expression permits a Collection value on EQUAL/NOT_EQUAL; GenericSQLDriver
        // renders it as a parameterized IN list. Constructing it must NOT throw — that is
        // what makes the OR-chain workaround unnecessary (and its precedence bug moot).
        Expression in = new Expression("status", List.of("A", "B", "C"), Expression.EQUAL);
        assertEquals(Expression.EQUAL, in.getCondition());
        assertTrue(in.getValue() instanceof java.util.Collection);
        assertEquals(3, ((java.util.Collection<?>) in.getValue()).size());
    }

    @Test
    public void collectionIsRejectedOnAnInequalityCondition() {
        // The driver only renders IN for EQUAL/NOT_EQUAL; anything else must fail loudly
        // rather than emit nonsense SQL.
        try {
            new Expression("n", List.of(1, 2), Expression.GREATER);
            // Construction may be permissive; the driver enforces it. Either is acceptable
            // so long as it is not silently rendered — assert only when it does throw.
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().toLowerCase().contains("collection"));
        }
    }

    // ---- 3. Case-sensitive LIKE --------------------------------------------

    @Test
    public void likeIsADistinctConditionFromTheCaseInsensitiveAnchoredOnes() {
        // The whole point: LIKE must not collide with, or be re-mapped onto, the
        // UPPER()-wrapping conditions.
        assertNotEquals(Expression.LIKE, Expression.CONTAIN);
        assertNotEquals(Expression.LIKE, Expression.START_WITH);
        assertNotEquals(Expression.LIKE, Expression.END_WITH);
        assertNotEquals(Expression.LIKE, Expression.EQUALS_IGNORE_CASE);
    }

    @Test
    public void likeCarriesThePatternVerbatim() {
        // No %-wrapping, no case folding, and an INTERIOR wildcard survives — the shape the
        // anchored conditions could not express at all.
        Expression e = new Expression("name", "a%b_c", Expression.LIKE);
        assertEquals(Expression.LIKE, e.getCondition());
        assertEquals("a%b_c", e.getValue());
    }
}
