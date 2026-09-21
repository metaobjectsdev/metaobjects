// ConstraintErrors — map a database constraint violation to a wire response.
//
// A generated CRUD route had no try/catch around its write, so a driver failure reached
// Spring's default handler and came back to the caller as a bare 500. Two problems, and
// the first is what a client actually sees:
//
//  1. WRONG STATUS. A client-supplied foreign key that does not exist, or a value that
//     duplicates an existing unique one, is a CLIENT error. The `identity.reference` and
//     `identity.secondary` that declare those constraints are the same metadata the route
//     already uses to reject bad enum members and missing required fields — it just never
//     translated the constraints the DATABASE enforces.
//  2. A 500 tells the caller nothing actionable, and Spring's default error body can
//     carry the exception message — which for a JDBC driver names the SQL and sometimes
//     the bound values. On a POST whose columns hold PII that is user data reflected back
//     out of generated code the adopter never wrote.
//
// This is the Java port of runtime-ts's `constraint-errors.ts` and of C#'s
// `MetaObjects.Codegen.Runtime.ConstraintErrors`, and it deliberately keeps their
// algorithm rather than inventing a third: walk the exception chain, collect the codes and
// messages, and match driver error CODES first with the constraint-name vocabulary as the
// fallback. `docs/features/api-contract.md` states the `error` code vocabulary is not a
// hard cross-port invariant beyond `not_found` and the filter-parser codes, so there is
// exactly ONE code here — `constraint_violation`, with the offending KIND — matching the
// other ports rather than inventing a taxonomy they would then have to follow.
//
// WHY THE CHAIN AND NOT THE TOP LEVEL: Spring wraps every JDBC failure in a
// `DataAccessException` (`DataIntegrityViolationException` for this class of error) whose
// own message names no constraint, and the driver's `SQLException` sits underneath it. A
// top-level-only read therefore classifies NOTHING — the same defect the TypeScript
// version hit with Drizzle's wrapper and the C# one with EF's `DbUpdateException`.
//
// WHY NO PROVIDER DEPENDENCY: this module must not reference Postgres, MySQL or any other
// driver — a consumer may be on any of them. `java.sql.SQLException#getSQLState()` is JDK
// API, not provider API, so the SQLSTATE is read directly where the driver supplies one
// (every Postgres integrity violation is class 23) and message text covers the drivers
// that do not. Only the SQLSTATE and the message are read — never a statement or its
// parameters — so the matched text cannot carry user data into a classification decision.

package com.metaobjects.generator.spring.runtime;

import java.sql.SQLException;
import java.util.Locale;

/**
 * Recognises a database constraint violation in an exception chain, for generated CRUD
 * route handlers. Driver-agnostic by construction — see the file header.
 */
public final class ConstraintErrors {

    private ConstraintErrors() {}

    /** The constraint kinds worth telling a client apart. */
    public enum Kind {
        /** A referenced row does not exist (SQLSTATE 23503). */
        FOREIGN_KEY("foreign_key"),
        /** A value duplicates an existing one (SQLSTATE 23505). */
        UNIQUE("unique"),
        /** A CHECK constraint rejected the value (SQLSTATE 23514). */
        CHECK("check"),
        /** A NOT NULL column got null (SQLSTATE 23502). */
        NOT_NULL("not_null");

        private final String wire;

        Kind(String wire) { this.wire = wire; }

        /** The cross-port snake_case spelling carried in the {@code constraint} body field. */
        public String wire() { return wire; }
    }

    /**
     * A recognised constraint violation, as status plus the two body fields. Never carries
     * SQL, parameters or driver text.
     *
     * @param status HTTP status for this failure
     * @param kind   which constraint the database enforced
     */
    public record Failure(int status, Kind kind) {
        /** The single {@code error} code — see the file header for why there is only one. */
        public String error() { return "constraint_violation"; }

        /** The {@code constraint} body field. */
        public String constraint() { return kind.wire(); }
    }

    /**
     * The failure this throwable represents, or {@code null} when it is not a constraint
     * violation — in which case the caller must rethrow, so the operator keeps the full
     * diagnostic and the client gets a plain 500 with none of it.
     *
     * @param error the throwable caught around a write
     * @return the classified failure, or {@code null}
     */
    public static Failure classify(Throwable error) {
        String haystack = chainText(error);
        if (haystack.isEmpty()) return null;

        Kind kind = kindOf(haystack);
        if (kind == null) return null;

        // 409 for referential/uniqueness conflicts with EXISTING state; 400 for a value the
        // request itself got wrong. Both are client errors — neither is a 500.
        int status = (kind == Kind.FOREIGN_KEY || kind == Kind.UNIQUE) ? 409 : 400;
        return new Failure(status, kind);
    }

    /**
     * Ordered most- to least-specific, matching the other ports arm for arm. A foreign-key
     * violation's message can also contain the word "KEY" from a unique index name, so the
     * SQLSTATE arm is what actually discriminates on Postgres; the text arms serve the
     * drivers that carry no code.
     */
    private static Kind kindOf(String haystack) {
        if (haystack.contains("23503") || haystack.contains("FOREIGN KEY")
                || haystack.contains("SQLITE_CONSTRAINT_FOREIGNKEY")) {
            return Kind.FOREIGN_KEY;
        }
        if (haystack.contains("23505") || haystack.contains("UNIQUE CONSTRAINT")
                || haystack.contains("SQLITE_CONSTRAINT_UNIQUE")) {
            return Kind.UNIQUE;
        }
        if (haystack.contains("23514") || haystack.contains("CHECK CONSTRAINT")
                || haystack.contains("SQLITE_CONSTRAINT_CHECK")) {
            return Kind.CHECK;
        }
        if (haystack.contains("23502") || haystack.contains("NOT NULL")
                || haystack.contains("SQLITE_CONSTRAINT_NOTNULL")) {
            return Kind.NOT_NULL;
        }
        return null;
    }

    /**
     * The SQLSTATEs and messages of this throwable and everything in its cause chain,
     * upper-cased and joined.
     *
     * <p>Depth-bounded and self-reference-guarded: a wrapper whose cause is itself is legal
     * and would otherwise spin here. A {@link SQLException} also carries a
     * {@code getNextException()} chain that is SEPARATE from {@code getCause()} — batch
     * failures put the useful one there — so both are walked.</p>
     */
    private static String chainText(Throwable error) {
        StringBuilder parts = new StringBuilder();
        Throwable cur = error;
        for (int depth = 0; depth < 8 && cur != null; depth++) {
            if (cur instanceof SQLException sql) {
                String state = sql.getSQLState();
                if (state != null) parts.append(state).append(' ');
                SQLException next = sql.getNextException();
                if (next != null && next != sql) {
                    String nextState = next.getSQLState();
                    if (nextState != null) parts.append(nextState).append(' ');
                    if (next.getMessage() != null) parts.append(next.getMessage()).append(' ');
                }
            }
            if (cur.getMessage() != null) parts.append(cur.getMessage()).append(' ');
            Throwable cause = cur.getCause();
            if (cause == cur) break;
            cur = cause;
        }
        return parts.toString().toUpperCase(Locale.ROOT);
    }
}
