package com.metaobjects.render.extract;

/** FROZEN cross-port per-field extraction classification. Do not reorder or add without an ADR. */
public enum FieldExtraction {
    EXTRACTED,
    // FR-011: a value reached via @coerceDefault (present-but-uncoercible fallback) or
    // @default (absent-fill). Classified by Extract via the terminal coercion kind.
    DEFAULTED,
    LOST_OPTIONAL,
    LOST_REQUIRED,
    MALFORMED
}
