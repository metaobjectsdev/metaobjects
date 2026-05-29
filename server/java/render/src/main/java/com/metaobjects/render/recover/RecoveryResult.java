package com.metaobjects.render.recover;

import java.util.Objects;

/** Typed result of a generated recover(...): best-effort record (null components where lost/malformed) + report. */
public record RecoveryResult<T>(T data, RecoveryReport report) {
    public RecoveryResult {
        Objects.requireNonNull(report, "report");
    }
}
