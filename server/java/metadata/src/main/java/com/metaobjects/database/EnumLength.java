package com.metaobjects.database;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.config.EnumDefaults;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.MetaField;
import com.metaobjects.object.MetaObject;
import com.metaobjects.util.ErrorMessageConstants;

import java.util.List;

/**
 * The column length of a string-stored {@code field.enum}: its {@code @maxLength}, else the
 * project's {@code enums.maxLength}, else none (an unbounded text column). Mirrors TS
 * {@code resolveEnumMaxLength}.
 */
public final class EnumLength {

    private EnumLength() {}

    /**
     * The column length of {@code field}, a string-stored {@code field.enum}: its
     * {@code @maxLength} (ADR-0039 — resolving), else the project default, else {@code null}.
     * {@code null} for an {@code @intValueMap} enum, whose column is an integer, and for any
     * other field.
     *
     * <p>The loader refuses an {@code @maxLength} a member does not fit; it does not see the
     * project config, so a member longer than the project DEFAULT is refused here
     * ({@code ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH}), by every consumer that sizes the column.</p>
     */
    public static Long resolveMaxLength(MetaField<?> field) {
        if (!(field instanceof EnumField) || field.hasMetaAttr(EnumField.ATTR_INT_VALUE_MAP)) return null;
        if (field.hasMetaAttr(EnumField.ATTR_MAX_LENGTH)) {
            Object own = field.getMetaAttr(EnumField.ATTR_MAX_LENGTH).getValue();
            if (own instanceof Number n) return n.longValue();
        }
        Long fallback = EnumDefaults.of(field).getMaxLength();
        if (fallback == null) return null;
        String longest = null;
        Object raw = field.hasMetaAttr(EnumField.ATTR_VALUES)
            ? field.getMetaAttr(EnumField.ATTR_VALUES).getValue() : null;
        if (raw instanceof List<?> values) {
            for (Object o : values) {
                String v = String.valueOf(o);
                if (longest == null || v.length() > longest.length()) longest = v;
            }
        }
        if (longest != null && longest.length() > fallback) {
            MetaData owner = field.getParent();
            String label = owner instanceof MetaObject o
                ? o.getShortName() + "." + field.getShortName() : field.getShortName();
            throw new MetaDataException(
                ErrorMessageConstants.ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH
                    + ": field.enum \"" + label + "\" has the member \"" + longest + "\" ("
                    + longest.length() + " characters), longer than the project's enums.maxLength "
                    + fallback + ". Give the field its own @maxLength of at least " + longest.length()
                    + ", raise enums.maxLength, or shorten the member.",
                ErrorCode.ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH);
        }
        return fallback;
    }
}
