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

namespace MetaObjects.Codegen.Runtime;

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
        IReadOnlyList<FilterPredicate> predicates) where T : class
    {
        if (predicates is null || predicates.Count == 0) return source;
        foreach (var p in predicates)
        {
            var lambda = BuildLambda<T>(p);
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
    /// (<see cref="DecimalWire.TryParse"/>) and compared exactly, never through a double.
    /// A failed parse result is returned unchanged.
    /// </summary>
    public static FilterParseResult Validate<T>(FilterParseResult parsed)
    {
        if (parsed.ErrorEnvelope is not null) return parsed;
        foreach (var p in parsed.Predicates)
        {
            if (p.Op is "isNull" or "like") continue;
            var prop = ResolveProperty(typeof(T), p.Field);
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
    private static Expression<Func<T, bool>> BuildLambda<T>(FilterPredicate p)
    {
        var x = Expression.Parameter(typeof(T), "x");
        var prop = ResolveProperty(typeof(T), p.Field);
        // The metadata field name must map to a CLR property — the allowlist gate
        // upstream guarantees the field exists on the entity, so a miss here is a
        // generator/runtime contract violation, not user input.
        if (prop is null)
            throw new InvalidOperationException(
                $"filter field \"{p.Field}\" has no matching property on {typeof(T).Name}");

        Expression member = Expression.Property(x, prop);
        // The non-nullable underlying type the raw string coerces to.
        var memberType = prop.PropertyType;
        var underlying = Nullable.GetUnderlyingType(memberType) ?? memberType;

        switch (p.Op)
        {
            case "isNull":
            {
                // x.Property == null (or != null). Boxing to object keeps the
                // null comparison translatable for both value- and ref-typed
                // members.
                var asObj = Expression.Convert(member, typeof(object));
                var nullConst = Expression.Constant(null, typeof(object));
                Expression body = (p.Value is true)
                    ? Expression.Equal(asObj, nullConst)
                    : Expression.NotEqual(asObj, nullConst);
                return Expression.Lambda<Func<T, bool>>(body, x);
            }

            case "in":
            {
                var items = (IReadOnlyList<string>)p.Value!;
                if (items.Count == 0)
                    return Expression.Lambda<Func<T, bool>>(Expression.Constant(false), x);

                // Build a typed List<TMember> and call list.Contains(x.Property),
                // which EF translates to SQL `IN (...)`.
                var listType = typeof(List<>).MakeGenericType(memberType);
                var typedList = (IList)Activator.CreateInstance(listType)!;
                foreach (var item in items) typedList.Add(CoerceTo(item, memberType, underlying));
                var containsMethod = listType.GetMethod("Contains", new[] { memberType })!;
                var listConst = Expression.Constant(typedList, listType);
                var call = Expression.Call(listConst, containsMethod, member);
                return Expression.Lambda<Func<T, bool>>(call, x);
            }

            case "like":
            {
                // EF.Functions.Like(x.Property, pattern) — member must be string.
                var memberStr = (underlying == typeof(string))
                    ? member
                    : Expression.Call(member, typeof(object).GetMethod(nameof(object.ToString))!);
                var pattern = Expression.Constant((string)(p.Value ?? ""), typeof(string));
                var efFunctions = Expression.Property(null, typeof(EF).GetProperty(nameof(EF.Functions))!);
                var likeMethod = typeof(DbFunctionsExtensions).GetMethod(
                    nameof(DbFunctionsExtensions.Like),
                    new[] { typeof(DbFunctions), typeof(string), typeof(string) })!;
                var call = Expression.Call(likeMethod, efFunctions, memberStr, pattern);
                return Expression.Lambda<Func<T, bool>>(call, x);
            }

            default:
            {
                // eq / ne / gt / gte / lt / lte — typed comparison against the
                // coerced constant. EF translates each to the SQL operator.
                var value = CoerceTo((string)(p.Value ?? ""), memberType, underlying);
                var constant = Expression.Constant(value, memberType);
                Expression body = p.Op switch
                {
                    "eq"  => Expression.Equal(member, constant),
                    "ne"  => Expression.NotEqual(member, constant),
                    "gt"  => Expression.GreaterThan(member, constant),
                    "gte" => Expression.GreaterThanOrEqual(member, constant),
                    "lt"  => Expression.LessThan(member, constant),
                    "lte" => Expression.LessThanOrEqual(member, constant),
                    _ => throw new InvalidOperationException("unknown filter op: " + p.Op),
                };
                return Expression.Lambda<Func<T, bool>>(body, x);
            }
        }
    }

    /// <summary>
    /// Resolve the CLR property on <paramref name="entityType"/> matching the
    /// metadata field name. The metadata name is camelCase (e.g. "createdAt") and
    /// the property is PascalCase ("CreatedAt"); match case-insensitively.
    /// </summary>
    private static PropertyInfo? ResolveProperty(Type entityType, string fieldName) =>
        entityType.GetProperty(fieldName,
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
        if (underlying == typeof(DateTime))
            return DateTime.Parse(raw, CultureInfo.InvariantCulture, DateTimeStyles.None);
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
        return Convert.ChangeType(raw, underlying, CultureInfo.InvariantCulture);
    }
}
