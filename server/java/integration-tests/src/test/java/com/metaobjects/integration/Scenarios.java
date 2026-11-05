package com.metaobjects.integration;

import java.util.List;
import java.util.Map;

/**
 * Typed records for the scenario YAML. Shape mirrors C# / TS scenario types so
 * the same fixture files load cleanly into every port.
 */
public final class Scenarios {
    private Scenarios() {}

    /**
     * Scenarios this port defers on EVERY engine it runs them on, each with the port gap that
     * blocks it. A runner aborts (skips) a listed scenario instead of failing it; every other
     * scenario under {@code queries/} runs, so a new fixture auto-runs or auto-fails.
     */
    public static final Map<String, String> DEFERRED = Map.of(
        "roundtrip-int-enum-array",
        "OMDB persists no field.enum array of either kind: no driver maps an enum to an array column (PostgresDriver.nativeArrayElementType answers text/uuid/numeric only, and SQLite/MySQL have no primitive-array path), so the int-backed enum codec refuses the array rather than store symbols."
    );

    public record SortSpec(String field, String dir) {}

    public record QuerySpec(
        String name,
        String op,                                // list | get | count | relate | update | delete | roundtrip
        String entity,
        Map<String, Object> by,
        Map<String, Object> filter,
        List<SortSpec> sort,
        Integer limit,
        Integer offset,
        String relation,                          // op:relate — the M:N relationship name to traverse
        Map<String, Object> insert,               // op:roundtrip — the field-keyed row to WRITE
        Map<String, Object> data,                 // op:create / op:update — the field-keyed row/patch to WRITE
        Object expect,
        boolean expectError                       // when true, the op MUST throw (cross-subtype write rejection)
    ) {}

    public record QueryScenario(
        String name,
        String description,
        String sourcePath,
        String seedData,
        Map<String, String> seedDataEngine,       // engine -> seed SQL, when an engine needs its own spelling
        List<String> engines,                     // exact engine list when present; null = the historical rule
        List<QuerySpec> queries
    ) {}
}
