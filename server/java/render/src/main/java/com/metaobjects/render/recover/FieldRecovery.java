package com.metaobjects.render.recover;

/** FROZEN cross-port per-field recovery classification. Do not reorder or add without an ADR. */
public enum FieldRecovery { RECOVERED, DEFAULTED, LOST_OPTIONAL, LOST_REQUIRED, MALFORMED }
