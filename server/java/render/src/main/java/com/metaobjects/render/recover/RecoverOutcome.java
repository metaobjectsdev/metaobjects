package com.metaobjects.render.recover;

import java.util.Map;
import java.util.Objects;

/** Engine return. data is a forgiving Map<String,Object>; Plan 2 wraps it into a typed RecoveryResult<T>. */
public record RecoverOutcome(Map<String, Object> data, RecoveryReport report) {
    public RecoverOutcome {
        Objects.requireNonNull(data, "data");
        Objects.requireNonNull(report, "report");
    }
}
