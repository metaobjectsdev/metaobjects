package com.metaobjects.render.extract;

/** STRICT: case-sensitive, minimal repair. NORMAL: case-insensitive keys/tags (default). LOOSE: maximal repair. */
public enum Tolerance {
    STRICT,
    NORMAL,
    // NOTE: LOOSE currently behaves identically to NORMAL (case-insensitive). Reserved for future maximal-repair behavior.
    LOOSE
}
