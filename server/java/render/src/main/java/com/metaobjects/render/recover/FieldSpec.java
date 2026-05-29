package com.metaobjects.render.recover;

import java.util.List;
import java.util.Map;

/**
 * One field's recover descriptor. enumValues/enumAlias non-null only for ENUM;
 * min/max non-null only for numeric range constraints; nested non-null only for OBJECT.
 */
public record FieldSpec(
        String name,
        FieldKind kind,
        boolean required,
        boolean array,
        List<String> enumValues,
        Map<String, String> enumAlias,
        Double min,
        Double max,
        RecoverSchema nested) {

    public static FieldSpec scalar(String name, FieldKind kind, boolean required) {
        return new FieldSpec(name, kind, required, false, null, null, null, null, null);
    }

    public static FieldSpec enumField(String name, boolean required,
                                      List<String> values, Map<String, String> aliases) {
        return new FieldSpec(name, FieldKind.ENUM, required, false,
                values == null ? null : List.copyOf(values),
                aliases == null ? Map.of() : Map.copyOf(aliases),
                null, null, null);
    }

    public static FieldSpec range(String name, FieldKind kind, boolean required,
                                  Double min, Double max) {
        return new FieldSpec(name, kind, required, false, null, null, min, max, null);
    }

    public static FieldSpec object(String name, boolean required, boolean array, RecoverSchema nested) {
        return new FieldSpec(name, FieldKind.OBJECT, required, array, null, null, null, null, nested);
    }
}
