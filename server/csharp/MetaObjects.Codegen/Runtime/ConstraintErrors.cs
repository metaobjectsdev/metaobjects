// ConstraintErrors — map a database constraint violation to a wire response.
//
// A generated CRUD route had no try/catch around its write, so a driver failure reached
// ASP.NET Core's default handler and came back as a bare 500. Two problems, and the first
// is what a client actually sees:
//
//  1. WRONG STATUS. A client-supplied foreign key that does not exist, or a reference
//     that duplicates an existing unique value, is a CLIENT error. The
//     `identity.reference` and `index.unique` that declare those constraints are the same
//     metadata the route already uses to reject bad enum members and missing required
//     fields — it just never translated the constraints the database enforces.
//  2. The 500 says nothing an operator or a caller can act on.
//
// This is the C# port of runtime-ts's `constraint-errors.ts`, and it deliberately keeps
// that module's algorithm rather than inventing a second one: match on driver error CODES
// carried in the exception chain's message text, falling back to the constraint-name
// vocabulary the engines use. `docs/features/api-contract.md` states the `error` code
// vocabulary is not a hard cross-port invariant beyond `not_found` and the filter-parser
// codes, so there is exactly ONE code here — `constraint_violation`, with the offending
// KIND — matching TypeScript byte for byte rather than inventing a taxonomy the other
// ports would then have to follow.
//
// STRUCTURED CODES FIRST: when the chain holds a DbException that reports a SQLSTATE
// (DbException.SqlState, which Npgsql fills), or an exception exposing a SQLite extended
// result code (Microsoft.Data.Sqlite's SqliteExtendedErrorCode, read by property name so no
// provider is referenced), that code is the verdict and message text is never consulted:
// a unique-violation whose offending value happens to read "NOT NULL" is still a unique
// violation. Message matching survives only as the fallback for exceptions that carry no
// code at all, such as an in-memory double.
//
// WHY NOT A TYPED DRIVER CHECK: this assembly must not take a dependency on any
// specific ADO.NET provider — a consumer may be on Npgsql, SQL Server, SQLite or an
// in-memory double, and binding to one of them here would make the generated routes
// unusable on the others. Npgsql puts the SQLSTATE at the front of PostgresException's
// message ("23505: duplicate key value violates unique constraint …"), and
// Microsoft.Data.Sqlite spells the constraint out ("UNIQUE constraint failed: …"), so
// both are recognised without either being referenced. Only Message is read — never a
// command text or parameter collection — so the matched text cannot carry user data into
// a classification decision.

namespace MetaObjects.Codegen.Runtime;

/// <summary>The constraint kinds worth telling a client apart.</summary>
public enum ConstraintKind
{
    /// <summary>A referenced row does not exist (SQLSTATE 23503).</summary>
    ForeignKey,
    /// <summary>A value duplicates an existing one (SQLSTATE 23505).</summary>
    Unique,
    /// <summary>A CHECK constraint rejected the value (SQLSTATE 23514).</summary>
    Check,
    /// <summary>A NOT NULL column got null (SQLSTATE 23502).</summary>
    NotNull,
}

/// <summary>
/// A recognised constraint violation, as status + the two body fields. Never carries SQL,
/// parameters or driver text.
/// </summary>
/// <param name="Status">HTTP status for this failure.</param>
/// <param name="Kind">Which constraint the database enforced.</param>
public sealed record ConstraintFailure(int Status, ConstraintKind Kind)
{
    /// <summary>The single `error` code — one per ADR-free api-contract note, see the file header.</summary>
    public string Error => "constraint_violation";

    /// <summary>The `constraint` body field: the kind in the cross-port snake_case spelling.</summary>
    public string Constraint => Kind switch
    {
        ConstraintKind.ForeignKey => "foreign_key",
        ConstraintKind.Unique => "unique",
        ConstraintKind.Check => "check",
        _ => "not_null",
    };
}

/// <summary>
/// Recognises a database constraint violation in an exception chain, for generated CRUD
/// route handlers. Driver-agnostic by construction — see the file header.
/// </summary>
public static class ConstraintErrors
{
    /// <summary>
    /// The failure this exception represents, or <see langword="null"/> when it is not a
    /// constraint violation — in which case the caller must rethrow, so the operator keeps
    /// the full diagnostic and the client gets a plain 500.
    /// </summary>
    public static ConstraintFailure? Classify(Exception? error)
    {
        var coded = CodedVerdict(error, out var hasCode);
        if (hasCode) return coded is null ? null : Failure(coded.Value);

        var haystack = ChainText(error);
        if (haystack.Length == 0) return null;

        var kind = KindOf(haystack);
        if (kind is null) return null;

        // 409 for referential/uniqueness conflicts with EXISTING state; 400 for a value
        // the request itself got wrong. Both are client errors — neither is a 500.
        return Failure(kind.Value);
    }

    private static ConstraintFailure Failure(ConstraintKind kind)
    {
        var status = kind is ConstraintKind.ForeignKey or ConstraintKind.Unique ? 409 : 400;
        return new ConstraintFailure(status, kind);
    }

    private const int MaxDepth = 8;

    // SQLite extended result codes (https://www.sqlite.org/rescode.html).
    private const int SqliteConstraintCheck = 275;
    private const int SqliteConstraintForeignKey = 787;
    private const int SqliteConstraintNotNull = 1299;
    private const int SqliteConstraintPrimaryKey = 1555;
    private const int SqliteConstraintUnique = 2067;

    /// <summary>
    /// The verdict of the first exception in the chain that carries a structured code:
    /// <paramref name="hasCode"/> says whether one was found, and the return is its kind (null
    /// for a code that is not one of the four constraint classes).
    /// </summary>
    private static ConstraintKind? CodedVerdict(Exception? error, out bool hasCode)
    {
        var seen = 0;
        for (var e = error; e is not null && seen < MaxDepth; e = e.InnerException, seen++)
        {
            foreach (var candidate in e is AggregateException agg ? agg.InnerExceptions.Prepend(e) : new[] { e })
            {
                if (candidate is System.Data.Common.DbException { SqlState: { Length: > 0 } state })
                {
                    hasCode = true;
                    return state switch
                    {
                        "23503" => ConstraintKind.ForeignKey,
                        "23505" => ConstraintKind.Unique,
                        "23514" => ConstraintKind.Check,
                        "23502" => ConstraintKind.NotNull,
                        _ => null,
                    };
                }
                var extended = candidate.GetType().GetProperty("SqliteExtendedErrorCode")?.GetValue(candidate);
                if (extended is int code)
                {
                    hasCode = true;
                    return code switch
                    {
                        SqliteConstraintForeignKey => ConstraintKind.ForeignKey,
                        SqliteConstraintUnique or SqliteConstraintPrimaryKey => ConstraintKind.Unique,
                        SqliteConstraintCheck => ConstraintKind.Check,
                        SqliteConstraintNotNull => ConstraintKind.NotNull,
                        _ => null,
                    };
                }
            }
        }
        hasCode = false;
        return null;
    }

    private static ConstraintKind? KindOf(string haystack)
    {
        // Ordered most- to least-specific. A foreign-key violation's message can also
        // contain the word "KEY" from a unique index name, so the SQLSTATE arm is what
        // actually discriminates on Postgres; the text arms serve the drivers with no code.
        if (Contains(haystack, "23503") || Contains(haystack, "FOREIGN KEY")
            || Contains(haystack, "SQLITE_CONSTRAINT_FOREIGNKEY"))
            return ConstraintKind.ForeignKey;
        if (Contains(haystack, "23505") || Contains(haystack, "UNIQUE CONSTRAINT")
            || Contains(haystack, "SQLITE_CONSTRAINT_UNIQUE"))
            return ConstraintKind.Unique;
        if (Contains(haystack, "23514") || Contains(haystack, "CHECK CONSTRAINT")
            || Contains(haystack, "SQLITE_CONSTRAINT_CHECK"))
            return ConstraintKind.Check;
        if (Contains(haystack, "23502") || Contains(haystack, "NOT NULL")
            || Contains(haystack, "SQLITE_CONSTRAINT_NOTNULL"))
            return ConstraintKind.NotNull;
        return null;
    }

    private static bool Contains(string haystack, string needle) =>
        haystack.Contains(needle, StringComparison.Ordinal);

    /// <summary>
    /// The messages of this exception and everything in its <c>InnerException</c> chain,
    /// upper-cased and joined.
    /// <para>
    /// Walking the chain is load-bearing, not defensive: EF Core wraps every provider
    /// failure in a <c>DbUpdateException</c> whose own message is the generic "An error
    /// occurred while saving the entity changes", and the SQLSTATE lives one level down on
    /// the provider exception. Reading only the top level classifies NOTHING and every
    /// violation falls through to a 500.
    /// </para>
    /// <para>
    /// Depth-bounded: a malformed chain can be self-referential, and an
    /// <see cref="AggregateException"/> can fan out, so this walks the inner chain a fixed
    /// number of links rather than trusting it to terminate.
    /// </para>
    /// </summary>
    private static string ChainText(Exception? error)
    {
        var parts = new List<string>(MaxDepth);
        for (var e = error; e is not null && parts.Count < MaxDepth; e = e.InnerException)
        {
            if (!string.IsNullOrEmpty(e.Message)) parts.Add(e.Message);
            // An AggregateException holds its failures beside InnerException, so the chain
            // walk alone would miss every one but the first.
            if (e is AggregateException agg)
                foreach (var inner in agg.InnerExceptions)
                    if (!string.IsNullOrEmpty(inner.Message)) parts.Add(inner.Message);
        }
        return parts.Count == 0 ? "" : string.Join("\n", parts).ToUpperInvariant();
    }
}
