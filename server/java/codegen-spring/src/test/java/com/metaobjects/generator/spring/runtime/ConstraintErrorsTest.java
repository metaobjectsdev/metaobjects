package com.metaobjects.generator.spring.runtime;

import org.junit.Test;

import java.sql.SQLException;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

/**
 * {@link ConstraintErrors} — the Java half of the cross-port constraint mapping.
 *
 * <p>Ported from runtime-ts's {@code constraint-errors.ts} and C#'s {@code ConstraintErrors},
 * so these cases mirror theirs arm for arm rather than testing a third design.</p>
 */
public class ConstraintErrorsTest {

    /** Spring's real shape: the driver's SQLException sits UNDER a DataAccessException. */
    private static RuntimeException wrapped(SQLException driver) {
        return new RuntimeException("could not execute statement", driver);
    }

    @Test
    public void classifiesAForeignKeyViolationAs409() {
        ConstraintErrors.Failure f = ConstraintErrors.classify(
            wrapped(new SQLException("insert or update on table \"leg\" violates foreign key constraint",
                "23503")));
        assertNotNull("SQLSTATE 23503 must classify", f);
        assertEquals(ConstraintErrors.Kind.FOREIGN_KEY, f.kind());
        assertEquals("a dangling reference conflicts with EXISTING state", 409, f.status());
        assertEquals("foreign_key", f.constraint());
        assertEquals("constraint_violation", f.error());
    }

    @Test
    public void classifiesAUniqueViolationAs409() {
        ConstraintErrors.Failure f = ConstraintErrors.classify(
            wrapped(new SQLException("duplicate key value violates unique constraint", "23505")));
        assertNotNull(f);
        assertEquals(ConstraintErrors.Kind.UNIQUE, f.kind());
        assertEquals(409, f.status());
        assertEquals("unique", f.constraint());
    }

    /**
     * 400, not 409: a CHECK or NOT NULL failure is a value the request itself got wrong, not a
     * conflict with state that already exists. Same split as TypeScript and C#.
     */
    @Test
    public void classifiesCheckAndNotNullAs400() {
        ConstraintErrors.Failure check = ConstraintErrors.classify(
            wrapped(new SQLException("new row violates check constraint", "23514")));
        assertNotNull(check);
        assertEquals(ConstraintErrors.Kind.CHECK, check.kind());
        assertEquals(400, check.status());

        ConstraintErrors.Failure notNull = ConstraintErrors.classify(
            wrapped(new SQLException("null value in column violates not-null constraint", "23502")));
        assertNotNull(notNull);
        assertEquals(ConstraintErrors.Kind.NOT_NULL, notNull.kind());
        assertEquals(400, notNull.status());
    }

    /**
     * The defect the chain walk exists for. A wrapper's OWN message names no constraint, so a
     * top-level-only read classifies NOTHING and every violation falls to a bare 500 — which is
     * exactly how the first cut of the TypeScript version behaved against a real server.
     */
    @Test
    public void readsThroughTheWrapperRatherThanTheTopLevelMessage() {
        RuntimeException outer = new RuntimeException(
            "PreparedStatementCallback; SQL [insert into leg ...]",
            wrapped(new SQLException("violates foreign key constraint", "23503")));

        assertNull("the outer message alone carries no constraint",
            ConstraintErrors.classify(new RuntimeException(outer.getMessage())));
        assertNotNull("but the chain does", ConstraintErrors.classify(outer));
    }

    /** A batch failure puts the useful exception on getNextException(), not getCause(). */
    @Test
    public void readsTheSqlExceptionNextChainToo() {
        SQLException head = new SQLException("batch entry failed", (String) null);
        head.setNextException(new SQLException("duplicate key value", "23505"));

        ConstraintErrors.Failure f = ConstraintErrors.classify(wrapped(head));
        assertNotNull("the next-exception chain must be read", f);
        assertEquals(ConstraintErrors.Kind.UNIQUE, f.kind());
    }

    /** Drivers with no SQLSTATE are recognised by the constraint-name vocabulary. */
    @Test
    public void fallsBackToMessageTextWhenTheDriverGivesNoCode() {
        ConstraintErrors.Failure f = ConstraintErrors.classify(
            wrapped(new SQLException("UNIQUE constraint failed: shipment.reference")));
        assertNotNull(f);
        assertEquals(ConstraintErrors.Kind.UNIQUE, f.kind());
    }

    /**
     * Anything else must return null so the caller RETHROWS: the operator keeps the diagnostic
     * and the client gets a plain 500 carrying none of it. Classifying an unknown failure as a
     * constraint violation would tell the caller a falsehood.
     */
    @Test
    public void returnsNullForAnythingThatIsNotAConstraintViolation() {
        assertNull(ConstraintErrors.classify(new RuntimeException("connection refused")));
        assertNull(ConstraintErrors.classify(new IllegalStateException("pool exhausted")));
        assertNull(ConstraintErrors.classify(null));
    }

    /** A self-referential cause is legal and must not spin. */
    @Test
    public void toleratesASelfReferentialCause() {
        class Loop extends RuntimeException {
            Loop() { super("loop"); }
            @Override public synchronized Throwable getCause() { return this; }
        }
        assertNull(ConstraintErrors.classify(new Loop()));
    }
}
