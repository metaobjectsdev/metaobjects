// RuntimeReturnTypeTests — SP-D Unit 4 runtime return-type gate (C# port).
//
// Pins ADR-0019: the EF Core runtime (AppDbContext / DbSet) materializes NATIVE
// CLR types from its query path — NOT canonicalized wire-strings. Wire
// canonicalization (the Normalization forms) is a boundary concern applied at
// the persistence-runner seam (QueryScenarioRunner.RowToJsonNode), never inside
// the runtime. This reads the materialized entity's properties BEFORE any
// normalization and asserts each native CLR type:
//
//   * Measurement.Id (BIGINT)         → long       (a native integer).
//   * Measurement.PreciseKg (NUMERIC) → decimal    (exact native decimal).
//   * Asset.RecordedAt (TIMESTAMPTZ)  → DateTime   (native temporal, NOT a string).
//   * Asset.Payload (jsonb)           → string     (the generated entity models a
//     jsonb open-JSON column as a string property; EF Core surfaces the raw JSON
//     text. The parse-to-object/key-sort step is a harness concern, NOT baked into
//     the runtime. We assert the runtime's genuine native return and document it).
//
// Per-port gate (native types differ per language), not a byte-identical
// cross-port corpus. Catches the Python-outlier class of regression: a runtime
// baking wire-strings into its query path.

using MetaObjects.IntegrationTests.Generated;
using MetaObjects.IntegrationTests.Runner;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Xunit;

namespace MetaObjects.IntegrationTests;

public sealed class RuntimeReturnTypeTests
{
    private const string MeasurementSeed = """
        INSERT INTO "measurements" ("id","tempC","massKg","preciseKg")
        VALUES (1, 1.5, 0.125, 12.5000);
        """;

    private const string AssetSeed = """
        INSERT INTO "assets"
          ("id","ownerId","externalId","payload","recordedAt","observedAt","asOfDate","atTime")
        VALUES
          ('11111111-1111-4111-8111-111111111111',
           'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
           '22222222-2222-4222-8222-222222222222',
           '{"b": 2, "a": 1}',
           '2026-05-30T14:30:00.123Z', '2026-05-30T14:30:00.123', '2026-05-30', '14:30:00.123');
        """;

    [Fact]
    public async Task Runtime_returns_native_types_not_wire_strings()
    {
        await using var pg = await PostgresContainer.StartAsync();

        // Provision schema from the committed TS-produced canonical DDL (ADR-0015) + seed.
        await ExecuteAsync(pg.ConnectionString, File.ReadAllText(CorpusPaths.CanonicalSchemaSql));
        await ExecuteAsync(pg.ConnectionString, MeasurementSeed);
        await ExecuteAsync(pg.ConnectionString, AssetSeed);

        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql(pg.ConnectionString)
            .Options;
        await using var db = new AppDbContext(options);

        // --- Measurement: native integer + native exact decimal -------------------
        var measurement = await db.Measurements.AsNoTracking().SingleAsync(m => m.Id == 1L);

        // The property type is statically `long` / `decimal` (generated). Reading
        // the boxed runtime value confirms EF Core materialized the native CLR type
        // (a wire-string regression would surface as a string here).
        object id = measurement.Id;
        Assert.True(id is long,
            $"field.long Measurement.Id must be a native long, got: {id.GetType()} (wire-string regression?)");

        object preciseKg = measurement.PreciseKg;
        Assert.True(preciseKg is decimal,
            $"field.decimal Measurement.PreciseKg must be a native exact decimal (ADR-0019), got: {preciseKg.GetType()}");
        Assert.Equal(12.5m, (decimal)preciseKg);

        // --- Asset: native temporal + native jsonb representation -----------------
        var assetId = Guid.Parse("11111111-1111-4111-8111-111111111111");
        var asset = await db.Assets.AsNoTracking().SingleAsync(a => a.Id == assetId);

        object recordedAt = asset.RecordedAt;
        Assert.True(recordedAt is DateTime,
            $"field.timestamp Asset.RecordedAt (TIMESTAMPTZ) must be a native DateTime, NOT a string. Got: {recordedAt.GetType()}");
        Assert.IsNotType<string>(recordedAt);

        // jsonb: the generated entity models the open-JSON column as a string property;
        // EF Core surfaces the raw JSON text. Parse-to-object/key-sort is a harness
        // concern, not baked into the runtime — we assert what the runtime returns.
        object? payload = asset.Payload;
        Assert.NotNull(payload);
        Assert.True(payload is string,
            $"Asset.Payload (jsonb) is surfaced by EF Core as raw JSON text; got: {payload!.GetType()}");
    }

    private static async Task ExecuteAsync(string connString, string sql)
    {
        await using var conn = new NpgsqlConnection(connString);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        await cmd.ExecuteNonQueryAsync();
    }
}
