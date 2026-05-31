package com.metaobjects.render.extract;

import java.util.Map;
import java.util.Objects;

/** Engine return. data is a forgiving Map<String,Object>; Plan 2 wraps it into a typed ExtractionResult<T>. */
public record ExtractionOutcome(Map<String, Object> data, ExtractionReport report) {
    public ExtractionOutcome {
        Objects.requireNonNull(data, "data");
        Objects.requireNonNull(report, "report");
    }
}
