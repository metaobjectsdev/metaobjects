// EfCoreFilterDispatch — translates a list of FilterPredicate into an
// IQueryable<T> filter chain. Generated routes call
// EfCoreFilterDispatch.ApplyFilter(q, predicates) in their list handler after
// FilterParser.Parse returns success.
//
// Each predicate becomes a single Expression<Func<T, bool>> appended via
// IQueryable<T>.Where; multiple predicates AND together.
//
// Translation strategy — the predicate field name is the METADATA field name
// (e.g. "createdAt"), which maps to the entity's PascalCase CLR property
// ("CreatedAt"). We resolve that property on typeof(T) (case-insensitive) and
// build a STRONGLY-TYPED member-access expression (Expression.Property), with
// the raw URL string coerced to the property's CLR type. EF Core translates a
// typed `x.Property OP typedConstant` to SQL directly; an `EF.Property<object>`
// boxed comparison does NOT translate (it throws at query time against a real
// provider), so this dispatcher must use the typed member access.
//
// Part of the codegen runtime surface; sibling of FilterParser.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using Microsoft.EntityFrameworkCore;

namespace MetaObjects.AspNetCore;

/// <summary>
/// Apply a list of <see cref="FilterPredicate"/> to an
/// <see cref="IQueryable{T}"/> as a chain of <c>Where(...)</c> calls. Each
/// predicate becomes a strongly-typed <c>x =&gt; x.Property OP value</c>;
/// multiple predicates AND together (one Where per predicate).
/// </summary>
public static class EfCoreFilterDispatch
{
    public static IQueryable<T> ApplyFilter<T>(
        IQueryable<T> source,
        IReadOnlyList<FilterPredicate> predicates,
        IReadOnlyDictionary<string, string>? propertyByField = null) where T : class
    {
        if (predicates is null || predicates.Count == 0) return source;
        foreach (var p in predicates)
        {
            var lambda = BuildLambda<T>(p, propertyByField);
            source = source.Where(lambda);
        }
        return source;
    }

    /// <summary>
    /// Check every operand of a successfully parsed filter against the CLR type of its
    /// property, so a malformed operand is the contract's <c>400 invalid_filter_value</c>
    /// (naming the field) instead of an exception out of <see cref="ApplyFilter{T}"/>.
    /// <see cref="FilterParser"/> is substrate-agnostic and cannot know a column's type; this
    /// is the first place that does. A decimal operand is parsed with the wire grammar
    /// (<see cref="DecimalWire.TryParse"/>) and compared exactly, never through a double; a
    /// duration operand with the duration wire grammar (<see cref="DurationWire.TryParse"/>).
    /// A failed parse result is returned unchanged.
    /// </summary>
    public static FilterParseResult Validate<T>(FilterParseResult parsed, IReadOnlyDictionary<string, string>? propertyByField = null)
    {
        if (parsed.ErrorEnvelope is not null) return parsed;
        foreach (var p in parsed.Predicates)
        {
            if (p.Op is "isNull" or "like") continue;
            var prop = ResolveProperty(typeof(T), p.Field, propertyByField);
            if (prop is null) continue; // the allowlist gate upstream guarantees a match; BuildLambda reports a miss
            var memberType = prop.PropertyType;
            var underlying = Nullable.GetUnderlyingType(memberType) ?? memberType;
            try
            {
                if (p.Op == "in")
                    foreach (var item in (IReadOnlyList<string>)p.Value!) CoerceTo(item, memberType, underlying);
                else
                    CoerceTo((string)(p.Value ?? ""), memberType, underlying);
            }
            catch (Exception ex) when (ex is FormatException or InvalidCastException or OverflowException or ArgumentException)
            {
                return FilterParseResult.Err("invalid_filter_value", p.Field);
            }
        }
        return parsed;
    }

    /// <summary>
    /// Build an <c>Expression&lt;Func&lt;T, bool&gt;&gt;</c> for a single predicate
    /// against the resolved CLR property of <typeparamref name="T"/>.
    /// </summary>
    private static Expression<Func<T, bool>> BuildLambda<T>(FilterPredicate p, IReadOnlyDictionary<string, string>? propertyByField)
    {
        var x = Expression.Parameter(typeof(T), "x");
        return Expression.Lambda<Func<T, bool>>(LeafBody(x, typeof(T), p.Field, p.Op, p.Value, propertyByField), x);
    }

    /// <summary>
    /// Apply a parsed list query's filter tree and search (<see cref="ListQueryParser"/>) to
    /// <paramref name="source"/>: and/or groups become <c>AndAlso</c>/<c>OrElse</c> in one
    /// <c>Where</c>, and the search one more <c>Where</c> ORing a case-insensitive pattern match over
    /// its fields. Sort and page are the caller's. Run <see cref="Validate{T}(ListQuery, IReadOnlyDictionary{string, string}?)"/>
    /// first, so an operand the column cannot hold is a 400 and not an exception here.
    /// </summary>
    public static IQueryable<T> Apply<T>(
        IQueryable<T> source,
        ListQuery query,
        IReadOnlyDictionary<string, FilterFieldRule> rules,
        IReadOnlyDictionary<string, string>? propertyByField = null) where T : class
    {
        var x = Expression.Parameter(typeof(T), "x");
        if (query.Filter is not null)
            source = source.Where(Expression.Lambda<Func<T, bool>>(NodeBody(x, typeof(T), query.Filter, propertyByField), x));
        if (query.Search is not null)
            source = source.Where(Expression.Lambda<Func<T, bool>>(SearchBody(x, typeof(T), query.Search, rules, propertyByField), x));
        return source;
    }

    /// <summary>
    /// Check every operand of a parsed list query against the CLR type of its property (a value
    /// out of an <c>int</c> column's range, an enum symbol the CLR enum does not carry). Null when
    /// every operand converts, else the <c>invalid_filter_value</c> refusal for the first that does not.
    /// </summary>
    public static ListQueryError? Validate<T>(ListQuery query, IReadOnlyDictionary<string, string>? propertyByField = null)
    {
        foreach (var leaf in Leaves(query.Filter))
        {
            if (leaf.Op is "isNull" or "like") continue;
            var prop = ResolveProperty(typeof(T), leaf.Field, propertyByField);
            if (prop is null) continue;
            var memberType = prop.PropertyType;
            var underlying = Nullable.GetUnderlyingType(memberType) ?? memberType;
            var operands = leaf.Value is IReadOnlyList<object> list ? list : new[] { leaf.Value };
            foreach (var operand in operands)
            {
                try
                {
                    CoerceTo(OperandText(operand), memberType, underlying);
                }
                catch (Exception ex) when (ex is FormatException or InvalidCastException or OverflowException or ArgumentException)
                {
                    var text = OperandText(operand);
                    return new ListQueryError("invalid_filter_value",
                        $"Field \"{leaf.Field}\" op \"{leaf.Op}\" requires a value of the field's type, got \"{text}\".",
                        new[]
                        {
                            new KeyValuePair<string, object?>("field", leaf.Field),
                            new KeyValuePair<string, object?>("op", leaf.Op),
                            new KeyValuePair<string, object?>("expected", "a value of the field's type"),
                        });
                }
            }
        }
        return null;
    }

    private static IEnumerable<FilterLeaf> Leaves(FilterNode? node) => node switch
    {
        null => Array.Empty<FilterLeaf>(),
        FilterLeaf leaf => new[] { leaf },
        FilterAnd and => and.Nodes.SelectMany(Leaves),
        FilterOr or => or.Nodes.SelectMany(Leaves),
        _ => throw new InvalidOperationException("unknown filter node: " + node.GetType().Name),
    };

    private static Expression NodeBody(ParameterExpression x, Type entityType, FilterNode node, IReadOnlyDictionary<string, string>? propertyByField) => node switch
    {
        FilterLeaf leaf => LeafBody(x, entityType, leaf.Field, leaf.Op, leaf.Value, propertyByField),
        FilterAnd and => and.Nodes.Select(n => NodeBody(x, entityType, n, propertyByField)).Aggregate(Expression.AndAlso),
        FilterOr or => or.Nodes.Select(n => NodeBody(x, entityType, n, propertyByField)).Aggregate(Expression.OrElse),
        _ => throw new InvalidOperationException("unknown filter node: " + node.GetType().Name),
    };

    // `?search` is case-INSENSITIVE (a search box, not the contract's case-sensitive `like`):
    // LOWER(column) LIKE LOWER('%term%') on a text column. The term is a like pattern, as in
    // TypeScript. An enum column is matched in memory against its declared members, and the
    // members that match become `column IN (...)`: a string-backed enum's stored text is its symbol.
    private static Expression SearchBody(ParameterExpression x, Type entityType, ListSearch search,
        IReadOnlyDictionary<string, FilterFieldRule> rules, IReadOnlyDictionary<string, string>? propertyByField)
    {
        var pattern = "%" + search.Term + "%";
        var parts = new List<Expression>();
        foreach (var field in search.Fields)
        {
            var prop = ResolveProperty(entityType, field, propertyByField)
                ?? throw new InvalidOperationException($"search field \"{field}\" has no matching property on {entityType.Name}");
            Expression member = Expression.Property(x, prop);
            var underlying = Nullable.GetUnderlyingType(prop.PropertyType) ?? prop.PropertyType;
            if (underlying.IsEnum)
            {
                var members = rules.TryGetValue(field, out var rule) && rule.EnumValues is { } declared ? declared : Enum.GetNames(underlying);
                var matched = members.Where(m => LikeMatches(m, pattern)).ToList();
                parts.Add(LeafBody(x, entityType, field, "in", matched.Cast<object>().ToList(), propertyByField));
                continue;
            }
            if (underlying != typeof(string)) member = Expression.Call(member, typeof(object).GetMethod(nameof(object.ToString))!);
            var lowered = Expression.Call(member, typeof(string).GetMethod(nameof(string.ToLower), Type.EmptyTypes)!);
            var call = Expression.Call(LikeMethod, EfFunctions, lowered, Expression.Constant(pattern.ToLowerInvariant(), typeof(string)));
            // A null column matches nothing (and is not dereferenced in memory).
            parts.Add(prop.PropertyType.IsValueType && Nullable.GetUnderlyingType(prop.PropertyType) is null
                ? call
                : Expression.AndAlso(Expression.NotEqual(Expression.Convert(Expression.Property(x, prop), typeof(object)), Expression.Constant(null)), call));
        }
        return parts.Count == 0 ? Expression.Constant(false) : parts.Aggregate(Expression.OrElse);
    }

    private static readonly MethodInfo LikeMethod = typeof(DbFunctionsExtensions).GetMethod(
        nameof(DbFunctionsExtensions.Like), new[] { typeof(DbFunctions), typeof(string), typeof(string) })!;

    private static readonly Expression EfFunctions = Expression.Property(null, typeof(EF).GetProperty(nameof(EF.Functions))!);

    // A SQL LIKE pattern (`%` any run, `_` one character) matched case-insensitively in memory.
    private static bool LikeMatches(string value, string pattern)
    {
        var re = new System.Text.StringBuilder("^");
        foreach (var ch in pattern)
            re.Append(ch switch { '%' => ".*", '_' => ".", _ => System.Text.RegularExpressions.Regex.Escape(ch.ToString()) });
        re.Append('$');
        return System.Text.RegularExpressions.Regex.IsMatch(value, re.ToString(),
            System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.Singleline | System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    }

    // A neutral operand (string, long, double, bool) as the text CoerceTo reads.
    private static string OperandText(object? value) => value switch
    {
        null => "",
        string s => s,
        bool b => b ? "true" : "false",
        double d => d.ToString("R", CultureInfo.InvariantCulture),
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => value.ToString() ?? "",
    };

    /// <summary>One condition on the resolved CLR property, as an expression over <paramref name="x"/>.</summary>
    private static Expression LeafBody(ParameterExpression x, Type entityType, string field, string op, object? value, IReadOnlyDictionary<string, string>? propertyByField)
    {
        var prop = ResolveProperty(entityType, field, propertyByField);
        // The metadata field name must map to a CLR property — the allowlist gate
        // upstream guarantees the field exists on the entity, so a miss here is a
        // generator/runtime contract violation, not user input.
        if (prop is null)
            throw new InvalidOperationException(
                $"filter field \"{field}\" has no matching property on {entityType.Name}");

        Expression member = Expression.Property(x, prop);
        // The non-nullable underlying type the raw string coerces to.
        var memberType = prop.PropertyType;
        var underlying = Nullable.GetUnderlyingType(memberType) ?? memberType;

        switch (op)
        {
            case "isNull":
            {
                // x.Property == null (or != null). Boxing to object keeps the
                // null comparison translatable for both value- and ref-typed
                // members.
                var asObj = Expression.Convert(member, typeof(object));
                var nullConst = Expression.Constant(null, typeof(object));
                return value is true ? Expression.Equal(asObj, nullConst) : Expression.NotEqual(asObj, nullConst);
            }

            case "in":
            {
                var items = ((IEnumerable)value!).Cast<object?>().ToList();
                if (items.Count == 0) return Expression.Constant(false);

                // Build a typed List<TMember> and call list.Contains(x.Property),
                // which EF translates to SQL `IN (...)`.
                var listType = typeof(List<>).MakeGenericType(memberType);
                var typedList = (IList)Activator.CreateInstance(listType)!;
                foreach (var item in items) typedList.Add(CoerceTo(OperandText(item), memberType, underlying));
                var containsMethod = listType.GetMethod("Contains", new[] { memberType })!;
                return Expression.Call(Expression.Constant(typedList, listType), containsMethod, member);
            }

            case "like":
            {
                // EF.Functions.Like(x.Property, pattern) — member must be string.
                var memberStr = (underlying == typeof(string))
                    ? member
                    : Expression.Call(member, typeof(object).GetMethod(nameof(object.ToString))!);
                var pattern = Expression.Constant(OperandText(value), typeof(string));
                return Expression.Call(LikeMethod, EfFunctions, memberStr, pattern);
            }

            default:
            {
                // eq / ne / gt / gte / lt / lte — typed comparison against the
                // coerced constant. EF translates each to the SQL operator.
                var constant = Expression.Constant(CoerceTo(OperandText(value), memberType, underlying), memberType);
                return op switch
                {
                    "eq"  => Expression.Equal(member, constant),
                    "ne"  => Expression.NotEqual(member, constant),
                    "gt"  => Expression.GreaterThan(member, constant),
                    "gte" => Expression.GreaterThanOrEqual(member, constant),
                    "lt"  => Expression.LessThan(member, constant),
                    "lte" => Expression.LessThanOrEqual(member, constant),
                    _ => throw new InvalidOperationException("unknown filter op: " + op),
                };
            }
        }
    }

    /// <summary>
    /// Resolve the CLR property on <paramref name="entityType"/> matching the
    /// metadata field name. The metadata name is camelCase (e.g. "createdAt") and
    /// the property is PascalCase ("CreatedAt"); match case-insensitively. When the generated
    /// allowlist carries a field-to-property map (a property-naming resolver renamed a property
    /// beyond case), the mapped property name is the one looked up.
    /// </summary>
    private static PropertyInfo? ResolveProperty(Type entityType, string fieldName, IReadOnlyDictionary<string, string>? propertyByField = null) =>
        entityType.GetProperty(propertyByField is not null && propertyByField.TryGetValue(fieldName, out var mapped) ? mapped : fieldName,
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);

    /// <summary>
    /// Coerce a raw URL string into <paramref name="targetType"/> (the property's
    /// CLR type), routing through the non-nullable <paramref name="underlying"/>
    /// for parsing. Temporal types parse invariant ISO-8601; everything else uses
    /// Convert.ChangeType. The result is boxed for use as an Expression constant.
    /// </summary>
    private static object? CoerceTo(string raw, Type targetType, Type underlying)
    {
        if (underlying == typeof(string)) return raw;
        if (underlying == typeof(Guid)) return Guid.Parse(raw);
        // A timestamp instant (DateTimeOffset, timestamptz) binds at offset zero; a @localTime wall
        // clock (DateTime, timestamp without time zone) binds with an unspecified kind, which is
        // what Npgsql requires of each. The list query parser has already spelled a zoned bound in UTC.
        if (underlying == typeof(DateTimeOffset))
            return DateTimeOffset.Parse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal).ToUniversalTime();
        if (underlying == typeof(DateTime))
            return DateTime.SpecifyKind(
                DateTime.Parse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal),
                DateTimeKind.Unspecified);
        if (underlying == typeof(DateOnly))
            return DateOnly.Parse(raw, CultureInfo.InvariantCulture);
        if (underlying == typeof(TimeOnly))
            return TimeOnly.Parse(raw, CultureInfo.InvariantCulture);
        if (underlying.IsEnum) return Enum.Parse(underlying, raw, ignoreCase: false);
        if (underlying == typeof(bool)) return bool.Parse(raw);
        // ADR-0019 Amendment 1 (W2): a decimal operand is the JSON-number grammar, parsed
        // exactly. Convert.ChangeType accepted surrounding whitespace, thousands separators
        // and a leading '+', and rounded past 28-29 digits.
        if (underlying == typeof(decimal))
            return DecimalWire.TryParse(raw, out var exact)
                ? exact
                : throw new FormatException("not a decimal: " + raw);
        // field.duration: an operand is an ISO-8601 duration in the accepted form (no years or
        // months), compared as a span: `PT90M` equals a stored `PT1H30M`. EF binds it as
        // an interval on Postgres and through the property's microsecond-count converter elsewhere.
        if (underlying == typeof(TimeSpan))
            return DurationWire.TryParse(raw, out var span)
                ? span
                : throw new FormatException("not an ISO-8601 duration: " + raw);
        return Convert.ChangeType(raw, underlying, CultureInfo.InvariantCulture);
    }
}
