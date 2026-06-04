package com.metaobjects.integration;

import java.util.List;
import java.util.Map;

/**
 * Typed records for the scenario YAML. Shape mirrors C# / TS scenario types so
 * the same fixture files load cleanly into every port.
 */
public final class Scenarios {
    private Scenarios() {}

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
        Map<String, Object> data,                 // op:update — the field-keyed patch to WRITE
        Object expect
    ) {}

    public record QueryScenario(
        String name,
        String description,
        String sourcePath,
        String seedData,
        List<QuerySpec> queries
    ) {}
}
