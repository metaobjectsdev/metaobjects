// FilterParser — substrate-agnostic parser for the FR-009 filter URL grammar
// (filter[<field>][<op>]=<value>, plus filter[<field>]=<value> sugar for eq).
//
// Generated routes call FilterParser.Parse(request.Query, allowlistFields,
// opsByField) at the top of their list handler. On error → 400 with the
// returned envelope key; on success → the dispatcher (EfCoreFilterDispatch)
// applies the predicates to an IQueryable<T>.
//
// Part of the codegen runtime surface; mirrors Java codegen-spring's
// runtime/FilterParser.java byte-for-byte semantics.

using System.Collections.Generic;
using Microsoft.AspNetCore.Http;

namespace MetaObjects.Codegen.Runtime;

/// <summary>
/// Parses the cross-port FR-009 filter URL grammar
/// (<c>filter[&lt;field&gt;][&lt;op&gt;]=&lt;value&gt;</c>, and the
/// <c>filter[&lt;field&gt;]=&lt;value&gt;</c> sugar form for <c>eq</c>) against
/// a per-entity allowlist.
/// </summary>
public static class FilterParser
{
    /// <summary>Sentinel returned by <see cref="CoerceValue"/> on a parse failure.</summary>
    private static readonly object InvalidValue = new();

    /// <summary>
    /// Parse the <c>filter[...]</c> query parameters against the per-entity
    /// allowlist. Returns predicates on success, or an error envelope key on
    /// the first failure (no partial progress).
    /// </summary>
    /// <param name="query">ASP.NET Core request query collection.</param>
    /// <param name="allowedFields">Per-entity field allowlist
    /// (e.g. <c>&lt;Entity&gt;FilterAllowlist.Fields</c>).</param>
    /// <param name="opsByField">Per-field operator allowlist
    /// (e.g. <c>&lt;Entity&gt;FilterAllowlist.OpsByField</c>).</param>
    public static FilterParseResult Parse(
        IQueryCollection query,
        HashSet<string> allowedFields,
        Dictionary<string, HashSet<string>> opsByField)
    {
        if (query is null || query.Count == 0) return FilterParseResult.Ok(System.Array.Empty<FilterPredicate>());

        var predicates = new List<FilterPredicate>();
        foreach (var kvp in query)
        {
            string key = kvp.Key;
            if (!key.StartsWith("filter[", System.StringComparison.Ordinal)) continue;
            int firstClose = key.IndexOf(']', 7);
            if (firstClose < 0) continue;
            string field = key.Substring(7, firstClose - 7);
            string op;
            int rest = firstClose + 1;
            if (rest >= key.Length)
            {
                op = "eq";
            }
            else if (key[rest] == '[')
            {
                int secondClose = key.IndexOf(']', rest + 1);
                if (secondClose < 0) continue;
                op = key.Substring(rest + 1, secondClose - rest - 1);
            }
            else
            {
                continue;
            }

            if (!allowedFields.Contains(field))
                return FilterParseResult.Err("invalid_filter_field");
            if (!opsByField.TryGetValue(field, out var ops) || !ops.Contains(op))
                return FilterParseResult.Err("invalid_filter_op");

            // The ASP.NET parser already URL-decodes the value; take the first
            // for multi-value keys (the bracketed grammar always sends one).
            string raw = kvp.Value.Count > 0 ? (kvp.Value[0] ?? "") : "";
            object? coerced = CoerceValue(raw, op);
            if (ReferenceEquals(coerced, InvalidValue))
                return FilterParseResult.Err("invalid_filter_value");

            predicates.Add(new FilterPredicate(field, op, coerced));
        }
        return FilterParseResult.Ok(predicates);
    }

    /// <summary>
    /// Coerce a raw URL-decoded string into a typed value for <paramref name="op"/>.
    /// Substrate type (number vs string vs date) is left for the dispatcher to
    /// handle — this parser only normalizes the structural shape: a list for
    /// <c>in</c>, a bool for <c>isNull</c>, otherwise the raw string.
    /// </summary>
    private static object? CoerceValue(string raw, string op)
    {
        if (op == "isNull")
        {
            if (raw == "true") return true;
            if (raw == "false") return false;
            return InvalidValue;
        }
        if (op == "in")
        {
            var parts = raw.Split(',');
            var list = new List<string>(parts.Length);
            foreach (var p in parts) list.Add(p.Trim());
            return list;
        }
        // For eq/ne/gt/gte/lt/lte/like the parser passes through the raw string;
        // the dispatcher converts it to the column type (EF translates).
        return raw;
    }
}
