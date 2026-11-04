package com.metaobjects.config;

import com.metaobjects.MetaData;
import com.metaobjects.MetaRoot;

/**
 * The project's enum storage defaults: {@code enums} in {@code .metaobjects/config.json}.
 * {@code maxLength} is the column length (VARCHAR(n)) of a string-stored {@code field.enum}
 * that declares no {@code @maxLength}; absent means no default (an unbounded text column).
 * Carried on the loaded root beside the naming rules. Mirrors TS {@code enum-length.ts}.
 */
public final class EnumDefaults {

    /** No project default. */
    public static final EnumDefaults DEFAULT = new EnumDefaults(null);

    private final Long maxLength;

    public EnumDefaults(Long maxLength) {
        this.maxLength = maxLength;
    }

    /** The default column length, or {@code null} when the project declares none. */
    public Long getMaxLength() {
        return maxLength;
    }

    /** The enum defaults for the tree {@code node} belongs to: what its root carries, else none. */
    public static EnumDefaults of(MetaData node) {
        for (MetaData n = node; n != null; n = n.getParent()) {
            if (n instanceof MetaRoot root) return root.getEnumDefaults();
        }
        return DEFAULT;
    }
}
