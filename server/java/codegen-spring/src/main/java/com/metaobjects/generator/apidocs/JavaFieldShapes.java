package com.metaobjects.generator.apidocs;

import com.metaobjects.MetaData;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.MetaField;
import com.metaobjects.generator.spring.SpringDtoGenerator;
import com.metaobjects.generator.spring.SpringPayloadGenerator;
import com.metaobjects.generator.spring.SpringTypeMapper;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.template.MetaTemplate;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

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
 *   <li><b>type</b> = {@link SpringDtoGenerator#componentType(MetaField)} (the
 *       DTO record component type, incl. {@code List<…>} for arrays).</li>
 *   <li><b>optional</b> = derived from
 *       {@link SpringDtoGenerator#validationAnnotations(MetaField)}: a field is
 *       <em>required</em> (optional=false) iff its annotation string contains
 *       {@code @NotNull} or {@code @NotBlank}; otherwise optional=true.</li>
 *   <li><b>note</b> = for {@link EnumField}, the allowed values (effective
 *       {@code @values}); otherwise {@code null}.</li>
 * </ul>
 *
 * <h2>Payload field shapes</h2>
 * {@link #payloadFields(MetaData, MetaDataLoader)} resolves the template's
 * {@code @payloadRef} value-object and maps each of its fields via
 * {@link SpringPayloadGenerator#resolveFieldType} (the same per-field type
 * resolution the payload generator uses, incl. origin.passthrough / aggregate /
 * collection and enums). Optionality mirrors the payload generator's nullable
 * rule: a field is optional iff the generator would emit a {@code hasXxx()}
 * helper for it ({@link SpringPayloadGenerator#hasHelperBody(String, String)}
 * returns non-null) — i.e. String / List / reference types are optional, bare
 * primitive scalars are not. Enum notes carry the allowed values.
 */
public final class JavaFieldShapes {

    private JavaFieldShapes() { /* no instances */ }

    /**
     * The DTO record's documented field shapes for {@code entity}: one
     * {@link FieldShape} per scalar field the {@link SpringDtoGenerator} emits.
     * Reuses the generator's scalar-field iteration, component-type mapping, and
     * validation-annotation derivation so the docs can't drift from the record.
     */
    public static List<FieldShape> dtoFields(MetaObject entity) {
        List<FieldShape> out = new ArrayList<>();
        for (MetaField field : SpringDtoGenerator.scalarFields(entity)) {
            String type = SpringDtoGenerator.componentType(field);
            String annotations = SpringDtoGenerator.validationAnnotations(field);
            // Required iff the DTO component carries @NotNull or @NotBlank — read
            // straight from the generator's own annotation string (drift-proof).
            boolean required = annotations.contains("@NotNull") || annotations.contains("@NotBlank");
            out.add(new FieldShape(field.getName(), type, !required, enumNote(field)));
        }
        return out;
    }

    /**
     * The payload record's documented field shapes for {@code template}: one
     * {@link FieldShape} per field of the resolved {@code @payloadRef}
     * value-object, typed via {@link SpringPayloadGenerator#resolveFieldType}.
     * Returns an empty list when the template carries no resolvable payload VO
     * (defensive — callers normally gate on
     * {@link SpringPayloadGenerator#appliesTo(MetaData, MetaDataLoader)} first).
     *
     * <p>The payload generator's {@code resolveFieldType} may recursively emit
     * nested payload records to disk as a side effect (origin.collection /
     * field.object arms). Since this is a docs-derivation path, those writes are
     * directed to a throwaway temp directory so the real output tree is never
     * touched.</p>
     */
    public static List<FieldShape> payloadFields(MetaData template, MetaDataLoader loader) {
        if (!(template instanceof MetaTemplate tmpl)) return List.of();
        String payloadRef = tmpl.getPayloadRef();
        if (payloadRef == null || payloadRef.isEmpty()) return List.of();
        MetaObject vo = SpringPayloadGenerator.resolveValueObject(loader, payloadRef);
        if (vo == null) return List.of();

        SpringPayloadGenerator gen = new SpringPayloadGenerator();
        Path scratch = scratchDir();
        Set<String> emittedNestedFqns = new HashSet<>();
        String[] split = com.metaobjects.generator.spring.SpringNaming.splitFqn(tmpl.getName());
        String nestedPkg = com.metaobjects.generator.spring.SpringNaming
            .promptsPackage(split[0]);

        List<FieldShape> out = new ArrayList<>();
        for (MetaField field : vo.getMetaFields()) {
            String type = gen.resolveFieldType(field, vo, loader, nestedPkg, scratch, emittedNestedFqns);
            // Optional iff the payload generator would emit a hasXxx() helper for
            // this component (String / List / reference → optional; bare scalar
            // primitive → not). Mirror that determination exactly.
            boolean optional = SpringPayloadGenerator.hasHelperBody(type, field.getName()) != null;
            out.add(new FieldShape(field.getName(), type, optional, enumNote(field)));
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

    /** A throwaway directory for the payload generator's nested-record side-effect writes. */
    private static Path scratchDir() {
        try {
            return Files.createTempDirectory("apidocs-payload-scratch");
        } catch (Exception e) {
            // Fall back to the JVM temp dir root; the generator only writes nested
            // payloads here when the payload VO actually has nested arms.
            return Path.of(System.getProperty("java.io.tmpdir"));
        }
    }
}
