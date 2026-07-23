// ApiContractAssertions — assertion vocabulary for api-contract-conformance.
// The recognized keys (equals / length / ids / names / row / hasId / envelope /
// error / empty / fieldsEqual / fieldsNotEqual) are the cross-port contract —
// every per-port runner must implement them identically. See
// fixtures/api-contract-conformance/README.md.
//
// fieldsEqual / fieldsNotEqual (#203 / ADR-0045, the @autoSet gate) compare RAW
// response-object fields to EACH OTHER (never a literal): fieldsEqual asserts all
// listed fields equal one another; fieldsNotEqual asserts the two listed fields
// differ. Field-vs-field so timestamp non-determinism is a non-issue.

namespace MetaObjects.IntegrationTests.Api;

internal static class ApiContractAssertions
{
    public static void AssertResponse(string scenarioName, ApiRequest request, int status, object? body)
    {
        if (status != request.ExpectStatus)
            throw new Xunit.Sdk.XunitException(
                $"{scenarioName} / {request.Id}: expected status {request.ExpectStatus}, got {status}; body: {Render(body)}");

        var want = request.ExpectBody;
        if (want is null) return;

        if (want.TryGetValue("empty", out var emp) && emp is bool eb && eb)
        {
            if (!IsEmpty(body))
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: expected empty body, got: {Render(body)}");
            return;
        }
        if (want.TryGetValue("equals", out var eq) && eq is not null)
        {
            if (!StructuralEquals(body, eq))
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: body mismatch\n  expected: {Render(eq)}\n  actual:   {Render(body)}");
            return;
        }
        if (want.TryGetValue("envelope", out var env) && env is bool envB && envB)
        {
            if (body is not Dictionary<string, object?> map)
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: expected envelope {{ rows, total }}, got: {Render(body)}");
            if (!map.TryGetValue("rows", out var rowsObj) || rowsObj is not List<object?> rows)
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: envelope.rows missing or not a list; got: {Render(body)}");
            if (!map.TryGetValue("total", out var totalObj) || totalObj is null)
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: envelope.total missing; got: {Render(body)}");
            long total = Convert.ToInt64(totalObj);
            if (want.TryGetValue("rowsLength", out var wantLenObj) && wantLenObj is not null)
            {
                int wantLen = Convert.ToInt32(wantLenObj);
                if (rows.Count != wantLen)
                    throw new Xunit.Sdk.XunitException(
                        $"{scenarioName} / {request.Id}: expected rows.length={wantLen}, got {rows.Count}");
            }
            if (want.TryGetValue("total", out var wantTotalObj) && wantTotalObj is not null)
            {
                long wantTotal = Convert.ToInt64(wantTotalObj);
                if (total != wantTotal)
                    throw new Xunit.Sdk.XunitException(
                        $"{scenarioName} / {request.Id}: expected total={wantTotal}, got {total}");
            }
            return;
        }
        if (want.TryGetValue("error", out var errObj) && errObj is string wantErr)
        {
            string? actual = null;
            if (body is Dictionary<string, object?> bm
                && bm.TryGetValue("error", out var e) && e is string s) actual = s;
            if (!wantErr.Equals(actual))
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: expected error=\"{wantErr}\", got: {Render(body)}");
            return;
        }
        if (want.TryGetValue("length", out var lenObj) && lenObj is not null)
        {
            int wantLen = Convert.ToInt32(lenObj);
            if (body is not List<object?> list)
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: expected array, got: {Render(body)}");
            if (list.Count != wantLen)
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: expected length={wantLen}, got {list.Count}");
        }
        if (want.TryGetValue("ids", out var idsObj) && idsObj is List<object?> wantIds)
        {
            if (body is not List<object?> list)
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: expected array, got: {Render(body)}");
            var actualIds = list.Select(it =>
                it is Dictionary<string, object?> m && m.TryGetValue("id", out var idV) && idV is not null
                    ? (long?)Convert.ToInt64(idV)
                    : null).ToList();
            var wantLongs = wantIds.Select(it => it is null ? (long?)null : (long?)Convert.ToInt64(it)).ToList();
            if (!actualIds.SequenceEqual(wantLongs))
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: expected ids [{string.Join(", ", wantLongs)}], got [{string.Join(", ", actualIds)}]");
        }
        if (want.TryGetValue("names", out var namesObj) && namesObj is List<object?> wantNames)
        {
            if (body is not List<object?> list)
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: expected array, got: {Render(body)}");
            var actualNames = list.Select(it =>
                it is Dictionary<string, object?> m && m.TryGetValue("name", out var n) ? n?.ToString() : null).ToList();
            var wantStrs = wantNames.Select(it => it?.ToString()).ToList();
            if (!actualNames.SequenceEqual(wantStrs))
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: expected names [{string.Join(", ", wantStrs)}], got [{string.Join(", ", actualNames)}]");
        }
        if (want.TryGetValue("namesUnordered", out var namesUObj) && namesUObj is List<object?> wantNamesU)
        {
            // M:N traversal (FR-018): related-row order through a junction is not
            // contractual, so compare the multiset of `name` fields order-insensitively.
            if (body is not List<object?> list)
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: expected array, got: {Render(body)}");
            var actualNames = list.Select(it =>
                it is Dictionary<string, object?> m && m.TryGetValue("name", out var n) ? n?.ToString() : null)
                .OrderBy(s => s, StringComparer.Ordinal).ToList();
            var wantStrs = wantNamesU.Select(it => it?.ToString())
                .OrderBy(s => s, StringComparer.Ordinal).ToList();
            if (!actualNames.SequenceEqual(wantStrs))
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: expected names (unordered) [{string.Join(", ", wantStrs)}], got [{string.Join(", ", actualNames)}]");
        }
        if (want.TryGetValue("row", out var rowObj) && rowObj is Dictionary<string, object?> wantRow)
        {
            if (body is not Dictionary<string, object?> row)
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: expected object, got: {Render(body)}");
            foreach (var kvp in wantRow)
            {
                row.TryGetValue(kvp.Key, out var actual);
                if (!StructuralEquals(actual, kvp.Value))
                    throw new Xunit.Sdk.XunitException(
                        $"{scenarioName} / {request.Id}: expected row.{kvp.Key}={Render(kvp.Value)}, got {Render(actual)}");
            }
        }
        if (want.TryGetValue("hasId", out var hasIdObj) && hasIdObj is bool hi && hi)
        {
            if (body is not Dictionary<string, object?> row)
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: expected object, got: {Render(body)}");
            if (!row.TryGetValue("id", out var id) || id is null
                || (id is not int && id is not long && id is not double && id is not decimal))
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: expected numeric id in body, got: {Render(body)}");
        }
        // #203 / ADR-0045 @autoSet gate — every listed response field must equal EACH OTHER
        // (raw field-vs-field, no literal). Missing keys compare as null.
        if (want.TryGetValue("fieldsEqual", out var feObj) && feObj is List<object?> feFields)
        {
            if (body is not Dictionary<string, object?> row)
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: expected object for fieldsEqual, got: {Render(body)}");
            var names = feFields.Select(f => f?.ToString() ?? "").ToList();
            for (int i = 1; i < names.Count; i++)
            {
                row.TryGetValue(names[0], out var v0);
                row.TryGetValue(names[i], out var vi);
                if (!StructuralEquals(v0, vi))
                    throw new Xunit.Sdk.XunitException(
                        $"{scenarioName} / {request.Id}: expected fields [{string.Join(", ", names)}] all equal, "
                        + $"but {names[0]}={Render(v0)} != {names[i]}={Render(vi)}");
            }
        }
        // #203 / ADR-0045 @autoSet gate — the two listed response fields must DIFFER from each
        // other (e.g. after a PATCH, autoCreatedAt (onCreate, preserved) != autoUpdatedAt
        // (onUpdate, bumped)). Missing keys compare as null.
        if (want.TryGetValue("fieldsNotEqual", out var fneObj) && fneObj is List<object?> fneFields)
        {
            if (body is not Dictionary<string, object?> row)
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: expected object for fieldsNotEqual, got: {Render(body)}");
            var names = fneFields.Select(f => f?.ToString() ?? "").ToList();
            if (names.Count != 2)
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: fieldsNotEqual expects exactly two field names, "
                    + $"got [{string.Join(", ", names)}]");
            row.TryGetValue(names[0], out var v0);
            row.TryGetValue(names[1], out var v1);
            if (StructuralEquals(v0, v1))
                throw new Xunit.Sdk.XunitException(
                    $"{scenarioName} / {request.Id}: expected fields {names[0]} and {names[1]} to DIFFER, "
                    + $"but both = {Render(v0)}");
        }
    }

    /// <summary>
    /// Structural equality that normalizes numeric subtypes (int/long/etc are equal
    /// when their long value matches), recurses into maps + lists, and treats
    /// missing keys as null.
    /// </summary>
    private static bool StructuralEquals(object? a, object? b)
    {
        if (a is null && b is null) return true;
        if (a is null || b is null) return false;
        if (IsNumber(a) && IsNumber(b)) return Convert.ToInt64(a) == Convert.ToInt64(b);
        if (a is List<object?> al && b is List<object?> bl)
        {
            if (al.Count != bl.Count) return false;
            for (int i = 0; i < al.Count; i++)
                if (!StructuralEquals(al[i], bl[i])) return false;
            return true;
        }
        if (a is Dictionary<string, object?> am && b is Dictionary<string, object?> bm)
        {
            // Two-way key check.
            foreach (var k in am.Keys) if (!bm.ContainsKey(k)) return false;
            foreach (var k in bm.Keys) if (!am.ContainsKey(k)) return false;
            foreach (var k in am.Keys) if (!StructuralEquals(am[k], bm[k])) return false;
            return true;
        }
        return a.Equals(b);
    }

    private static bool IsNumber(object o) =>
        o is sbyte or byte or short or ushort or int or uint or long or ulong;

    private static bool IsEmpty(object? body) => body switch
    {
        null => true,
        string s => s.Length == 0,
        Dictionary<string, object?> m => m.Count == 0,
        List<object?> l => l.Count == 0,
        _ => false,
    };

    private static string Render(object? o)
    {
        if (o is null) return "null";
        if (o is string s) return $"\"{s}\"";
        if (o is List<object?> l) return "[" + string.Join(", ", l.Select(Render)) + "]";
        if (o is Dictionary<string, object?> m)
            return "{" + string.Join(", ", m.Select(kvp => $"{kvp.Key}={Render(kvp.Value)}")) + "}";
        return o.ToString() ?? "null";
    }
}
