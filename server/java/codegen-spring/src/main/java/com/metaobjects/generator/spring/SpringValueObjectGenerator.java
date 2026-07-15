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
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Deque;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Generator: one Java 21 {@code record} per {@code object.value} reachable from an
 * entity / projection's value-object jsonb column ({@code field.object @objectRef=<value>
 * @storage:jsonb}, single or {@code @isArray}), transitively through nested value-object
 * members. The emitted record is the strongly-typed component the matching
 * {@code <Entity>Dto} / {@code <Entity>Patch} bind to (see {@link SpringDtoGenerator}), so a
 * VO column POSTs and PATCHes with full nested validation (Program D).
 *
 * <p>Distinct from {@link SpringPayloadGenerator} (which emits {@code <Template>Payload}
 * records for the prompt / LLM surface): this emitter is wired into the entity request /
 * response path, so — unlike a plain payload record — its record carries jakarta
 * bean-validation constraints on each member (reusing
 * {@link SpringDtoGenerator#validationAnnotations(MetaField)}) plus {@code @Valid} on any
 * nested value-object member, so {@code validator.validate(bean)} cascades to depth &ge; 2
 * (spec section 0). The record name is the value object's short name (e.g. {@code Marker}),
 * emitted into the value object's own Java package — the same package as the consuming DTO,
 * so a same-package reference resolves; {@link SpringTypeMapper} references it fully-qualified
 * regardless.</p>
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
        for (MetaObject vo : reachableValueObjects(loader)) {
            emit(vo, outRoot);
        }
    }

    /**
     * The {@code object.value} objects reachable from any concrete entity / projection's
     * value-object jsonb column, expanded transitively through nested value-object members.
     * Deterministic (insertion-ordered). A payload-only value object (referenced solely by a
     * {@code template.@payloadRef}) is NOT reached here — that surface is
     * {@link SpringPayloadGenerator}'s {@code <Template>Payload}.
     */
    static Set<MetaObject> reachableValueObjects(MetaDataLoader loader) {
        Set<MetaObject> out = new LinkedHashSet<>();
        Deque<MetaObject> queue = new ArrayDeque<>();
        for (MetaObject obj : loader.getMetaObjects()) {
            if (GeneratorUtil.isAbstract(obj)) continue;
            if (!MetaObject.SUBTYPE_ENTITY.equals(obj.getSubType())
                    && !MetaObject.SUBTYPE_PROJECTION.equals(obj.getSubType())) continue;
            for (MetaField field : obj.getMetaFields()) {
                MetaObject vo = SpringDtoGenerator.valueObjectRefOf(field);
                if (vo != null && out.add(vo)) queue.add(vo);
            }
        }
        while (!queue.isEmpty()) {
            MetaObject vo = queue.poll();
            for (MetaField field : vo.getMetaFields()) {
                MetaObject nested = SpringDtoGenerator.valueObjectRefOf(field);
                if (nested != null && out.add(nested)) queue.add(nested);
            }
        }
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
            if (SpringDtoGenerator.isValueObjectJsonbField(field)) {
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
        for (int i = 0; i < fields.size(); i++) {
            MetaField field = fields.get(i);
            String a = annotations.get(i);
            src.append("    ");
            if (!a.isEmpty()) src.append(a).append(' ');
            src.append(SpringDtoGenerator.componentType(field, vo)).append(' ').append(field.getName());
            if (i < fields.size() - 1) src.append(',');
            src.append('\n');
        }
        List<String> enumDecls = collectEnumDecls(vo, fields);
        if (enumDecls.isEmpty()) {
            src.append(") {}\n");
        } else {
            src.append(") {\n");
            for (String decl : enumDecls) src.append("    ").append(decl).append('\n');
            src.append("}\n");
        }

        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(recordName + ".java");
            if (outFile.getParent() != null) Files.createDirectories(outFile.getParent());
            Files.writeString(outFile, src.toString());
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
