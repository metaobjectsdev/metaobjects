// ListQuery — how a list route reads its query string: the filter tree (and/or groups to a depth
// cap), search, sort and page, or the named 400 it refuses with. A port of runtime-ts's
// parseListQuery (server/typescript/packages/runtime-ts/src/drizzle-fastify/list-query.ts), held
// to it by the shared parse cases in fixtures/list-query-conformance/.
//
// The parse runs before any store sees the query. EfCoreFilterDispatch turns the parsed tree into
// an IQueryable filter; a hand-written list endpoint over another store reads the same tree.
//
// Faults are found, and the first reported, in this order: bare field parameters; limit, then
// offset; the filter, depth-first in the order its keys were sent; the sort; the search.

#nullable enable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace MetaObjects.AspNetCore;

/// <summary>A node of a parsed filter: a <see cref="FilterLeaf"/>, a <see cref="FilterAnd"/> or a <see cref="FilterOr"/>.</summary>
public abstract record FilterNode;

/// <summary>
/// One condition. <see cref="Value"/> is neutral, not a driver's: a <see cref="string"/> (text, enum
/// member, date, time, uuid, duration, like pattern, a decimal's canonical text, a timestamp's UTC
/// spelling), a <see cref="long"/> (an integer field), a <see cref="double"/> (another number), a
/// <see cref="bool"/> (a boolean, and <c>isNull</c>'s operand), or for <c>in</c> a list of those.
/// </summary>
public sealed record FilterLeaf(string Field, string Op, object Value) : FilterNode;

/// <summary>Every branch holds.</summary>
public sealed record FilterAnd(IReadOnlyList<FilterNode> Nodes) : FilterNode;

/// <summary>At least one branch holds.</summary>
public sealed record FilterOr(IReadOnlyList<FilterNode> Nodes) : FilterNode;

/// <summary>A case-insensitive substring search over <see cref="Fields"/>.</summary>
public sealed record ListSearch(string Term, IReadOnlyList<string> Fields);

/// <summary>One sort key; <see cref="Order"/> is <c>asc</c> or <c>desc</c>.</summary>
public sealed record ListSort(string Field, string Order)
{
    public bool Descending => Order == "desc";
}

/// <summary>A parsed list query. Members a query did not send are null.</summary>
public sealed record ListQuery(FilterNode? Filter, ListSearch? Search, ListSort? Sort, long? Limit, long? Offset);

/// <summary>
/// A refused list query: the wire <see cref="Error"/> code and its <see cref="Details"/>, in the
/// order the 400 body lists them (<see cref="Body"/>).
/// </summary>
public sealed class ListQueryError
{
    public ListQueryError(string error, string message, IReadOnlyList<KeyValuePair<string, object?>> details)
    {
        Error = error;
        Message = message;
        Details = details;
    }

    /// <summary>The wire code: <c>invalid_filter_field</c>, <c>invalid_filter_op</c>, <c>invalid_filter_value</c>,
    /// <c>invalid_sort</c>, <c>filter.bare_field</c>, <c>filter.nesting_too_deep</c>, <c>filter.in_too_large</c>,
    /// <c>filter.leading_wildcard_disallowed</c> or <c>pagination.invalid_value</c>.</summary>
    public string Error { get; }

    /// <summary>A sentence for a person; not part of the 400 body.</summary>
    public string Message { get; }

    /// <summary>The members after <c>error</c> in the 400 body.</summary>
    public IReadOnlyList<KeyValuePair<string, object?>> Details { get; }

    /// <summary>The 400 body: <c>{ "error": code, ...details }</c>.</summary>
    public Dictionary<string, object?> Body()
    {
        var body = new Dictionary<string, object?>(StringComparer.Ordinal) { ["error"] = Error };
        foreach (var (k, v) in Details) body[k] = v;
        return body;
    }
}

/// <summary>The outcome of <see cref="ListQueryParser.Parse"/>: a query or an error, never both.</summary>
public sealed record ListQueryResult(ListQuery? Query, ListQueryError? Error)
{
    public bool Ok => Error is null;
}

/// <summary>Parses a list route's raw query string against the generated allowlist.</summary>
public static class ListQueryParser
{
    /// <summary>Five levels of or/and nesting; the sixth is <c>filter.nesting_too_deep</c>.</summary>
    public const int DefaultMaxNesting = 5;

    /// <summary>At most 100 <c>in</c> elements; more is <c>filter.in_too_large</c>.</summary>
    public const int DefaultMaxInList = 100;

    /// <summary>The <c>expected</c> text of an <c>invalid_sort</c>.</summary>
    public const string SortExpected = "sort=<field>:asc|desc";

    /// <summary>The <c>expected</c> text of a malformed <c>limit</c> or <c>offset</c>.</summary>
    public const string PaginationExpected = "a non-negative integer (0 or more)";

    private static readonly HashSet<string> ReservedParams = new(StringComparer.Ordinal)
    {
        "filter", "sort", "limit", "offset", "search", "withCount",
    };

    /// <summary>
    /// Parse <paramref name="rawQuery"/> (the query string as it arrives, with or without its
    /// leading <c>?</c>). <paramref name="fieldNames"/>, when given, names every field of the
    /// entity, so a bare <c>?notes=x</c> for a field that is not filterable is refused with a reason
    /// rather than ignored as an unknown parameter.
    /// </summary>
    public static ListQueryResult Parse(
        string? rawQuery,
        IReadOnlyDictionary<string, FilterFieldRule> rules,
        IReadOnlyDictionary<string, SortFieldRule> sortRules,
        IReadOnlySet<string>? fieldNames = null,
        int maxNesting = DefaultMaxNesting,
        int maxInList = DefaultMaxInList)
    {
        try
        {
            var q = QueryString.Parse(rawQuery);
            RejectBareFields(q, rules, fieldNames);
            var limit = PageBound(q, "limit");
            var offset = PageBound(q, "offset");
            FilterNode? filter = null;
            if (q.TryGet("filter", out var f) && f is QueryString.Map fm)
                filter = ParseNode(fm, rules, maxNesting, maxInList, 0);
            ListSort? sort = null;
            if (q.TryGet("sort", out var s) && s is QueryString.Scalar ss) sort = ParseSort(ss.Value, sortRules);
            ListSearch? search = null;
            if (q.TryGet("search", out var t) && t is QueryString.Scalar ts && ts.Value != "")
            {
                var fields = SearchFields(rules);
                if (fields.Count > 0) search = new ListSearch(ts.Value, fields);
            }
            return new ListQueryResult(new ListQuery(filter, search, sort, limit, offset), null);
        }
        catch (Refusal r)
        {
            return new ListQueryResult(null, r.Error);
        }
    }

    /// <summary>
    /// The fields <c>?search</c> matches: text rules (no format) whose band has <c>like</c>, so a
    /// uuid and an int-backed enum take no text match.
    /// </summary>
    public static IReadOnlyList<string> SearchFields(IReadOnlyDictionary<string, FilterFieldRule> rules) =>
        rules.Where(kv => kv.Value.Kind == FilterValueKind.String && kv.Value.Format is null && kv.Value.Ops.Contains("like"))
            .Select(kv => kv.Key).ToList();

    private sealed class Refusal : Exception
    {
        public Refusal(string error, string message, params (string Key, object? Value)[] details) : base(message) =>
            Error = new ListQueryError(error, message, details.Select(d => new KeyValuePair<string, object?>(d.Key, d.Value)).ToList());

        public ListQueryError Error { get; }
    }

    private static void RejectBareFields(QueryString.Map q, IReadOnlyDictionary<string, FilterFieldRule> rules, IReadOnlySet<string>? fieldNames)
    {
        foreach (var (key, value) in q.Entries())
        {
            if (ReservedParams.Contains(key)) continue;
            if (rules.ContainsKey(key))
            {
                var shown = value is QueryString.Scalar sv ? sv.Value : "<value>";
                throw new Refusal("filter.bare_field",
                    $"\"{key}\" is a filterable field, but a bare ?{key}= parameter is not a filter. Use filter[{key}][eq]={shown}.",
                    ("field", key), ("expected", $"filter[{key}][eq]={shown}"));
            }
            if (fieldNames is not null && fieldNames.Contains(key))
            {
                var allowed = rules.Keys.ToList();
                throw new Refusal("filter.bare_field",
                    $"\"{key}\" is a field of this entity, but it is not @filterable, so it cannot be filtered on" +
                    (allowed.Count > 0 ? $" (filterable: {string.Join(", ", allowed)})." : " (no field is filterable)."),
                    ("field", key), ("filterable", false), ("expected", $"a filterable field — \"{key}\" is not @filterable"), ("allowed", allowed));
            }
        }
    }

    private static long? PageBound(QueryString.Map q, string param)
    {
        if (!q.TryGet(param, out var raw)) return null;
        var s = raw.Text();
        if (s.Length > 0 && s.All(c => c >= '0' && c <= '9')
            && long.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out var n) && n <= MaxSafeInteger)
            return n;
        throw new Refusal("pagination.invalid_value", $"?{param}= must be {PaginationExpected}, got \"{s}\".",
            ("param", param), ("value", s), ("expected", PaginationExpected));
    }

    // 2^53 - 1: the largest bound TypeScript accepts (Number.isSafeInteger), so both ports refuse the same input.
    private const long MaxSafeInteger = 9007199254740991L;

    private static FilterNode? ParseNode(QueryString.Map node, IReadOnlyDictionary<string, FilterFieldRule> rules, int maxNesting, int maxInList, int depth)
    {
        if (depth > maxNesting)
            throw new Refusal("filter.nesting_too_deep", $"Filter nesting depth exceeds limit ({maxNesting}).", ("limit", maxNesting));
        var parts = new List<FilterNode>();
        foreach (var (key, value) in node.Entries())
        {
            if (key is "or" or "and")
            {
                if (value is not QueryString.Map branches)
                    throw new Refusal("invalid_filter_value", $"Expected array for \"{key}\".", ("field", key));
                var subs = new List<FilterNode>();
                foreach (var (_, branch) in branches.Entries())
                {
                    if (branch is not QueryString.Map bm)
                        throw new Refusal("invalid_filter_value", $"Each \"{key}\" branch must be a filter object.", ("field", key));
                    var sub = ParseNode(bm, rules, maxNesting, maxInList, depth + 1);
                    if (sub is not null) subs.Add(sub);
                }
                if (subs.Count == 0) continue;
                parts.Add(subs.Count == 1 ? subs[0] : key == "or" ? new FilterOr(subs) : new FilterAnd(subs));
                continue;
            }
            if (!rules.TryGetValue(key, out var rule))
                throw new Refusal("invalid_filter_field", $"Unknown filter field \"{key}\".", ("field", key), ("allowed", rules.Keys.ToList()));
            if (value is QueryString.Map ops)
                foreach (var (op, operand) in ops.Entries()) parts.Add(Leaf(key, rule, op, operand.Text(), maxInList));
            else
                parts.Add(Leaf(key, rule, "eq", value.Text(), maxInList));
        }
        if (parts.Count == 0) return null;
        return parts.Count == 1 ? parts[0] : new FilterAnd(parts);
    }

    private static FilterLeaf Leaf(string field, FilterFieldRule rule, string op, string operand, int maxInList)
    {
        if (!rule.Ops.Contains(op))
            throw new Refusal("invalid_filter_op", $"Op \"{op}\" not supported for field \"{field}\".",
                ("field", field), ("op", op), ("allowed", rule.Ops.ToList()));
        switch (op)
        {
            case "in":
            {
                var list = operand.Split(',').Select(v => Operand(v.Trim(), rule, field, op)).ToList();
                if (list.Count > maxInList)
                    throw new Refusal("filter.in_too_large", $"In-list size {list.Count} exceeds limit {maxInList}.",
                        ("field", field), ("limit", maxInList));
                return new FilterLeaf(field, op, list);
            }
            case "like":
                if (operand.StartsWith('%') && !rule.LeadingWildcard)
                    throw new Refusal("filter.leading_wildcard_disallowed", $"Leading wildcard not allowed for field \"{field}\".", ("field", field));
                return new FilterLeaf(field, op, operand);
            case "isNull":
                return new FilterLeaf(field, op, AsBoolean(operand, field, op));
            default:
                return new FilterLeaf(field, op, Operand(operand, rule, field, op));
        }
    }

    private const string IntegerExpected = "integer (a whole number)";

    private static Refusal InvalidValue(string field, string op, string s, string expected, params (string Key, object? Value)[] extra)
    {
        string hint = "";
        foreach (var (k, v) in extra) if (k == "hint" && v is string h) hint = $" Hint: {h}.";
        var details = new List<(string, object?)> { ("field", field), ("op", op), ("expected", expected) };
        details.AddRange(extra);
        return new Refusal("invalid_filter_value", $"Field \"{field}\" op \"{op}\" requires {expected}, got \"{s}\".{hint}", details.ToArray());
    }

    private static object Operand(string s, FilterFieldRule rule, string field, string op)
    {
        if (rule.EnumValues is { } members && !members.Contains(s))
            throw InvalidValue(field, op, s, "one of: " + string.Join(", ", members), ("allowed", members.ToList()));
        if (rule.Format is { } format)
        {
            if (!FilterValueFormat.Matches(format, s))
            {
                if (format == FilterValueFormats.Timestamp && FilterValueFormat.LooksLikeUnencodedPlusOffset(s))
                    throw InvalidValue(field, op, s, FilterValueFormat.Expected[format], ("hint", FilterValueFormat.PlusOffsetHint));
                throw InvalidValue(field, op, s, FilterValueFormat.Expected[format]);
            }
        }
        else if (rule.Kind == FilterValueKind.Datetime && !FilterValueFormat.MatchesAnyTemporal(s))
        {
            throw InvalidValue(field, op, s, FilterValueFormat.AnyTemporalExpected);
        }
        if (rule.Format == FilterValueFormats.Decimal)
        {
            DecimalWire.TryParse(s, out var d);
            return DecimalWire.Format(d);
        }
        if (rule.Format == FilterValueFormats.Timestamp)
            return rule.Instant ? FilterValueFormat.UtcInstant(s) : FilterValueFormat.UtcIfZoned(s);
        if (rule.Format is not null) return s;
        switch (rule.Kind)
        {
            case FilterValueKind.Boolean:
                return AsBoolean(s, field, op);
            case FilterValueKind.Number:
            {
                var t = s.Trim();
                if (rule.Integer && long.TryParse(t, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var whole))
                    return whole;
                if (t == "" || !double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out var n) || !double.IsFinite(n))
                    throw new Refusal("invalid_filter_value", $"Field \"{field}\" op \"{op}\" requires number, got \"{s}\".",
                        ("field", field), ("op", op), ("expected", "number"));
                if (rule.Integer)
                {
                    if (Math.Floor(n) != n) throw InvalidValue(field, op, s, IntegerExpected);
                    if (n >= long.MinValue && n <= long.MaxValue) return (long)n;
                }
                return n;
            }
            default:
                return s;
        }
    }

    private static bool AsBoolean(string s, string field, string op) => s switch
    {
        "true" or "1" => true,
        "false" or "0" => false,
        _ => throw new Refusal("invalid_filter_value", $"Field \"{field}\" op \"{op}\" requires boolean, got \"{s}\".",
            ("field", field), ("op", op), ("expected", "boolean")),
    };

    private static ListSort ParseSort(string spec, IReadOnlyDictionary<string, SortFieldRule> sortRules)
    {
        int colon = spec.IndexOf(':');
        var field = colon < 0 ? spec : spec.Substring(0, colon);
        if (!sortRules.TryGetValue(field, out var rule))
            throw new Refusal("invalid_sort", $"Unknown sort field \"{field}\". The syntax is {SortExpected}.",
                ("field", field), ("expected", SortExpected), ("allowed", sortRules.Keys.ToList()));
        // The caller's order, else the field's DECLARED @sortableDefaultOrder, else ascending.
        var orderRaw = colon < 0 ? rule.DefaultOrder ?? "asc" : spec.Substring(colon + 1);
        var order = orderRaw.ToLowerInvariant();
        if (order is not ("asc" or "desc"))
            throw new Refusal("invalid_sort", $"Sort order must be asc|desc, got \"{orderRaw}\". The syntax is {SortExpected}.",
                ("field", field), ("expected", SortExpected), ("allowed", sortRules.Keys.ToList()));
        return new ListSort(field, order);
    }

    /// <summary>
    /// The bracket grammar of a query string, read the way the TypeScript mounts' <c>qs</c> reads it:
    /// <c>a[b][c]=v</c> nests, a repeated key collects its values, and a map's keys come back with
    /// array-index keys first in numeric order and every other key in the order it was sent (a
    /// JavaScript object's own key order), so <c>filter[or][1]…&amp;filter[or][0]…</c> is in index order.
    /// </summary>
    private static class QueryString
    {
        internal abstract class Value
        {
            /// <summary>The value as text; a repeated value is its parts joined by commas.</summary>
            public abstract string Text();
        }

        internal sealed class Scalar : Value
        {
            public Scalar(string value) => Value = value;
            public string Value { get; }
            public override string Text() => Value;
        }

        internal sealed class Many : Value
        {
            public List<string> Values { get; } = new();
            public override string Text() => string.Join(",", Values);
        }

        internal sealed class Map : Value
        {
            private readonly List<string> _order = new();
            private readonly Dictionary<string, Value> _values = new(StringComparer.Ordinal);

            public override string Text() => "[object Object]";

            public bool TryGet(string key, out Value value) => _values.TryGetValue(key, out value!);

            public IEnumerable<(string Key, Value Value)> Entries() =>
                _order.Where(IsIndex).OrderBy(k => long.Parse(k, CultureInfo.InvariantCulture))
                    .Concat(_order.Where(k => !IsIndex(k)))
                    .Select(k => (k, _values[k]));

            public void Set(List<string> path, int at, string value)
            {
                var key = path[at];
                if (at == path.Count - 1)
                {
                    if (!_values.TryGetValue(key, out var existing)) { Add(key, new Scalar(value)); return; }
                    switch (existing)
                    {
                        case Scalar s:
                            var many = new Many();
                            many.Values.Add(s.Value);
                            many.Values.Add(value);
                            _values[key] = many;
                            break;
                        case Many m:
                            m.Values.Add(value);
                            break;
                        // A scalar sent beside a map under the same key: the map keeps its members.
                    }
                    return;
                }
                if (!_values.TryGetValue(key, out var child) || child is not Map map)
                {
                    map = new Map();
                    if (child is null) Add(key, map); else _values[key] = map;
                }
                map.Set(path, at + 1, value);
            }

            private void Add(string key, Value value)
            {
                _order.Add(key);
                _values[key] = value;
            }

            // A JavaScript array index: a canonical non-negative integer below 2^32 - 1.
            private static bool IsIndex(string k) =>
                k.Length > 0 && k.Length <= 10 && k.All(c => c >= '0' && c <= '9') && (k == "0" || k[0] != '0')
                && long.Parse(k, CultureInfo.InvariantCulture) < 4294967295L;
        }

        public static Map Parse(string? raw)
        {
            var root = new Map();
            if (string.IsNullOrEmpty(raw)) return root;
            if (raw[0] == '?') raw = raw.Substring(1);
            foreach (var pair in raw.Split('&'))
            {
                if (pair.Length == 0) continue;
                int eq = pair.IndexOf('=');
                var key = Decode(eq < 0 ? pair : pair.Substring(0, eq));
                var value = eq < 0 ? "" : Decode(pair.Substring(eq + 1));
                var path = KeyPath(key);
                if (path.Count == 0 || path[0].Length == 0) continue;
                root.Set(path, 0, value);
            }
            return root;
        }

        // `a[b][c]` → a, b, c. Text after the last balanced bracket pair, or an unclosed `[`, stays
        // part of the last segment, as qs leaves it.
        private static List<string> KeyPath(string key)
        {
            var path = new List<string>();
            int open = key.IndexOf('[');
            if (open <= 0) { path.Add(key); return path; }
            path.Add(key.Substring(0, open));
            int i = open;
            while (i < key.Length && key[i] == '[')
            {
                int close = key.IndexOf(']', i + 1);
                if (close < 0) break;
                path.Add(key.Substring(i + 1, close - i - 1));
                i = close + 1;
            }
            if (i < key.Length) path[^1] += key.Substring(i);
            return path;
        }

        private static string Decode(string s)
        {
            try { return Uri.UnescapeDataString(s.Replace('+', ' ')); }
            catch (UriFormatException) { return s; }
        }
    }
}
