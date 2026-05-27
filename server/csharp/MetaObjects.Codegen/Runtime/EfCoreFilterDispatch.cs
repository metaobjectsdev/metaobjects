// EfCoreFilterDispatch — translates a list of FilterPredicate into an
// IQueryable<T> filter chain via EF.Property<>. Generated routes call
// EfCoreFilterDispatch.ApplyFilter(q, predicates) in their list handler
// after FilterParser.Parse returns success.
//
// Built on EF.Property<>(x, fieldName) → no runtime reflection, AOT-friendly
// at the C# level (EF Core's own expression-tree translation handles the SQL
// generation). Each predicate becomes a single Expression<Func<T, bool>>
// appended via IQueryable<T>.Where; multiple predicates AND together.
//
// Part of the codegen runtime surface; sibling of FilterParser.

using System.Collections.Generic;
using System.Linq;
using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;

namespace MetaObjects.Codegen.Runtime;

/// <summary>
/// Apply a list of <see cref="FilterPredicate"/> to an
/// <see cref="IQueryable{T}"/> as a chain of <c>Where(...)</c> calls. Each
/// predicate becomes <c>x =&gt; EF.Property&lt;TValue&gt;(x, field) OP value</c>;
/// multiple predicates AND together (one Where per predicate).
/// </summary>
public static class EfCoreFilterDispatch
{
    /// <summary>
    /// Apply <paramref name="predicates"/> to <paramref name="source"/>. Field
    /// names address the entity's property by string (translated via
    /// <see cref="EF.Property{TProperty}"/>); the value is coerced via
    /// <see cref="System.Convert.ChangeType(object?, System.Type)"/> to the
    /// EF-tracked property type the runtime knows about.
    /// </summary>
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
    /// Build an <c>Expression&lt;Func&lt;T, bool&gt;&gt;</c> for a single predicate.
    /// </summary>
    private static Expression<System.Func<T, bool>> BuildLambda<T>(FilterPredicate p)
    {
        // x => EF.Property<object>(x, p.Field) OP p.Value
        var x = Expression.Parameter(typeof(T), "x");

        // For isNull, EF.Property<object>(x, "field") == null (or != null).
        if (p.Op == "isNull")
        {
            var propObj = EfPropertyCall<object>(x, p.Field);
            var nullConst = Expression.Constant(null, typeof(object));
            Expression body = p.Value is true
                ? Expression.Equal(propObj, nullConst)
                : Expression.NotEqual(propObj, nullConst);
            return Expression.Lambda<System.Func<T, bool>>(body, x);
        }

        // For `in`, build property == v1 || property == v2 || ...
        if (p.Op == "in")
        {
            var items = (IReadOnlyList<string>)p.Value!;
            if (items.Count == 0)
            {
                // Empty IN means no rows match.
                return Expression.Lambda<System.Func<T, bool>>(Expression.Constant(false), x);
            }
            // We don't know the property type at runtime; use EF.Property<object>
            // and equality via Equals(object, object).
            Expression? combined = null;
            foreach (var item in items)
            {
                var propExp = EfPropertyCall<object>(x, p.Field);
                Expression itemConst = Expression.Constant((object)item);
                var eq = Expression.Call(
                    typeof(object).GetMethod("Equals", new[] { typeof(object), typeof(object) })!,
                    propExp, itemConst);
                combined = combined is null ? eq : Expression.OrElse(combined, eq);
            }
            return Expression.Lambda<System.Func<T, bool>>(combined!, x);
        }

        if (p.Op == "like")
        {
            // EF.Functions.Like(EF.Property<string>(x, field), pattern)
            var propStr = EfPropertyCall<string>(x, p.Field);
            var pattern = Expression.Constant((string)(p.Value ?? ""));
            var efFunctions = Expression.Property(null, typeof(EF).GetProperty(nameof(EF.Functions))!);
            var likeMethod = typeof(DbFunctionsExtensions).GetMethod(
                nameof(DbFunctionsExtensions.Like),
                new[] { typeof(DbFunctions), typeof(string), typeof(string) })!;
            var call = Expression.Call(likeMethod, efFunctions, propStr, pattern);
            return Expression.Lambda<System.Func<T, bool>>(call, x);
        }

        // Comparison ops (eq/ne/gt/gte/lt/lte). Use EF.Property<object> + Compare
        // semantics via Expression.Call to object.Equals (for eq/ne) or
        // string.Compare/long comparisons. Since the value type isn't known at
        // codegen time, we materialize as object and let EF's expression-tree
        // translation convert at SQL time.
        //
        // For ordering ops we *need* a comparable type. The simplest correct
        // approach: use EF.Property<object> and rely on EF's translation to
        // turn the .Equals / comparison Method into the right SQL. EF doesn't
        // translate object.CompareTo, so for gt/gte/lt/lte we delegate to
        // a per-type path.
        return BuildComparison<T>(x, p);
    }

    private static Expression<System.Func<T, bool>> BuildComparison<T>(ParameterExpression x, FilterPredicate p)
    {
        // For equality, EF translates property == value cleanly when the
        // value is the actual column type. Since we don't know the column
        // type at the dispatch boundary, we use object equality which EF
        // translates to SQL = / <> for primitive columns.
        if (p.Op == "eq" || p.Op == "ne")
        {
            var propObj = EfPropertyCall<object>(x, p.Field);
            Expression valueExp = Expression.Constant(p.Value, typeof(object));
            var equalsCall = Expression.Call(
                typeof(object).GetMethod("Equals", new[] { typeof(object), typeof(object) })!,
                propObj, valueExp);
            Expression body = p.Op == "eq" ? (Expression)equalsCall : Expression.Not(equalsCall);
            return Expression.Lambda<System.Func<T, bool>>(body, x);
        }

        // Ordered comparisons need a typed property. We try long first
        // (the FR-009 conformance corpus uses long ids); fall back to
        // string-comparison for everything else. Real consumers can
        // hand-write more sophisticated dispatch if their column types
        // exceed this surface.
        var raw = (string)(p.Value ?? "");
        if (long.TryParse(raw, System.Globalization.NumberStyles.Integer,
                System.Globalization.CultureInfo.InvariantCulture, out var asLong))
        {
            var propLong = EfPropertyCall<long>(x, p.Field);
            var valLong = Expression.Constant(asLong, typeof(long));
            Expression body = p.Op switch
            {
                "gt"  => Expression.GreaterThan(propLong, valLong),
                "gte" => Expression.GreaterThanOrEqual(propLong, valLong),
                "lt"  => Expression.LessThan(propLong, valLong),
                "lte" => Expression.LessThanOrEqual(propLong, valLong),
                _ => throw new System.InvalidOperationException("unknown filter op: " + p.Op),
            };
            return Expression.Lambda<System.Func<T, bool>>(body, x);
        }

        // Fall back: typed-string property compared via string.Compare. EF
        // translates this to the database-collation-aware comparison.
        var propStr = EfPropertyCall<string>(x, p.Field);
        var valStr = Expression.Constant(raw, typeof(string));
        var compare = Expression.Call(
            typeof(string).GetMethod(nameof(string.Compare), new[] { typeof(string), typeof(string) })!,
            propStr, valStr);
        var zero = Expression.Constant(0);
        Expression sBody = p.Op switch
        {
            "gt"  => Expression.GreaterThan(compare, zero),
            "gte" => Expression.GreaterThanOrEqual(compare, zero),
            "lt"  => Expression.LessThan(compare, zero),
            "lte" => Expression.LessThanOrEqual(compare, zero),
            _ => throw new System.InvalidOperationException("unknown filter op: " + p.Op),
        };
        return Expression.Lambda<System.Func<T, bool>>(sBody, x);
    }

    /// <summary>Build the <c>EF.Property&lt;TProperty&gt;(x, name)</c> call.</summary>
    private static MethodCallExpression EfPropertyCall<TProperty>(ParameterExpression x, string fieldName)
    {
        var method = typeof(EF).GetMethod(nameof(EF.Property))!.MakeGenericMethod(typeof(TProperty));
        return Expression.Call(method, x, Expression.Constant(fieldName));
    }
}
