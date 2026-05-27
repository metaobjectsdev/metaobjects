package com.metaobjects.generator.spring.runtime;

import java.util.List;

/**
 * Outcome of {@link FilterParser#parse}: either a list of validated
 * predicates ({@code error == null}), or a cross-port error envelope key
 * ({@code predicates} is empty + {@code error} is one of
 * {@code invalid_filter_field} / {@code invalid_filter_op} /
 * {@code invalid_filter_value}).
 */
public record FilterParseResult(List<FilterPredicate> predicates, String error) {

    /** Success path: a list of (possibly empty) predicates. */
    public static FilterParseResult ok(List<FilterPredicate> predicates) {
        return new FilterParseResult(predicates, null);
    }

    /** Error path: cross-port envelope key (no predicates). */
    public static FilterParseResult err(String error) {
        return new FilterParseResult(List.of(), error);
    }
}
