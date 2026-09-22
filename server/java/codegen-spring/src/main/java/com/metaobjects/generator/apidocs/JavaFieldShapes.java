package com.metaobjects.generator.apidocs;

import com.metaobjects.MetaData;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.MetaField;
import com.metaobjects.generator.spring.SpringDtoGenerator;
import com.metaobjects.generator.spring.SpringNaming;
import com.metaobjects.generator.spring.SpringTypeMapper;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.template.MetaTemplate;
import com.metaobjects.util.MetaDataUtil;

import java.util.ArrayList;
import java.util.List;

/**
 * Derives {@link FieldShape} lists for the api-docs IR by REUSING the real
 * Spring generators' field logic — never re-implementing a type mapping or an
 * optionality rule. This keeps the documented field shapes drift-proof: the same
 * methods that decide what the generated DTO record component / payload record
 * component looks like decide what gets documented.
 *
 * <h2>DTO field shapes</h2>
 * {@link #dtoFields(MetaObject)} iterates the exact same scalar fields the DTO
 * generator emits ({@link SpringDtoGenerator#scalarFields(MetaObject)} — skips
 * {@code ObjectField}), and for each field:
 * <ul>
 *   <li><b>type</b> = {@link SpringDtoGenerator#componentType(MetaField, MetaObject)} (the
 *       DTO record component type, incl. the value-constrained enum + {@code List<…>} for arrays).</li>
 *   <li><b>optional</b> = derived from
 *       {@link SpringDtoGenerator#validationAnnotations(MetaField)}: a field is
 *       <em>required</em> (optional=false) iff its annotation string contains
 *       {@code @NotNull} or {@code @NotBlank}; otherwise optional=true.</li>
 *   <li><b>note</b> = for {@link EnumField}, the allowed values (effective
 *       {@code @values}); otherwise {@code null}.</li>
 * </ul>
 *
 * <h2>Payload field shapes</h2>
 * A template's payload and a responding prompt's reply are the value object's own record
 * ({@link com.metaobjects.generator.spring.SpringValueObjectGenerator}, ADR-0056), so
 * {@link #payloadFieldsOf(MetaObject, MetaDataLoader)} documents that record with the SAME
 * rules the record generator uses: <b>type</b> =
 * {@link SpringDtoGenerator#componentType(MetaField, MetaObject)}; <b>optional</b> unless the
 * component carries {@code @NotNull} / {@code @NotBlank}
 * ({@link SpringDtoGenerator#validationAnnotations(MetaField)}); enum notes carry the allowed
 * values.
 */
public final class JavaFieldShapes {

    private JavaFieldShapes() { /* no instances */ }

    /**
     * The DTO record's documented field shapes for {@code entity}: one
     * {@link FieldShape} per component field the {@link SpringDtoGenerator} emits —
     * scalars PLUS value-object jsonb columns (Program D), matching the record's own
     * {@link SpringDtoGenerator#dtoComponentFields} iteration. Reuses the generator's
     * component-type mapping and validation-annotation derivation so the docs can't
     * drift from the record (a @required VO column shows @NotNull → required).
     */
    public static List<FieldShape> dtoFields(MetaObject entity) {
        List<FieldShape> out = new ArrayList<>();
        for (MetaField field : SpringDtoGenerator.dtoComponentFields(entity)) {
            String type = SpringDtoGenerator.componentType(field, entity);
            String annotations = SpringDtoGenerator.validationAnnotations(field);
            // Required iff the DTO component carries @NotNull or @NotBlank — read
            // straight from the generator's own annotation string (drift-proof).
            boolean required = annotations.contains("@NotNull") || annotations.contains("@NotBlank");
            out.add(new FieldShape(field.getName(), type, !required, enumNote(field)));
        }
        return out;
    }

    /**
     * The documented field shapes of a template's {@code @payloadRef} value object — see
     * {@link #payloadFieldsOf(MetaObject, MetaDataLoader)}. Empty when the template carries no
     * resolvable payload (defensive — callers gate on a resolvable ref first).
     */
    public static List<FieldShape> payloadFields(MetaData template, MetaDataLoader loader) {
        if (!(template instanceof MetaTemplate tmpl)) return List.of();
        String payloadRef = tmpl.getPayloadRef();
        if (payloadRef == null || payloadRef.isEmpty()) return List.of();
        MetaObject vo = SpringNaming.resolveValueObjectRef(
            loader, payloadRef, MetaDataUtil.findPackageForMetaData(tmpl));
        if (vo == null) return List.of();
        return payloadFieldsOf(vo, loader);
    }

    /**
     * The documented field shapes of a value object's record — the type a template renders as
     * its payload, or a responding prompt parses its reply into. Uses the record generator's own
     * component typing and validation derivation, so the docs cannot drift from the record.
     */
    public static List<FieldShape> payloadFieldsOf(MetaObject vo, MetaDataLoader loader) {
        if (vo == null) return List.of();
        List<FieldShape> out = new ArrayList<>();
        for (MetaField field : vo.getMetaFields()) {
            String type = SpringDtoGenerator.componentType(field, vo);
            String annotations = SpringDtoGenerator.validationAnnotations(field);
            boolean required = annotations.contains("@NotNull") || annotations.contains("@NotBlank");
            out.add(new FieldShape(field.getName(), type, !required, enumNote(field)));
        }
        return out;
    }

    /** Allowed-values note for an {@link EnumField} ({@code "ACTIVE | RETIRED"}); {@code null} otherwise. */
    private static String enumNote(MetaField<?> field) {
        if (!(field instanceof EnumField ef)) return null;
        List<String> values = SpringTypeMapper.effectiveEnumValues(ef);
        if (values.isEmpty()) return null;
        return "allowed: " + String.join(" | ", values);
    }
}
