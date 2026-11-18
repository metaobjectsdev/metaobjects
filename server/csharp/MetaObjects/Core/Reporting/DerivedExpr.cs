// FR-044 R13 — the @expr grammar of a measure.derived: FR-037 R5's first arithmetic wave.
//
// Ported from server/typescript/packages/metadata/src/core/reporting/derived-expr.ts. A closed
// subset of the attr.expression node grammar: an operand is { field: name } or { value: number };
// an operation is { fn: add | subtract | multiply | divide, args: [a, b] }. origin.computed's
// grammar (ExpressionGrammar) does not take the arithmetic members yet.

namespace MetaObjects.Core.Reporting;

/// <summary>The <c>measure.derived</c> <c>@expr</c> grammar.</summary>
public static class DerivedExpr
{
    private const string KEY_FIELD = "field";
    private const string KEY_VALUE = "value";
    private const string KEY_FN = "fn";
    private const string KEY_ARGS = "args";

    /// <summary>True for a node of the grammar, its whole subtree included.</summary>
    public static bool IsDerivedExpr(object? node)
    {
        if (node is not IReadOnlyDictionary<string, object?> n) return false;
        if (n.Count == 1 && n.TryGetValue(KEY_FIELD, out var field)) return field is string { Length: > 0 };
        if (n.Count == 1 && n.TryGetValue(KEY_VALUE, out var value)) return IsFiniteNumber(value);
        if (n.Count == 2 && n.TryGetValue(KEY_FN, out var fn) && n.TryGetValue(KEY_ARGS, out var args))
        {
            return fn is string f && ReportingConstants.DERIVED_FNS.Contains(f) &&
                   args is IEnumerable<object?> list && list.Count() == 2 && list.All(IsDerivedExpr);
        }
        return false;
    }

    /// <summary>The names a well-formed expression's <c>{ field }</c> operands read, each once, in first-read order.</summary>
    public static IReadOnlyList<string> Fields(object? node)
    {
        var out_ = new List<string>();
        Collect(node, out_);
        return out_;
    }

    private static void Collect(object? node, List<string> out_)
    {
        if (node is not IReadOnlyDictionary<string, object?> n) return;
        if (n.TryGetValue(KEY_FIELD, out var f) && f is string name)
        {
            if (!out_.Contains(name)) out_.Add(name);
        }
        else if (n.TryGetValue(KEY_ARGS, out var args) && args is IEnumerable<object?> list)
        {
            foreach (var a in list) Collect(a, out_);
        }
    }

    private static bool IsFiniteNumber(object? v) => v switch
    {
        int or long or short or decimal => true,
        double d => double.IsFinite(d),
        float f => float.IsFinite(f),
        _ => false,
    };
}
