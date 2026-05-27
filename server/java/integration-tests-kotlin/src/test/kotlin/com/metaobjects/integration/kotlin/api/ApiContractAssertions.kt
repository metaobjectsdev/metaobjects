package com.metaobjects.integration.kotlin.api

import com.metaobjects.integration.kotlin.api.ApiContractScenarios.ApiRequest

/**
 * Assertion engine for api-contract-conformance scenarios. The vocabulary
 * (`equals` / `length` / `ids` / `names` / `row` / `hasId` / `envelope` /
 * `error` / `empty`) is the cross-port contract — every per-port runner
 * must implement these keys identically. See `fixtures/api-contract-conformance/README.md`.
 *
 * `body` here is the parsed JSON response (Map / List / scalar / null).
 */
object ApiContractAssertions {

    fun assertResponse(scenarioName: String, request: ApiRequest, status: Int, body: Any?) {
        if (status != request.expectStatus) {
            throw AssertionError(
                "$scenarioName / ${request.id}: expected status ${request.expectStatus}, got $status; body: $body"
            )
        }
        val want = request.expectBody ?: return

        if (want["empty"] == true) {
            if (!isEmpty(body))
                throw AssertionError("$scenarioName / ${request.id}: expected empty body, got: $body")
            return
        }
        want["equals"]?.let { eq ->
            if (!structuralEquals(body, eq))
                throw AssertionError("$scenarioName / ${request.id}: body mismatch\n  expected: $eq\n  actual:   $body")
            return
        }
        if (want["envelope"] == true) {
            val map = body as? Map<*, *>
                ?: throw AssertionError("$scenarioName / ${request.id}: expected envelope { rows, total }, got: $body")
            val rows = map["rows"] as? List<*>
                ?: throw AssertionError("$scenarioName / ${request.id}: envelope.rows missing or not a list; got: $body")
            val total = (map["total"] as? Number)?.toLong()
                ?: throw AssertionError("$scenarioName / ${request.id}: envelope.total missing or not a number; got: $body")
            (want["rowsLength"] as? Number)?.toInt()?.let { wantLen ->
                if (rows.size != wantLen)
                    throw AssertionError("$scenarioName / ${request.id}: expected rows.length=$wantLen, got ${rows.size}")
            }
            (want["total"] as? Number)?.toLong()?.let { wantTotal ->
                if (total != wantTotal)
                    throw AssertionError("$scenarioName / ${request.id}: expected total=$wantTotal, got $total")
            }
            return
        }
        (want["error"] as? String)?.let { wantErr ->
            val map = body as? Map<*, *>
            val actual = map?.get("error") as? String
            if (actual != wantErr)
                throw AssertionError("$scenarioName / ${request.id}: expected error=\"$wantErr\", got: $body")
            return
        }
        (want["length"] as? Number)?.toInt()?.let { wantLen ->
            val list = body as? List<*>
                ?: throw AssertionError("$scenarioName / ${request.id}: expected array, got: $body")
            if (list.size != wantLen)
                throw AssertionError("$scenarioName / ${request.id}: expected length=$wantLen, got ${list.size}")
        }
        (want["ids"] as? List<*>)?.let { wantIds ->
            val list = body as? List<*>
                ?: throw AssertionError("$scenarioName / ${request.id}: expected array, got: $body")
            val actualIds = list.map { (it as? Map<*, *>)?.get("id") }
            val wantLongs = wantIds.map { (it as? Number)?.toLong() }
            val actualLongs = actualIds.map { (it as? Number)?.toLong() }
            if (actualLongs != wantLongs)
                throw AssertionError("$scenarioName / ${request.id}: expected ids $wantLongs, got $actualLongs")
        }
        (want["names"] as? List<*>)?.let { wantNames ->
            val list = body as? List<*>
                ?: throw AssertionError("$scenarioName / ${request.id}: expected array, got: $body")
            val actualNames = list.map { (it as? Map<*, *>)?.get("name") }
            if (actualNames != wantNames)
                throw AssertionError("$scenarioName / ${request.id}: expected names $wantNames, got $actualNames")
        }
        (want["row"] as? Map<*, *>)?.let { wantRow ->
            val row = body as? Map<*, *>
                ?: throw AssertionError("$scenarioName / ${request.id}: expected object, got: $body")
            for ((k, v) in wantRow) {
                val actual = row[k]
                if (!structuralEquals(actual, v))
                    throw AssertionError("$scenarioName / ${request.id}: expected row.$k=$v, got $actual")
            }
        }
        if (want["hasId"] == true) {
            val row = body as? Map<*, *>
                ?: throw AssertionError("$scenarioName / ${request.id}: expected object, got: $body")
            val id = row["id"]
            if (id !is Number)
                throw AssertionError("$scenarioName / ${request.id}: expected numeric id in body, got: $body")
        }
    }

    /**
     * Structural equality that normalizes Number subtypes (Int/Long/etc are equal
     * if their long value matches) and recurses into Maps/Lists.
     */
    private fun structuralEquals(a: Any?, b: Any?): Boolean {
        if (a === b) return true
        if (a == null || b == null) return a == null && b == null
        if (a is Number && b is Number) return a.toLong() == b.toLong()
        if (a is List<*> && b is List<*>) {
            if (a.size != b.size) return false
            return a.indices.all { structuralEquals(a[it], b[it]) }
        }
        if (a is Map<*, *> && b is Map<*, *>) {
            if (a.keys != b.keys) return false
            return a.keys.all { structuralEquals(a[it], b[it]) }
        }
        return a == b
    }

    private fun isEmpty(body: Any?): Boolean = when (body) {
        null -> true
        "" -> true
        is Map<*, *> -> body.isEmpty()
        is List<*> -> body.isEmpty()
        else -> false
    }
}
