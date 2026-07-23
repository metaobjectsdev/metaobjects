package com.metaobjects.integration.api;

import com.metaobjects.integration.api.ApiContractScenarios.ApiRequest;

import java.util.List;
import java.util.Map;

/**
 * Assertion engine for api-contract-conformance scenarios. The vocabulary
 * ({@code equals} / {@code length} / {@code ids} / {@code names} /
 * {@code row} / {@code hasId} / {@code envelope} / {@code error} /
 * {@code empty} / {@code fieldsEqual} / {@code fieldsNotEqual}) is the
 * cross-port contract — every per-port runner must implement these keys
 * identically. See {@code fixtures/api-contract-conformance/README.md}.
 *
 * <p>{@code body} here is the parsed JSON response (Map / List / scalar /
 * null). Mirror of {@code ApiContractAssertions.kt} in
 * {@code integration-tests-kotlin}.</p>
 */
final class ApiContractAssertions {
    private ApiContractAssertions() {}

    static void assertResponse(String scenarioName, ApiRequest request, int status, Object body) {
        if (status != request.expectStatus()) {
            throw new AssertionError(
                scenarioName + " / " + request.id() + ": expected status "
                    + request.expectStatus() + ", got " + status + "; body: " + body);
        }
        Map<String, Object> want = request.expectBody();
        if (want == null) return;

        if (Boolean.TRUE.equals(want.get("empty"))) {
            if (!isEmpty(body))
                throw new AssertionError(
                    scenarioName + " / " + request.id() + ": expected empty body, got: " + body);
            return;
        }
        Object eq = want.get("equals");
        if (eq != null) {
            if (!structuralEquals(body, eq))
                throw new AssertionError(
                    scenarioName + " / " + request.id() + ": body mismatch\n  expected: "
                        + eq + "\n  actual:   " + body);
            return;
        }
        if (Boolean.TRUE.equals(want.get("envelope"))) {
            if (!(body instanceof Map<?, ?> map))
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": expected envelope { rows, total }, got: " + body);
            Object rowsObj = map.get("rows");
            if (!(rowsObj instanceof List<?> rows))
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": envelope.rows missing or not a list; got: " + body);
            Object totalObj = map.get("total");
            if (!(totalObj instanceof Number totalNum))
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": envelope.total missing or not a number; got: " + body);
            long total = totalNum.longValue();
            Object wantLenObj = want.get("rowsLength");
            if (wantLenObj instanceof Number wantLen && rows.size() != wantLen.intValue())
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": expected rows.length=" + wantLen.intValue() + ", got " + rows.size());
            Object wantTotalObj = want.get("total");
            if (wantTotalObj instanceof Number wantTotal && total != wantTotal.longValue())
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": expected total=" + wantTotal.longValue() + ", got " + total);
            return;
        }
        Object errObj = want.get("error");
        if (errObj instanceof String wantErr) {
            String actual = null;
            if (body instanceof Map<?, ?> bm && bm.get("error") instanceof String s) actual = s;
            if (!wantErr.equals(actual))
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": expected error=\"" + wantErr + "\", got: " + body);
            return;
        }
        Object lenObj = want.get("length");
        if (lenObj instanceof Number wantLen) {
            if (!(body instanceof List<?> list))
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": expected array, got: " + body);
            if (list.size() != wantLen.intValue())
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": expected length=" + wantLen.intValue() + ", got " + list.size());
        }
        Object idsObj = want.get("ids");
        if (idsObj instanceof List<?> wantIds) {
            if (!(body instanceof List<?> list))
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": expected array, got: " + body);
            List<Long> actualIds = list.stream().map(it -> {
                if (it instanceof Map<?, ?> m && m.get("id") instanceof Number n) return n.longValue();
                return (Long) null;
            }).toList();
            List<Long> wantLongs = wantIds.stream().map(it -> it instanceof Number n ? n.longValue() : null).toList();
            if (!actualIds.equals(wantLongs))
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": expected ids " + wantLongs + ", got " + actualIds);
        }
        Object namesObj = want.get("names");
        if (namesObj instanceof List<?> wantNames) {
            if (!(body instanceof List<?> list))
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": expected array, got: " + body);
            List<?> actualNames = list.stream().map(it -> {
                if (it instanceof Map<?, ?> m) return m.get("name");
                return null;
            }).toList();
            if (!actualNames.equals(wantNames))
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": expected names " + wantNames + ", got " + actualNames);
        }
        Object rowObj = want.get("row");
        if (rowObj instanceof Map<?, ?> wantRow) {
            if (!(body instanceof Map<?, ?> row))
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": expected object, got: " + body);
            for (Map.Entry<?, ?> e : wantRow.entrySet()) {
                Object actual = row.get(e.getKey());
                if (!structuralEquals(actual, e.getValue()))
                    throw new AssertionError(scenarioName + " / " + request.id()
                        + ": expected row." + e.getKey() + "=" + e.getValue() + ", got " + actual);
            }
        }
        if (Boolean.TRUE.equals(want.get("hasId"))) {
            if (!(body instanceof Map<?, ?> row))
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": expected object, got: " + body);
            Object id = row.get("id");
            if (!(id instanceof Number))
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": expected numeric id in body, got: " + body);
        }
        // @autoSet gate (#203 / ADR-0045). Both keys compare RAW response-object fields to
        // EACH OTHER (never to a literal), so timestamp non-determinism is a non-issue.
        Object fieldsEqObj = want.get("fieldsEqual");
        if (fieldsEqObj instanceof List<?> fields) {
            if (!(body instanceof Map<?, ?> row))
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": expected object for fieldsEqual, got: " + body);
            if (!fields.isEmpty()) {
                Object head = row.get(fields.get(0));
                for (Object f : fields) {
                    Object v = row.get(f);
                    if (!structuralEquals(head, v))
                        throw new AssertionError(scenarioName + " / " + request.id()
                            + ": expected fields " + fields + " all equal, but " + fields.get(0)
                            + "=" + head + " != " + f + "=" + v + "; body: " + body);
                }
            }
        }
        Object fieldsNeObj = want.get("fieldsNotEqual");
        if (fieldsNeObj instanceof List<?> fields) {
            if (!(body instanceof Map<?, ?> row))
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": expected object for fieldsNotEqual, got: " + body);
            if (fields.size() != 2)
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": fieldsNotEqual expects exactly 2 field names, got: " + fields);
            Object a = row.get(fields.get(0));
            Object b = row.get(fields.get(1));
            if (structuralEquals(a, b))
                throw new AssertionError(scenarioName + " / " + request.id()
                    + ": expected fields " + fields.get(0) + " and " + fields.get(1)
                    + " to differ, but both = " + a + "; body: " + body);
        }
    }

    /**
     * Structural equality that normalizes Number subtypes
     * (Integer/Long/etc are equal if their long value matches) and
     * recurses into Maps/Lists.
     */
    private static boolean structuralEquals(Object a, Object b) {
        if (a == b) return true;
        if (a == null || b == null) return false;
        if (a instanceof Number an && b instanceof Number bn) return an.longValue() == bn.longValue();
        if (a instanceof List<?> al && b instanceof List<?> bl) {
            if (al.size() != bl.size()) return false;
            for (int i = 0; i < al.size(); i++)
                if (!structuralEquals(al.get(i), bl.get(i))) return false;
            return true;
        }
        if (a instanceof Map<?, ?> am && b instanceof Map<?, ?> bm) {
            if (!am.keySet().equals(bm.keySet())) return false;
            for (Object k : am.keySet())
                if (!structuralEquals(am.get(k), bm.get(k))) return false;
            return true;
        }
        return a.equals(b);
    }

    private static boolean isEmpty(Object body) {
        if (body == null) return true;
        if (body instanceof String s) return s.isEmpty();
        if (body instanceof Map<?, ?> m) return m.isEmpty();
        if (body instanceof List<?> l) return l.isEmpty();
        return false;
    }
}
