package com.metaobjects.render.recover;

/** FROZEN cross-port per-field recovery classification. Do not reorder or add without an ADR. */
public enum FieldRecovery {
    RECOVERED,
    // FR-011: a value reached via @coerceDefault (present-but-uncoercible fallback) or
    // @default (absent-fill). Classified by Recover via the terminal coercion kind.
    DEFAULTED,
    LOST_OPTIONAL,
    LOST_REQUIRED,
    MALFORMED
}
