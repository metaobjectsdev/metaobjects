// RoundtripWriter — executes an `op: roundtrip` scenario against the EF runtime.
//
// The WRITE gate: INSERT the scenario's `insert:` row through the EF Core write
// path (NOT raw SQL), then read the inserted row back BY PRIMARY KEY so the write
// codec + the read path are exercised together. Mirrors the TS reference runner
// (runtime-ts ObjectManager.create → read-back-by-PK), see
// server/typescript/packages/integration-tests/src/query-scenario.ts.
//
//   1. Resolve the generated EF entity type for the metadata name.
//   2. Build an instance: each `insert:` field → property, coercing the YAML
//      authoring form to the property's CLR type (a quoted decimal/uuid string →
//      decimal/Guid; a temporal string → DateOnly/TimeOnly/DateTime with the right
//      DateTimeKind; an enum symbol → the nested enum; a nested mapping → the owned
//      value-object POCO). An unspecified PK is left at its default so the schema's
//      gen_random_uuid() DEFAULT fills it on INSERT.
//   3. db.Add + SaveChangesAsync — EF/Npgsql applies the write codec
//      (HasConversion<string>() for enums, OwnsOne(.ToJson) for the jsonb object,
//      native uuid, NUMERIC precision, timestamp/timestamptz).
//   4. Read the row back by its (now-populated) PK, project to a field-keyed row,
//      DROP the PK (server-generated → non-deterministic), and return it for
//      normalization + comparison against `expect:`.

using System.Reflection;
using MetaObjects.IntegrationTests.Generated;
using Microsoft.EntityFrameworkCore;
using YamlDotNet.RepresentationModel;

namespace MetaObjects.IntegrationTests.Runner;

public static class RoundtripWriter
{
    /// <summary>
    /// INSERT the spec's <c>insert:</c> row via EF, read it back by PK, and return
    /// the read-back as a field-keyed row dictionary with the PK removed (or null if
    /// the read-back found nothing — which the assertion will surface).
    /// </summary>
    public static async Task<IReadOnlyDictionary<string, object?>?> ExecuteAsync(AppDbContext db, QuerySpec spec)
    {
        if (spec.Insert is null)
            throw new InvalidOperationException($"op:roundtrip '{spec.Name}' requires an `insert` block (the row to write)");

        var entityType = ResolveEntityType(spec.Entity);
        var insert = AsMapping(spec.Insert, $"op:roundtrip '{spec.Name}' insert");

        var instance = Activator.CreateInstance(entityType)
            ?? throw new InvalidOperationException($"could not instantiate generated entity '{entityType.Name}'");

        foreach (var (keyNode, valueNode) in insert.Children)
        {
            var fieldName = ((YamlScalarNode)keyNode).Value!;
            var prop = WriteCoercion.Property(entityType, fieldName);
            prop.SetValue(instance, WriteCoercion.CoerceToProperty(valueNode, prop.PropertyType, prop));
        }

        db.Add(instance);
        await db.SaveChangesAsync();

        // Capture the PK EF populated on SaveChanges (server-generated uuid DEFAULT or
        // an explicit value) BEFORE detaching.
        var pkProp = PrimaryKeyProperty(db, entityType);
        var pkValue = pkProp.GetValue(instance);

        // CRITICAL: clear the change-tracker so the read-back is a fresh DB SELECT, not
        // the cached in-memory instance EF's identity map would otherwise return for
        // FindAsync. Without this the read-back never exercises the DB read codec
        // (enum text→enum, jsonb text→POCO, timestamptz→UTC, NUMERIC rounding) — it
        // would just echo the objects we wrote, hiding any write/read codec defect. The
        // read scenarios get this for free via .AsNoTracking(); a write+read needs the
        // explicit clear.
        db.ChangeTracker.Clear();

        // Read back by the single-column primary key (now a real round-trip read).
        var readBack = await FindByKeyAsync(db, entityType, pkValue);
        if (readBack is null) return null;

        var row = EntityRow.Of(readBack);
        // Drop the PK — a server-/runtime-generated PK is non-deterministic, so the
        // contract asserts the written field VALUES, not the identity. (op:get covers
        // PK round-trip.) Keyed case-insensitively to match the row dict.
        var pkFieldKey = char.ToLowerInvariant(pkProp.Name[0]) + pkProp.Name[1..];
        return row.Where(kv => !string.Equals(kv.Key, pkFieldKey, StringComparison.OrdinalIgnoreCase))
                  .ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.OrdinalIgnoreCase);
    }

    // -----------------------------------------------------------------------
    // Entity / property / key resolution
    // -----------------------------------------------------------------------

    private static Type ResolveEntityType(string metadataName) =>
        typeof(AppDbContext).Assembly.GetType(
            $"MetaObjects.IntegrationTests.Generated.{metadataName}", throwOnError: false)
        ?? throw new InvalidOperationException($"Generated entity type for metadata name '{metadataName}' not found");

    // The single primary-key property, read from EF's model (the [Key] / fluent PK).
    private static PropertyInfo PrimaryKeyProperty(AppDbContext db, Type entityType)
    {
        var key = db.Model.FindEntityType(entityType)?.FindPrimaryKey()
            ?? throw new InvalidOperationException($"entity '{entityType.Name}' has no EF primary key");
        if (key.Properties.Count != 1)
            throw new InvalidOperationException($"op:roundtrip: entity '{entityType.Name}' requires a single-column primary key");
        var efProp = key.Properties[0];
        return entityType.GetProperty(efProp.Name)
            ?? throw new InvalidOperationException($"PK property '{efProp.Name}' not found on '{entityType.Name}'");
    }

    // db.FindAsync(entityType, key) — generic over the runtime entity type.
    private static async Task<object?> FindByKeyAsync(AppDbContext db, Type entityType, object? pkValue)
    {
        var valueTask = db.FindAsync(entityType, [pkValue]);
        return await valueTask;
    }

    private static YamlMappingNode AsMapping(YamlNode node, string what) =>
        node as YamlMappingNode
        ?? throw new InvalidOperationException($"{what} must be a mapping (got {node.GetType().Name})");
}
