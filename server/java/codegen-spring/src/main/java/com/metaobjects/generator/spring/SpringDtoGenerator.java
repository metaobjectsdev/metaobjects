package com.metaobjects.generator.spring;

import com.metaobjects.MetaData;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.field.StringField;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.generator.util.GeneratorUtil;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.validator.ArrayValidator;
import com.metaobjects.validator.LengthValidator;
import com.metaobjects.validator.MetaValidator;
import com.metaobjects.validator.NumericValidator;
import com.metaobjects.validator.RegexValidator;
import com.metaobjects.validator.RequiredValidator;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * Generator: one Java 21 {@code record} per {@code object.entity}, used as the
 * request/response body for the matching {@link SpringControllerGenerator}
 * output.
 *
 * <p>The generated DTO record separates wire shape from persistence-entity
 * shape: the consumer's JPA / jOOQ / JDBC entity stays a regular class, and
 * the controller marshals between record + entity through their generated
 * {@code <Entity>Repository} (see {@link SpringRepositoryGenerator}).</p>
 *
 * <p>Field type mapping is centralised in {@link SpringTypeMapper}; wrapped
 * primitives ({@code Long}, not {@code long}) are used so omitted JSON fields
 * deserialise to {@code null}. {@link ObjectField} components are skipped
 * for v1 — the cross-port wire contract permits flattened / jsonb storage,
 * but the Java DTO codepath needs the referenced value-class generated
 * alongside, which is follow-up work paralleling
 * {@code KotlinEntityGenerator}'s {@code field.object} arm.</p>
 *
 * <p>Args:</p>
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 * </ul>
 */
public class SpringDtoGenerator extends MultiFileDirectGeneratorBase<MetaObject> {

    @Override
    protected Class<MetaObject> getFilterClass() {
        return MetaObject.class;
    }

    /** Real work — sidesteps the parent's print-style writer machinery. */
    @Override
    public void execute(MetaDataLoader loader) {
        parseArgs();
        Path outRoot = Paths.get(outDir.getAbsolutePath());
        boolean emitAbstractShapes = Boolean.parseBoolean(getArg("emitAbstractShapes", "false"));
        for (MetaObject entity : loader.getMetaObjects()) {
            if (!MetaObject.SUBTYPE_ENTITY.equals(entity.getSubType())) continue;
            if (GeneratorUtil.isAbstract(entity)) {
                if (emitAbstractShapes) emitAbstractShape(entity, outRoot);
                continue;
            }
            // FR-017 TPH: a discriminator base's DTO carries the UNION of its subtype columns
            // (each folded nullable) so polymorphic + per-subtype endpoints share one wire shape.
            if (TphPlan.isTphBase(entity, loader)) emitTphUnion(entity, loader, outRoot);
            else emit(entity, outRoot);
        }
    }

    /**
     * True iff this generator emits a concrete DTO {@code record} for
     * {@code entity}: any {@code object.entity} that is not {@code abstract}.
     * Unlike the controller/repository, the DTO is emitted for EVERY concrete
     * entity regardless of {@code source.rdb} kind (a view-kind entity still gets
     * a wire DTO). Abstract entities are excluded here — they only get the opt-in
     * interface shape via {@code emitAbstractShape} when the {@code emitAbstractShapes}
     * arg is set, which is a separate emit path, not part of this predicate.
     * Extracted verbatim from the {@link #execute(MetaDataLoader)} concrete-emit guard.
     */
    public static boolean appliesTo(MetaObject entity) {
        if (!MetaObject.SUBTYPE_ENTITY.equals(entity.getSubType())) return false;
        return !GeneratorUtil.isAbstract(entity);
    }

    protected void emit(MetaObject entity, Path outRoot) {
        List<MetaField> fields = scalarFields(entity);
        // Each scalar field carries its full validation (the standard, non-TPH DTO).
        List<String> annotationsPerField = new ArrayList<>(fields.size());
        for (MetaField field : fields) annotationsPerField.add(validationAnnotations(field));
        emitRecord(entity, outRoot, fields, annotationsPerField);
    }

    /**
     * FR-017 TPH: emit the discriminator-base DTO as the UNION of the base's own scalar columns
     * (full validation) plus every subtype-only column (folded NULLABLE — no validation, since a
     * row of any other subtype stores NULL there even when the field is {@code @required}). This
     * single wire shape backs both the polymorphic and per-subtype endpoints of the base controller.
     */
    protected void emitTphUnion(MetaObject base, MetaDataLoader loader, Path outRoot) {
        List<MetaField> fields = new ArrayList<>(scalarFields(base));
        for (MetaField field : TphPlan.collectSubtypeFields(base, loader)) {
            if (field instanceof ObjectField) continue;
            fields.add(field);
        }
        // The TPH union DTO is a partial-PATCH-friendly wire body — every component is a nullable
        // wrapper and carries NO bean-validation (a per-subtype POST/PATCH supplies only its own
        // columns; the single table's column nullability is the real constraint). The controller
        // intentionally omits @Valid, so keeping @NotNull here would be inert + misleading. Matches
        // the Kotlin lane's all-nullable union data class.
        List<String> annotationsPerField = new ArrayList<>(fields.size());
        for (int i = 0; i < fields.size(); i++) annotationsPerField.add("");
        emitRecord(base, outRoot, fields, annotationsPerField);
    }

    /** Shared record emitter: write {@code <Entity>Dto} record from a field + per-field annotation list. */
    private void emitRecord(MetaObject entity, Path outRoot, List<MetaField> fields, List<String> annotationsPerField) {
        String[] split = SpringNaming.splitFqn(entity.getName());
        String pkg = split[0];
        String shortName = split[1];
        String recordName = SpringNaming.dtoName(shortName);

        boolean usesValidation = annotationsPerField.stream().anyMatch(a -> !a.isEmpty());

        StringBuilder src = new StringBuilder();
        if (!pkg.isEmpty()) {
            src.append("package ").append(pkg).append(";\n\n");
        }
        // Wildcard import keeps the emit simple — record components carry a small,
        // closed set of jakarta.validation.constraints annotations.
        if (usesValidation) {
            src.append("import jakarta.validation.constraints.*;\n\n");
        }
        src.append("/** GENERATED — wire DTO for ").append(shortName)
           .append(". Do not hand-edit; regenerated from metadata. */\n");
        src.append("public record ").append(recordName).append("(\n");

        // Filter ObjectField — see class javadoc. Same reason as the Kotlin port's
        // KotlinExposedTableGenerator scalar-only filter.
        for (int i = 0; i < fields.size(); i++) {
            MetaField field = fields.get(i);
            String annotations = annotationsPerField.get(i);
            src.append("    ");
            if (!annotations.isEmpty()) src.append(annotations).append(' ');
            src.append(componentType(field, entity)).append(' ').append(field.getName());
            if (i < fields.size() - 1) src.append(',');
            src.append('\n');
        }

        // Nested `public enum <Name> { <members> }` declarations for this record's enum fields,
        // deduped by enum-type name (two fields extending one abstract enum emit ONE decl) — so
        // the DTO components carry the value-constrained type rather than String (cross-port
        // parity with TS / Python / Kotlin / C#). Emitted INSIDE the record body, mirroring
        // SpringPayloadGenerator.
        List<String> enumDecls = collectEnumDecls(entity, fields);
        if (enumDecls.isEmpty()) {
            src.append(") {}\n");
        } else {
            src.append(") {\n");
            for (String decl : enumDecls) src.append("    ").append(decl).append('\n');
            src.append("}\n");
        }

        writeJavaFile(entity, outRoot, pkg, recordName, src.toString());
    }

    /**
     * Emit the abstract <em>shape</em> for an {@code abstract: true} entity: a
     * Java {@code interface} with one accessor per scalar field. A {@code record}
     * cannot serve as a base type, so the shape is an interface concrete DTO
     * records can later be wired to implement. Only emitted when the
     * {@code emitAbstractShapes} arg is {@code true} (default OFF for Java).
     */
    protected void emitAbstractShape(MetaObject entity, Path outRoot) {
        String[] split = SpringNaming.splitFqn(entity.getName());
        String pkg = split[0];
        String shortName = split[1];
        String typeName = SpringNaming.dtoName(shortName);

        StringBuilder src = new StringBuilder();
        if (!pkg.isEmpty()) {
            src.append("package ").append(pkg).append(";\n\n");
        }
        src.append("/** GENERATED — abstract wire-DTO shape for ").append(shortName)
           .append(". Do not hand-edit; regenerated from metadata. */\n");
        src.append("public interface ").append(typeName).append(" {\n");
        for (MetaField field : scalarFields(entity)) {
            String type = SpringTypeMapper.javaTypeName(field);
            src.append("    ").append(type).append(' ').append(field.getName()).append("();\n");
        }
        src.append("}\n");

        writeJavaFile(entity, outRoot, pkg, typeName, src.toString());
    }

    /**
     * Resolve {@code <outRoot>/<pkg-as-dirs>/<typeName>.java}, create parent
     * directories, and write {@code body}. Shared file-IO tail for both the
     * concrete-record and abstract-interface emit paths.
     */
    protected void writeJavaFile(MetaObject entity, Path outRoot, String pkg, String typeName, String body) {
        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(typeName + ".java");
            if (outFile.getParent() != null) Files.createDirectories(outFile.getParent());
            Files.writeString(outFile, body);
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + typeName + ".java for entity " + entity.getName() + ": " + e, e);
        }
    }

    /**
     * Return the entity's scalar fields — i.e. every {@link MetaField} that is
     * not an {@link ObjectField}. The {@code field.object} arm is deliberately
     * deferred (see class javadoc).
     */
    public static List<MetaField> scalarFields(MetaObject entity) {
        List<MetaField> out = new ArrayList<>();
        for (MetaField field : entity.getMetaFields()) {
            if (field instanceof ObjectField) continue;
            out.add(field);
        }
        return out;
    }

    // === validation (SP-C validator parity) =================================

    /**
     * Java DTO-record component type for {@code field} owned by {@code owner}. A
     * {@code field.enum} is typed as the value-constrained nested Java {@code enum}
     * ({@link SpringTypeMapper#enumTypeName}, single or {@code List<Enum>}) whose declaration
     * {@link #collectEnumDecls} emits inside the record body — parity with the other ports and
     * with {@code SpringPayloadGenerator}. Other scalars delegate to {@link SpringTypeMapper};
     * array fields ({@code isArray=true}) are wrapped as {@code List<elementType>} (the wrapped
     * element type so an omitted JSON element deserialises to {@code null}).
     */
    public static String componentType(MetaField<?> field, MetaObject owner) {
        if (field instanceof EnumField) {
            return SpringTypeMapper.payloadJavaTypeName(field, owner, "");
        }
        String element = SpringTypeMapper.javaTypeName(field);
        return field.isArrayType() ? "java.util.List<" + element + ">" : element;
    }

    /**
     * Collect the nested {@code public enum <Name> { <members> }} declarations for the enum
     * fields in {@code fields} (the record's components), deduped by enum-type name (two fields
     * extending one abstract enum collapse onto ONE decl named for the super). Mirrors
     * {@code SpringPayloadGenerator.collectEnumDecls}.
     */
    private static List<String> collectEnumDecls(MetaObject owner, List<MetaField> fields) {
        List<String> decls = new ArrayList<>();
        java.util.Set<String> seen = new java.util.LinkedHashSet<>();
        for (MetaField<?> field : fields) {
            if (!(field instanceof EnumField ef)) continue;
            String typeName = SpringTypeMapper.enumTypeName(owner, ef);
            if (!seen.add(typeName)) continue; // dedup shared abstract-enum types
            List<String> values = SpringTypeMapper.effectiveEnumValues(ef);
            decls.add("public enum " + typeName + " { " + String.join(", ", values) + " }");
        }
        return decls;
    }

    /**
     * Build the space-joined jakarta.validation annotation string for a record
     * component from the field's constraint metadata — both field attrs
     * ({@code @required}, {@code @maxLength}) and {@code validator.*} children
     * (length / regex / numeric / array). Returns {@code ""} when the field
     * carries no constraints.
     *
     * <p>Cross-port semantics (see the SP-C validator-parity contract):</p>
     * <ul>
     *   <li>required (field {@code @required} or {@code validator.required}) →
     *       {@code @NotNull}, plus {@code @NotBlank} for non-array strings so an
     *       empty string fails too.</li>
     *   <li>{@code validator.length @min} + field {@code @maxLength} →
     *       {@code @Size(min=…, max=…)} (each bound omitted when absent).</li>
     *   <li>{@code validator.regex @pattern} → {@code @Pattern(regexp=…)}.</li>
     *   <li>{@code validator.numeric @min/@max} → {@code @Min(…)} / {@code @Max(…)}.</li>
     *   <li>{@code validator.array @min/@max} → {@code @Size(min=…, max=…)} on the {@code List}.</li>
     * </ul>
     */
    public static String validationAnnotations(MetaField<?> field) {
        boolean isArray = field.isArrayType();
        boolean isString = field instanceof StringField;
        List<String> out = new ArrayList<>();

        boolean required = attrBool(field, MetaField.ATTR_REQUIRED) || hasValidator(field, RequiredValidator.class);
        if (required) {
            out.add("@NotNull");
            if (isString && !isArray) out.add("@NotBlank");
        }

        // String length: combine validator.length @min with the field-level @maxLength cap.
        Integer lengthMin = null;
        Integer lengthMax = null;
        LengthValidator length = validator(field, LengthValidator.class);
        if (length != null) {
            lengthMin = attrInt(length, LengthValidator.ATTR_MIN);
            lengthMax = attrInt(length, LengthValidator.ATTR_MAX);
        }
        Integer fieldMaxLength = attrInt(field, StringField.ATTR_MAX_LENGTH);
        if (fieldMaxLength != null) {
            lengthMax = fieldMaxLength;
        }
        if (lengthMin != null || lengthMax != null) {
            out.add(sizeAnnotation(lengthMin, lengthMax));
        }

        // Regex pattern.
        RegexValidator regex = validator(field, RegexValidator.class);
        if (regex != null) {
            String pattern = regex.resolvePattern();
            if (pattern != null) {
                out.add("@Pattern(regexp = \"" + escapeJavaString(pattern) + "\")");
            }
        }

        // Numeric value bounds.
        NumericValidator numeric = validator(field, NumericValidator.class);
        if (numeric != null) {
            Integer min = attrInt(numeric, NumericValidator.ATTR_MIN);
            Integer max = attrInt(numeric, NumericValidator.ATTR_MAX);
            if (min != null) out.add("@Min(" + min + ")");
            if (max != null) out.add("@Max(" + max + ")");
        }

        // Array element-count bounds → @Size on the List component.
        ArrayValidator array = validator(field, ArrayValidator.class);
        if (array != null) {
            Integer min = attrInt(array, ArrayValidator.ATTR_MIN);
            Integer max = attrInt(array, ArrayValidator.ATTR_MAX);
            if (min != null || max != null) {
                out.add(sizeAnnotation(min, max));
            }
        }

        return String.join(" ", out);
    }

    protected static String sizeAnnotation(Integer min, Integer max) {
        StringBuilder b = new StringBuilder("@Size(");
        boolean wrote = false;
        if (min != null) { b.append("min = ").append(min); wrote = true; }
        if (max != null) { if (wrote) b.append(", "); b.append("max = ").append(max); }
        return b.append(')').toString();
    }

    // --- metadata read helpers ----------------------------------------------

    protected static boolean attrBool(MetaField<?> field, String attr) {
        if (!field.hasMetaAttr(attr)) return false;
        Object raw = field.getMetaAttr(attr).getValue();
        if (raw instanceof Boolean b) return b;
        return Boolean.parseBoolean(String.valueOf(raw));
    }

    /** Read an int-valued attr from a node, trying each name in order; {@code null} when absent. */
    protected static Integer attrInt(MetaData node, String... attrNames) {
        for (String attr : attrNames) {
            if (node.hasMetaAttr(attr)) {
                try {
                    return Integer.valueOf(node.getMetaAttr(attr).getValueAsString().trim());
                } catch (NumberFormatException ignore) {
                    return null;
                }
            }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static <V extends MetaValidator> V validator(MetaField<?> field, Class<V> type) {
        for (MetaData child : field.getChildren()) {
            if (type.isInstance(child)) return (V) child;
        }
        return null;
    }

    protected static boolean hasValidator(MetaField<?> field, Class<? extends MetaValidator> type) {
        return validator(field, type) != null;
    }

    /** Escape a regex/string literal for safe embedding in generated Java source. */
    protected static String escapeJavaString(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    // === MultiFileDirectGeneratorBase abstract-method stubs ====================
    // Whole files are written in execute(); the parent's print-writer pipeline is unused.
    @Override
    protected void writeSingleFile(MetaObject md, GeneratorIOWriter<?> writer) { /* unused */ }

    @Override
    @SuppressWarnings({ "unchecked", "rawtypes" })
    protected <T extends GeneratorIOWriter> T getSingleWriter(
            MetaDataLoader loader, MetaObject md, PrintWriter pw) {
        return null;
    }

    @Override
    @SuppressWarnings({ "unchecked", "rawtypes" })
    protected <T extends GeneratorIOWriter> T getFinalWriter(
            MetaDataLoader loader, OutputStream out) {
        return null;
    }

    @Override
    protected void writeFinalFile(Collection<MetaObject> metadata, GeneratorIOWriter<?> writer) { /* none */ }

    @Override
    protected String getSingleOutputFilePath(MetaObject md) {
        return SpringNaming.splitFqn(md.getName())[0].replace('.', '/');
    }

    @Override
    protected String getSingleOutputFilename(MetaObject md) {
        return SpringNaming.splitFqn(md.getName())[1] + "Dto.java";
    }
}
