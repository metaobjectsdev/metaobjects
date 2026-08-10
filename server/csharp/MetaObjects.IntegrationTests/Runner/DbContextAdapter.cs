// DbContextAdapter — translates a QuerySpec (metadata-anchored DSL) into a LINQ
// expression against the generated AppDbContext + DbSets.
//
// The adapter is generic over entity type, but the entrypoint takes the entity's
// *metadata name* (Program, ProgramStat, …) and resolves to the right DbSet via
// reflection on the DbContext (the generated DbSet property pluralizes the name).
//
// The DSL is small enough that hand-built Expression trees stay readable; no
// Dynamic LINQ dependency.

using System.Linq.Expressions;
using System.Reflection;
using MetaObjects.IntegrationTests.Generated;
using Microsoft.EntityFrameworkCore;
using YamlDotNet.RepresentationModel;

namespace MetaObjects.IntegrationTests.Runner;

public static class DbContextAdapter
{
    /// <summary>
    /// Execute a query intent against the DbContext. Returns:
    ///   * op=list  → a List of rows (each row = property-name→value dictionary).
    ///   * op=get   → a single row dictionary or null.
    ///   * op=count → a long.
    /// </summary>
    public static async Task<object?> ExecuteAsync(AppDbContext db, QuerySpec spec)
    {
        var entityType = ResolveEntityType(spec.Entity);
        return await (Task<object?>)typeof(DbContextAdapter)
            .GetMethod(nameof(ExecuteGeneric), BindingFlags.NonPublic | BindingFlags.Static)!
            .MakeGenericMethod(entityType)
            .Invoke(null, [db, spec])!;
    }

    private static async Task<object?> ExecuteGeneric<T>(AppDbContext db, QuerySpec spec) where T : class
    {
        // FR-017 TPH-aware writes. db.Set<T>() for a TPH SUBTYPE is automatically scoped
        // to that subtype's discriminator value (EF filters the single table), so a
        // create injects the discriminator via the CLR type, and a get/update on a
        // cross-subtype row is invisible (not found → the cross-subtype guard).
        if (spec.Op == "create")
            return await ExecuteCreate<T>(db, spec);
        if (spec.Op == "update")
            return await ExecuteUpdate<T>(db, spec);
        if (spec.Op == "delete")
            return await ExecuteDelete<T>(db, spec);

        var queryable = (IQueryable<T>)db.Set<T>().AsNoTracking();

        // For op:get, filter is implied by `by`.
        if (spec.Op == "get")
        {
            if (spec.By is null || spec.By.Count == 0)
                throw new InvalidOperationException("op:get requires a `by` block");
            queryable = ApplyFilter(queryable, ToFilterFromBy(spec.By));
            var single = await queryable.FirstOrDefaultAsync();
            return single is null ? null : RowFor(single);
        }

        if (spec.Filter is not null) queryable = ApplyFilter(queryable, spec.Filter);
        if (spec.Sort is { Count: > 0 } sorts) queryable = ApplySort(queryable, sorts);
        if (spec.Offset is { } off) queryable = queryable.Skip(off);
        if (spec.Limit is { } lim) queryable = queryable.Take(lim);

        if (spec.Op == "count")
            return (long)await queryable.CountAsync();

        // op: list
        var rows = await queryable.ToListAsync();
        return rows.Select(RowFor).ToList();
    }

    // op: create — construct a fresh entity, write only the supplied `data` fields, and
    // SaveChanges. The discriminator is NEVER supplied by the caller; EF injects it from
    // the CLR type (TPH). Returns the materialized row (server-assigned id + discriminator).
    private static async Task<object?> ExecuteCreate<T>(AppDbContext db, QuerySpec spec) where T : class
    {
        var data = DataMapping(spec, "create");
        var entity = Activator.CreateInstance<T>();
        foreach (var (keyNode, valueNode) in data.Children)
        {
            var field = ((YamlScalarNode)keyNode).Value!;
            // The shared WRITE coercion (same path op:roundtrip uses): scalar style is
            // preserved, so a quoted full-int64/decimal/uuid stays a string until parsed,
            // a temporal string carries its Kind, a nested object → an owned jsonb POCO.
            // A data field not on this subtype is an authoring error (Property throws).
            var prop = WriteCoercion.Property(typeof(T), field);
            prop.SetValue(entity, WriteCoercion.CoerceToProperty(valueNode, prop.PropertyType, prop));
        }
        db.Set<T>().Add(entity);
        await db.SaveChangesAsync();
        // Re-read fresh so the discriminator EF injected (and any DB defaults) are present.
        db.ChangeTracker.Clear();
        return RowFor(entity);
    }

    // op: update — fetch the entity SCOPED to its subtype (db.Set<T>() filters by the
    // discriminator), apply only the supplied `data` fields, SaveChanges. Two cross-subtype
    // writes MUST throw (mirroring the per-subtype route's 404 / column rejection):
    //   (a) a `data` field that is not a property of this subtype → Property(...) throws;
    //   (b) a `by` id that belongs to a different subtype → not found → throw.
    // The discriminator is immutable: it is not a writable `data` field.
    private static async Task<object?> ExecuteUpdate<T>(AppDbContext db, QuerySpec spec) where T : class
    {
        if (spec.By is null || spec.By.Count == 0)
            throw new InvalidOperationException($"op:update '{spec.Name}' requires a `by` block");
        var data = DataMapping(spec, "update");

        // (a) Resolve + coerce every data property FIRST — a cross-subtype column (not a
        // property of this subtype) throws here before any DB hit, matching the runtime
        // rejection. The shared WRITE coercion is the SAME path op:roundtrip uses, so a
        // port whose UPDATE codec diverged from its INSERT codec is caught: full-int64
        // strings, decimals, uuids, temporal Kind, enums, and the nested jsonb POCO are
        // all re-encoded identically to insert.
        var assignments = data.Children
            .Select(kv => (Node: ((YamlScalarNode)kv.Key).Value!, Value: kv.Value))
            .Select(kv =>
            {
                var prop = WriteCoercion.Property(typeof(T), kv.Node);
                return (Prop: prop, Coerced: WriteCoercion.CoerceToProperty(kv.Value, prop.PropertyType, prop));
            })
            .ToList();

        // (b) Subtype-scoped fetch — a different-subtype id is invisible → not found.
        var queryable = ApplyFilter((IQueryable<T>)db.Set<T>(), ToFilterFromBy(spec.By));
        var entity = await queryable.FirstOrDefaultAsync()
            ?? throw new InvalidOperationException(
                $"op:update '{spec.Name}': no {typeof(T).Name} matches {string.Join(", ", spec.By.Select(b => $"{b.Key}={b.Value}"))} " +
                "(cross-subtype id is invisible to the subtype scope)");

        foreach (var (prop, coerced) in assignments)
            prop.SetValue(entity, coerced);
        await db.SaveChangesAsync();

        // GENUINE read-back: clear the tracker and re-SELECT by the same key so the
        // returned row exercises the DB READ codec (enum text→enum, jsonb text→POCO,
        // timestamptz→UTC, NUMERIC rounding) — NOT the in-memory instance EF's identity
        // map would otherwise echo. Without this the result would just mirror the values
        // we wrote, hiding any UPDATE write/read codec defect (the SP-H roundtrip lesson).
        db.ChangeTracker.Clear();
        var readBack = await ApplyFilter((IQueryable<T>)db.Set<T>().AsNoTracking(), ToFilterFromBy(spec.By))
            .FirstOrDefaultAsync();
        // Project via the shared EntityRow (handles the owned-POCO jsonb field), the
        // SAME wire projection op:roundtrip uses — so an UPDATE re-encode of the jsonb
        // object (and every scalar subtype) is asserted identically to insert.
        return readBack is null ? null : EntityRow.Of(readBack);
    }

    // op: delete — remove the row identified by `by` (the PK) through the EF runtime
    // write path. Returns a boolean: true = a row was deleted, false = no matching row
    // (the `expect:` is that boolean). Subtype-scoped like update — a cross-subtype id
    // is invisible (returns false). A follow-up op:get by the same PK (expect: null) is
    // the portable proof the row is actually gone.
    private static async Task<object?> ExecuteDelete<T>(AppDbContext db, QuerySpec spec) where T : class
    {
        if (spec.By is null || spec.By.Count == 0)
            throw new InvalidOperationException($"op:delete '{spec.Name}' requires a `by` block");

        var entity = await ApplyFilter((IQueryable<T>)db.Set<T>(), ToFilterFromBy(spec.By))
            .FirstOrDefaultAsync();
        if (entity is null) return false;

        db.Set<T>().Remove(entity);
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
        return true;
    }

    // The op:create / op:update `data` block as a YAML mapping (scalar style preserved
    // so the shared WRITE coercion can honor the authoring forms).
    private static YamlMappingNode DataMapping(QuerySpec spec, string op) =>
        spec.Data as YamlMappingNode
        ?? throw new InvalidOperationException($"op:{op} '{spec.Name}' requires a `data` mapping (the field values to write)");

    // -----------------------------------------------------------------------
    // Entity / property resolution
    // -----------------------------------------------------------------------

    private static Type ResolveEntityType(string metadataName)
    {
        // The generated entity class is in MetaObjects.IntegrationTests.Generated
        // with the same Pascal-case name as the metadata entity.
        var t = typeof(AppDbContext).Assembly.GetType(
            $"MetaObjects.IntegrationTests.Generated.{metadataName}",
            throwOnError: false);
        return t ?? throw new InvalidOperationException(
            $"Generated entity type for metadata name '{metadataName}' not found");
    }

    // The C# property name is Pascal-cased from the metadata field name; both happen
    // to be identical in the canonical model since fields are already lowerCamel and
    // CSharpNaming.Pascal capitalizes the first letter.
    private static PropertyInfo Property(Type entity, string fieldName) =>
        entity.GetProperty(char.ToUpperInvariant(fieldName[0]) + fieldName[1..])
            ?? throw new InvalidOperationException(
                $"Entity '{entity.Name}' has no property for metadata field '{fieldName}'");

    // -----------------------------------------------------------------------
    // Filter / sort → Expression
    // -----------------------------------------------------------------------

    private static IReadOnlyDictionary<string, object?> ToFilterFromBy(IReadOnlyDictionary<string, object?> by) =>
        by.ToDictionary(
            kv => kv.Key,
            kv => (object?)new Dictionary<string, object?> { ["eq"] = kv.Value });

    private static IQueryable<T> ApplyFilter<T>(IQueryable<T> queryable, IReadOnlyDictionary<string, object?> filter)
    {
        var param = Expression.Parameter(typeof(T), "x");
        var body = BuildFilterBody(typeof(T), param, filter);
        if (body is null) return queryable;
        var lambda = Expression.Lambda<Func<T, bool>>(body, param);
        return queryable.Where(lambda);
    }

    // Accepts either an IReadOnlyDictionary (the top-level Filter shape) or an
    // IDictionary (what AsStringKeyedDict returns for nested `and` children).
    private static Expression? BuildFilterBody(
        Type entityType, ParameterExpression param, IEnumerable<KeyValuePair<string, object?>> filterEntries)
    {
        var filter = filterEntries.ToDictionary(kv => kv.Key, kv => kv.Value);
        // Top-level `and: [filter, filter, ...]` composes child filters with AndAlso.
        // Compose-by-AND is the only logical combinator today; `or` would need both
        // runtime-ts compileFilter AND this adapter to grow it first.
        if (filter.TryGetValue("and", out var andValue) && andValue is System.Collections.IEnumerable list)
        {
            Expression? combined = null;
            foreach (var child in list)
            {
                var childDict = AsStringKeyedDict(child)
                    ?? throw new InvalidOperationException(
                        "`and` list elements must be filter objects (got " +
                        $"{child?.GetType().Name ?? "null"})");
                var childExpr = BuildFilterBody(entityType, param, childDict);
                if (childExpr is null) continue;
                combined = combined is null ? childExpr : Expression.AndAlso(combined, childExpr);
            }
            return combined;
        }

        Expression? body = null;
        foreach (var (field, opsRaw) in filter)
        {
            var prop = Property(entityType, field);
            var propExpr = Expression.Property(param, prop);
            // YamlDotNet hands back Dictionary<object, object?> for nested mappings
            // when the parent is typed as object?; normalize both shapes here so the
            // DSL author doesn't have to think about it.
            var ops = AsStringKeyedDict(opsRaw)
                ?? throw new InvalidOperationException(
                    $"filter for field '{field}' must be an object of {{op:value}} (got {opsRaw?.GetType().Name ?? "null"})");
            foreach (var (op, value) in ops)
            {
                var clause = BuildOp(propExpr, op, value);
                body = body is null ? clause : Expression.AndAlso(body, clause);
            }
        }
        return body;
    }

    private static IDictionary<string, object?>? AsStringKeyedDict(object? raw) => raw switch
    {
        IDictionary<string, object?> sd => sd,
        IDictionary<object, object?> od => od.ToDictionary(kv => kv.Key.ToString()!, kv => kv.Value),
        _ => null,
    };

    private static Expression BuildOp(Expression propExpr, string op, object? rawValue)
    {
        // null/IsNull operators don't need value coercion (other than the bool flag).
        // YamlDotNet deserializes a YAML bool into a `string` when the target is
        // `object?`, so accept both shapes here.
        if (op == "isNull")
        {
            var isNullExpr = Expression.Equal(propExpr, Expression.Constant(null, propExpr.Type));
            var wantNull = rawValue switch
            {
                bool b => b,
                string s when bool.TryParse(s, out var parsed) => parsed,
                _ => throw new InvalidOperationException(
                    $"filter op `isNull` requires a boolean value (got: {rawValue?.GetType().Name ?? "null"})"),
            };
            return wantNull ? isNullExpr : Expression.Not(isNullExpr);
        }

        // `in` takes a list of values.
        if (op == "in")
        {
            if (rawValue is not System.Collections.IEnumerable list)
                throw new InvalidOperationException("filter op `in` requires a list value");
            var coerced = list.Cast<object?>().Select(v => CoerceValue(v, propExpr.Type)).ToArray();
            var arrayType = propExpr.Type.MakeArrayType();
            var arrayExpr = Expression.Constant(ToTypedArray(coerced, propExpr.Type), arrayType);
            var containsMethod = typeof(System.Linq.Enumerable).GetMethods()
                .First(m => m.Name == "Contains" && m.GetParameters().Length == 2)
                .MakeGenericMethod(propExpr.Type);
            return Expression.Call(containsMethod, arrayExpr, propExpr);
        }

        // `like` uses EF.Functions.Like (translated to SQL LIKE) — the SAME
        // dispatch the PRODUCT ships (EfCoreFilterDispatch). This adapter
        // previously preferred Npgsql's ILike via reflection, so the
        // conformance gate was testing case-INSENSITIVE semantics the product
        // never had; the cross-port contract's `like` is case-sensitive SQL
        // LIKE (ADR-0047) and the de-blinded filter-like-and-ne fixture now
        // fails an ILike dispatch.
        if (op == "like")
        {
            var likeMethod = typeof(DbFunctionsExtensions)
                .GetMethod(nameof(DbFunctionsExtensions.Like), [typeof(DbFunctions), typeof(string), typeof(string)])!;
            var functions = Expression.Constant(EF.Functions);
            return Expression.Call(likeMethod, functions, propExpr, Expression.Constant((string)rawValue!));
        }

        // Scalar comparison ops.
        var value = Expression.Constant(CoerceValue(rawValue, propExpr.Type), propExpr.Type);
        return op switch
        {
            "eq"  => Expression.Equal(propExpr, value),
            "ne"  => Expression.NotEqual(propExpr, value),
            "gt"  => Expression.GreaterThan(propExpr, value),
            "gte" => Expression.GreaterThanOrEqual(propExpr, value),
            "lt"  => Expression.LessThan(propExpr, value),
            "lte" => Expression.LessThanOrEqual(propExpr, value),
            _ => throw new InvalidOperationException($"unsupported filter op '{op}'"),
        };
    }

    private static IQueryable<T> ApplySort<T>(IQueryable<T> queryable, IReadOnlyList<SortSpec> sorts)
    {
        IOrderedQueryable<T>? ordered = null;
        foreach (var sort in sorts)
        {
            var param = Expression.Parameter(typeof(T), "x");
            var propExpr = Expression.Property(param, Property(typeof(T), sort.Field));
            var lambda = Expression.Lambda(propExpr, param);
            var methodName = (ordered is null ? "OrderBy" : "ThenBy") + (sort.Dir == "desc" ? "Descending" : "");
            var method = typeof(Queryable).GetMethods()
                .First(m => m.Name == methodName && m.GetParameters().Length == 2)
                .MakeGenericMethod(typeof(T), propExpr.Type);
            ordered = (IOrderedQueryable<T>)method.Invoke(null, [ordered ?? queryable, lambda])!;
        }
        return ordered ?? queryable;
    }

    // -----------------------------------------------------------------------
    // Value coercion + row extraction
    // -----------------------------------------------------------------------

    // YAML → .NET coercion. YamlDotNet defaults numerics to long, but our entity
    // properties may be int, long, decimal, or an enum (e.g. ProgramStatus).
    private static object? CoerceValue(object? raw, Type targetType)
    {
        if (raw is null) return null;
        var underlying = Nullable.GetUnderlyingType(targetType) ?? targetType;
        if (underlying.IsEnum)
            return Enum.Parse(underlying, raw.ToString()!, ignoreCase: false);
        if (underlying == raw.GetType()) return raw;
        // R6 Plan 2a — a field.uuid filter value arrives as a YAML string; coerce it
        // to System.Guid (the entity property type) for the LINQ comparison. Guid is
        // not IConvertible, so Convert.ChangeType cannot handle it.
        if (underlying == typeof(Guid))
            return Guid.Parse(raw.ToString()!);
        return Convert.ChangeType(raw, underlying, System.Globalization.CultureInfo.InvariantCulture);
    }

    private static Array ToTypedArray(object?[] values, Type elementType)
    {
        var arr = Array.CreateInstance(elementType, values.Length);
        for (int i = 0; i < values.Length; i++) arr.SetValue(values[i], i);
        return arr;
    }

    // Project the materialized entity to the lowerCamel-keyed wire row via the shared
    // EntityRow. Pass the DECLARED type T (not the runtime type) so a TPH polymorphic
    // read of a subtype row projects only the base's columns — the wire contract the
    // list scenarios assert. EntityRow also serializes an owned-POCO jsonb field to its
    // field-keyed JSON string (so an AllTypes op:get re-reads `settings` as an object,
    // not the POCO's ToString()).
    private static IReadOnlyDictionary<string, object?> RowFor<T>(T entity) =>
        EntityRow.Of(entity!, typeof(T));
}
