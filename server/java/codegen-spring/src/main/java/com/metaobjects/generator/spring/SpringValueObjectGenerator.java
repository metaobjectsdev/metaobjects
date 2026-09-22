package com.metaobjects.generator.spring;

import com.metaobjects.field.EnumField;
import com.metaobjects.field.MetaField;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.generator.util.GeneratorUtil;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import com.metaobjects.generator.util.GeneratedFileWriter;

/**
 * Generator: one Java 21 {@code record} per value shape — every concrete {@code object.value},
 * and every concrete SOURCELESS {@code object.projection} (#210: pure shape, a legal template
 * payload target). It is THE Java type for that value object (ADR-0056), used everywhere:
 * <ul>
 *   <li>the entity tier — the component a {@code <Entity>Dto} / {@code <Entity>Patch} binds a
 *       value-object jsonb column to ({@link SpringDtoGenerator}), so a VO column POSTs and
 *       PATCHes with full nested validation (Program D);</li>
 *   <li>the template tier — a template's {@code @payloadRef} payload and a responding prompt's
 *       {@code @responseRef} reply ({@link SpringRenderHelperGenerator},
 *       {@link SpringOutputParserGenerator}), which declare no record of their own.</li>
 * </ul>
 *
 * <p>Its record carries jakarta bean-validation constraints on each member (reusing
 * {@link SpringDtoGenerator#validationAnnotations(MetaField)}) plus {@code @Valid} on any nested
 * value-object member, so {@code validator.validate(bean)} cascades to depth &ge; 2 (spec section
 * 0). The record name is the value object's short name (e.g. {@code Marker}), emitted into the
 * value object's own Java package; {@link SpringTypeMapper} and the template tier reference it
 * fully-qualified.</p>
 *
 * <p>Emitting for every value shape, not only the ones an entity reaches, is what lets the template
 * tier drop its own copies: the old per-template {@code <Template>Payload} family was written into
 * each template's {@code prompts} package, and a value object shared across packages landed in only
 * one of them (#387).</p>
 *
 * <p>Args:</p>
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 * </ul>
 */
public class SpringValueObjectGenerator extends MultiFileDirectGeneratorBase<MetaObject> {

    @Override
    protected Class<MetaObject> getFilterClass() {
        return MetaObject.class;
    }

    @Override
    public void execute(MetaDataLoader loader) {
        parseArgs();
        Path outRoot = Paths.get(outDir.getAbsolutePath());
        for (MetaObject vo : valueShapes(loader)) {
            emit(vo, outRoot);
        }
    }

    /**
     * Every value shape this generator emits a record for: each concrete {@code object.value},
     * and each concrete sourceless {@code object.projection}. Sorted by FQN, so emission is
     * deterministic whatever the load order.
     */
    static List<MetaObject> valueShapes(MetaDataLoader loader) {
        List<MetaObject> out = new ArrayList<>();
        for (MetaObject obj : loader.getMetaObjects()) {
            if (GeneratorUtil.isAbstract(obj)) continue;
            // #210 — value, or SOURCELESS projection (ADR-0039: a source anywhere in the
            // extends chain binds it to a backing store, and then its type is the entity
            // tier's DTO, not a value record). The same predicate the template tier's
            // @payloadRef resolution applies.
            if (SpringNaming.isLegalPayloadTarget(obj)) out.add(obj);
        }
        out.sort(java.util.Comparator.comparing(MetaObject::getName));
        return out;
    }

    private void emit(MetaObject vo, Path outRoot) {
        String[] split = SpringNaming.splitFqn(vo.getName());
        String pkg = split[0];
        String recordName = split[1];

        List<MetaField> fields = new ArrayList<>(vo.getMetaFields());
        List<String> annotations = new ArrayList<>(fields.size());
        boolean usesValidation = false;
        boolean usesValid = false;
        for (MetaField field : fields) {
            String a = SpringDtoGenerator.validationAnnotations(field);
            // valueObjectRefOf, not isValueObjectJsonbField: it spans BOTH shapes that carry a
            // value object (field.object @objectRef and field.map @objectRef). The entity DTO
            // cascades into a map of value objects; a VO nesting the same shape must too, or
            // the nested constraints go unenforced one level down.
            if (SpringDtoGenerator.valueObjectRefOf(field) != null) {
                a = a.isEmpty() ? "@Valid" : "@Valid " + a;
                usesValid = true;
            }
            if (!a.isEmpty()) usesValidation = true;
            annotations.add(a);
        }

        StringBuilder src = new StringBuilder();
        if (!pkg.isEmpty()) {
            src.append("package ").append(pkg).append(";\n\n");
        }
        if (usesValid) {
            src.append("import jakarta.validation.Valid;\n");
        }
        if (usesValidation) {
            src.append("import jakarta.validation.constraints.*;\n");
        }
        if (usesValid || usesValidation) {
            src.append('\n');
        }
        src.append("/** GENERATED — value object ").append(recordName)
           .append(". Do not hand-edit; regenerated from metadata. */\n");
        src.append("public record ").append(recordName).append("(\n");
        List<String[]> components = new ArrayList<>(fields.size());
        for (int i = 0; i < fields.size(); i++) {
            MetaField field = fields.get(i);
            String a = annotations.get(i);
            String type = SpringDtoGenerator.componentType(field, vo);
            // A field named notify/wait/toString/… cannot BE a record component (JLS 8.10.3),
            // so it is escaped here and pinned back to its declared name on the wire.
            String component = SpringNaming.recordComponentName(field.getName());
            String jsonName = SpringNaming.jsonPropertyAnnotation(field.getName());
            src.append("    ");
            if (!a.isEmpty()) src.append(a).append(' ');
            if (!jsonName.isEmpty()) src.append(jsonName).append(' ');
            src.append(type).append(' ').append(component);
            if (i < fields.size() - 1) src.append(',');
            src.append('\n');
            components.add(new String[] { type, component });
        }
        List<String> enumDecls = collectEnumDecls(vo, fields);
        // A value object is constructed by its caller, so it carries the Java builder (#365).
        String builder = SpringRecordBuilder.members(recordName, components);
        if (enumDecls.isEmpty() && builder.isEmpty()) {
            src.append(") {}\n");
        } else {
            src.append(") {\n");
            for (String decl : enumDecls) src.append("    ").append(decl).append('\n');
            src.append(builder);
            src.append("}\n");
        }

        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(recordName + ".java");
            GeneratedFileWriter.write(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing value object " + recordName + ".java for " + vo.getName() + ": " + e, e);
        }
    }

    /**
     * Nested {@code public enum <Name> { <members> }} declarations for the value object's inline
     * enum members, deduped by enum-type name — mirrors {@link SpringDtoGenerator}'s record body.
     * A VO with no enum members yields an empty list (the common case).
     */
    private static List<String> collectEnumDecls(MetaObject owner, List<MetaField> fields) {
        Set<String> seen = new LinkedHashSet<>();
        List<String> decls = new ArrayList<>();
        for (MetaField<?> field : fields) {
            if (!(field instanceof EnumField ef)) continue;
            List<String> values = SpringTypeMapper.effectiveEnumValues(ef);
            if (values.isEmpty()) continue;
            String typeName = SpringTypeMapper.enumTypeName(owner, ef);
            if (!seen.add(typeName)) continue;
            decls.add("public enum " + typeName + " { " + String.join(", ", values) + " }");
        }
        return decls;
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
        return SpringNaming.splitFqn(md.getName())[1] + ".java";
    }
}
