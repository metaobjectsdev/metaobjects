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

using System.Globalization;
using System.Reflection;
using System.Text.Json.Nodes;
using MetaObjects.IntegrationTests.Generated;
using Microsoft.EntityFrameworkCore;
using YamlDotNet.Core;
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
            var prop = Property(entityType, fieldName);
            prop.SetValue(instance, CoerceToProperty(valueNode, prop.PropertyType, prop));
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

        var row = RowFor(readBack);
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

    private static PropertyInfo Property(Type entity, string fieldName) =>
        entity.GetProperty(char.ToUpperInvariant(fieldName[0]) + fieldName[1..])
        ?? throw new InvalidOperationException($"Entity '{entity.Name}' has no property for metadata field '{fieldName}'");

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

    // -----------------------------------------------------------------------
    // YAML → CLR coercion (the WRITE authoring forms)
    // -----------------------------------------------------------------------

    private static YamlMappingNode AsMapping(YamlNode node, string what) =>
        node as YamlMappingNode
        ?? throw new InvalidOperationException($"{what} must be a mapping (got {node.GetType().Name})");

    // Coerce a YAML authoring value to the target property's CLR type. Handles the
    // scalar subtypes (string/int/long/double/float/decimal/bool/currency), temporal
    // (DateOnly/TimeOnly/DateTime with the right Kind), uuid (Guid), enum (by symbol),
    // and a nested mapping → an owned value-object POCO (for the jsonb object field).
    private static object? CoerceToProperty(YamlNode node, Type targetType, PropertyInfo prop)
    {
        // A nested object/array authoring form (the @objectRef jsonb value-object).
        if (node is YamlMappingNode map)
            return BuildPoco(map, Nullable.GetUnderlyingType(targetType) ?? targetType);

        if (node is not YamlScalarNode scalar)
            throw new InvalidOperationException(
                $"op:roundtrip: unsupported insert value for '{prop.Name}' (kind {node.GetType().Name})");

        var raw = scalar.Value;
        if (raw is null || (scalar.Style is ScalarStyle.Plain && raw is "" or "~" or "null" or "Null" or "NULL"))
            return null;

        var underlying = Nullable.GetUnderlyingType(targetType) ?? targetType;

        if (underlying.IsEnum)
            return Enum.Parse(underlying, raw, ignoreCase: false);
        if (underlying == typeof(Guid))
            return Guid.Parse(raw);
        if (underlying == typeof(bool))
            return ParseBool(raw);
        if (underlying == typeof(string))
            return raw;
        if (underlying == typeof(int))
            return int.Parse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture);
        if (underlying == typeof(long))
            return long.Parse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture);
        if (underlying == typeof(short))
            return short.Parse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture);
        if (underlying == typeof(double))
            return double.Parse(raw, NumberStyles.Float, CultureInfo.InvariantCulture);
        if (underlying == typeof(float))
            return float.Parse(raw, NumberStyles.Float, CultureInfo.InvariantCulture);
        if (underlying == typeof(decimal))
            return decimal.Parse(raw, NumberStyles.Float, CultureInfo.InvariantCulture);
        if (underlying == typeof(DateOnly))
            return DateOnly.ParseExact(raw, "yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (underlying == typeof(TimeOnly))
            return ParseTime(raw);
        if (underlying == typeof(DateTime))
            return ParseDateTime(raw);

        throw new InvalidOperationException(
            $"op:roundtrip: no insert coercion for '{prop.Name}' of CLR type {underlying.Name}");
    }

    private static bool ParseBool(string raw) => raw switch
    {
        "true" or "True" or "TRUE" => true,
        "false" or "False" or "FALSE" => false,
        _ => bool.Parse(raw),
    };

    // TIME authoring form: "HH:mm:ss" or "HH:mm:ss.fff".
    private static TimeOnly ParseTime(string raw) =>
        TimeOnly.ParseExact(raw,
            raw.Contains('.') ? "HH:mm:ss.FFFFFFF" : "HH:mm:ss", CultureInfo.InvariantCulture);

    // Temporal authoring forms:
    //   * trailing "Z"  → a TIMESTAMPTZ instant; parse as UTC and tag Kind=Utc so
    //     Npgsql writes it to a `timestamp with time zone` column.
    //   * no "Z"        → a wall-clock TIMESTAMP; tag Kind=Unspecified so Npgsql
    //     writes it to a `timestamp without time zone` column (a Kind=Utc value would
    //     be rejected by a plain-timestamp column, and vice-versa).
    // This is the WRITE-side mirror of Normalization.FormatDateTime's Kind discriminator.
    private static DateTime ParseDateTime(string raw)
    {
        if (raw.EndsWith('Z'))
        {
            var dt = DateTime.Parse(raw, CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal);
            return DateTime.SpecifyKind(dt, DateTimeKind.Utc);
        }
        var local = DateTime.Parse(raw, CultureInfo.InvariantCulture, DateTimeStyles.None);
        return DateTime.SpecifyKind(local, DateTimeKind.Unspecified);
    }

    // Build an owned value-object POCO from a nested mapping, coercing each member to
    // its property type (recursively, for nested objects). EF serializes this to the
    // jsonb column via the OwnsOne(.ToJson) mapping in the DbContext.
    private static object BuildPoco(YamlMappingNode map, Type pocoType)
    {
        var instance = Activator.CreateInstance(pocoType)
            ?? throw new InvalidOperationException($"could not instantiate value object '{pocoType.Name}'");
        foreach (var (keyNode, valueNode) in map.Children)
        {
            var fieldName = ((YamlScalarNode)keyNode).Value!;
            var prop = Property(pocoType, fieldName);
            prop.SetValue(instance, CoerceToProperty(valueNode, prop.PropertyType, prop));
        }
        return instance;
    }

    // -----------------------------------------------------------------------
    // Read-back → field-keyed row (mirrors DbContextAdapter.RowFor)
    // -----------------------------------------------------------------------

    private static IReadOnlyDictionary<string, object?> RowFor(object entity)
    {
        var dict = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
        foreach (var prop in entity.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var key = char.ToLowerInvariant(prop.Name[0]) + prop.Name[1..];
            dict[key] = WireValue(prop.GetValue(entity));
        }
        return dict;
    }

    // An owned value-object (the @objectRef jsonb field) materializes as a POCO, not
    // the jsonb string a raw-jsonb read column would yield. Project it to a JSON
    // STRING keyed by the lowerCamel field names so it flows through the SAME
    // Normalization jsonb path (TryParseJsonContainer → sorted keys) as a string-typed
    // jsonb column — keeping the wire form identical to the read scenarios and the
    // other ports. Scalars/temporal/Guid pass straight through to Normalization.
    private static object? WireValue(object? value)
    {
        if (value is null) return null;
        var t = value.GetType();
        if (t.IsPrimitive || value is string or decimal or DateTime or DateOnly or TimeOnly or Guid or Enum)
            return value;
        // A nested owned POCO → field-keyed JSON string (Normalization sorts the keys).
        return PocoToJsonNode(value).ToJsonString();
    }

    private static JsonNode PocoToJsonNode(object poco)
    {
        var obj = new JsonObject();
        foreach (var prop in poco.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var key = char.ToLowerInvariant(prop.Name[0]) + prop.Name[1..];
            obj[key] = LeafToJsonNode(prop.GetValue(poco));
        }
        return obj;
    }

    private static JsonNode? LeafToJsonNode(object? v) => v switch
    {
        null => null,
        bool b => JsonValue.Create(b),
        string s => JsonValue.Create(s),
        int i => JsonValue.Create(i),
        long l => JsonValue.Create(l),
        double d => JsonValue.Create(d),
        decimal dec => JsonValue.Create(dec),
        Enum e => JsonValue.Create(e.ToString()),
        _ when v.GetType().IsClass => PocoToJsonNode(v),   // nested value object
        _ => JsonValue.Create(v.ToString()),
    };
}
