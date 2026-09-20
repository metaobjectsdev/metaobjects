// ConstraintErrors — the C# half of the cross-port constraint contract.
//
// The api contract says a client-supplied FK that does not exist, or a value that
// duplicates a unique one, is 409 {error:"constraint_violation", constraint:"<kind>"}.
// Before this, a generated route had no try/catch around SaveChangesAsync, so every one
// of those answered a bare 500 — four scenarios of the shared contract corpus, plus a
// fifth that cascaded because the failing scenario never reached its own cleanup.
//
// The message strings below are the REAL ones the drivers produce, quoted so the test
// fails if a driver changes its spelling rather than silently classifying nothing. The
// EF wrapper text is likewise real: DbUpdateException's own message says nothing about
// the constraint, which is exactly why the chain walk is load-bearing.

using MetaObjects.Codegen.Runtime;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class ConstraintErrorsTests
{
    /// <summary>What EF Core wraps every provider failure in — the message that made a
    /// top-level-only read classify nothing.</summary>
    private const string EfWrapper =
        "An error occurred while saving the entity changes. See the inner exception for details.";

    private static Exception Wrapped(string providerMessage) =>
        new InvalidOperationException(EfWrapper, new Exception(providerMessage));

    [Theory]
    // Npgsql — PostgresException.Message leads with the SQLSTATE.
    [InlineData("23503: insert or update on table \"leg\" violates foreign key constraint \"leg_shipment_id_fkey\"",
        409, "foreign_key")]
    [InlineData("23505: duplicate key value violates unique constraint \"shipment_reference_key\"",
        409, "unique")]
    [InlineData("23514: new row for relation \"shipment\" violates check constraint \"shipment_status_chk\"",
        400, "check")]
    [InlineData("23502: null value in column \"reference\" of relation \"shipment\" violates not-null constraint",
        400, "not_null")]
    // Microsoft.Data.Sqlite — no SQLSTATE; the constraint is spelled out.
    [InlineData("SQLite Error 19: 'FOREIGN KEY constraint failed'.", 409, "foreign_key")]
    [InlineData("SQLite Error 19: 'UNIQUE constraint failed: shipment.reference'.", 409, "unique")]
    public void A_constraint_violation_classifies_through_the_ef_wrapper(
        string providerMessage, int expectedStatus, string expectedConstraint)
    {
        var failure = ConstraintErrors.Classify(Wrapped(providerMessage));

        Assert.NotNull(failure);
        Assert.Equal(expectedStatus, failure!.Status);
        Assert.Equal("constraint_violation", failure.Error);
        Assert.Equal(expectedConstraint, failure.Constraint);
    }

    [Fact]
    public void The_ef_wrapper_alone_classifies_nothing()
    {
        // Fails CLOSED: with no provider detail there is no constraint to name, and the
        // caller must rethrow rather than guess a client error out of a server one.
        Assert.Null(ConstraintErrors.Classify(new InvalidOperationException(EfWrapper)));
    }

    [Theory]
    [InlineData("42703: column s.bookedById does not exist")]   // a real schema mismatch: 500, not 409
    [InlineData("Connection refused")]
    [InlineData("")]
    public void A_non_constraint_failure_is_not_classified(string message)
    {
        Assert.Null(ConstraintErrors.Classify(new Exception(message)));
    }

    [Fact]
    public void A_null_exception_is_not_classified()
    {
        Assert.Null(ConstraintErrors.Classify(null));
    }

    [Fact]
    public void An_aggregate_exceptions_failures_are_read_too()
    {
        // AggregateException holds its failures BESIDE InnerException, so walking the
        // inner chain alone reads only the first one.
        var agg = new AggregateException(
            new Exception("some unrelated failure"),
            new Exception("23505: duplicate key value violates unique constraint \"x_key\""));

        var failure = ConstraintErrors.Classify(agg);
        Assert.Equal("unique", failure?.Constraint);
    }

    [Fact]
    public void The_chain_walk_is_depth_bounded()
    {
        // A long chain must not turn a failed write into an unbounded walk on the request
        // thread. The bound is what makes that guarantee; the cost is that a constraint
        // buried deeper than the bound reads as unclassified — which fails CLOSED (a 500),
        // and is far beyond anything EF produces (it wraps exactly one level).
        Exception deep = new Exception("23505: duplicate key value violates unique constraint \"x\"");
        for (var i = 0; i < 200; i++) deep = new Exception("wrapper " + i, deep);

        Assert.Null(ConstraintErrors.Classify(deep));
    }
}
