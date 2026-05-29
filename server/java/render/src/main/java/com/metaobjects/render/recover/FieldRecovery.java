package com.metaobjects.render.recover;

/** FROZEN cross-port per-field recovery classification. Do not reorder or add without an ADR. */
public enum FieldRecovery {
    RECOVERED,
    // DEFAULTED is reserved (a future @default-backed value); the current engine does not emit it.
    DEFAULTED,
    LOST_OPTIONAL,
    LOST_REQUIRED,
    MALFORMED
}
