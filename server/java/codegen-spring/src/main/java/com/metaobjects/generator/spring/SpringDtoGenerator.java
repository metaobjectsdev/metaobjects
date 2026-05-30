package com.metaobjects.generator.spring;

import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
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
import java.util.Iterator;
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
        for (MetaObject entity : loader.getMetaObjects()) {
            if (!MetaObject.SUBTYPE_ENTITY.equals(entity.getSubType())) continue;
            if (com.metaobjects.generator.util.GeneratorUtil.isAbstract(entity)) continue;
            emit(entity, outRoot);
        }
    }

    private void emit(MetaObject entity, Path outRoot) {
        String[] split = SpringNaming.splitFqn(entity.getName());
        String pkg = split[0];
        String shortName = split[1];
        String recordName = shortName + "Dto";

        StringBuilder src = new StringBuilder();
        if (!pkg.isEmpty()) {
            src.append("package ").append(pkg).append(";\n\n");
        }
        src.append("/** GENERATED — wire DTO for ").append(shortName)
           .append(". Do not hand-edit; regenerated from metadata. */\n");
        src.append("public record ").append(recordName).append("(\n");

        // Filter ObjectField — see class javadoc. Same reason as the Kotlin port's
        // KotlinExposedTableGenerator scalar-only filter.
        Iterator<MetaField> it = scalarFields(entity).iterator();
        while (it.hasNext()) {
            MetaField field = it.next();
            String type = SpringTypeMapper.javaTypeName(field);
            src.append("    ").append(type).append(' ').append(field.getName());
            if (it.hasNext()) src.append(',');
            src.append('\n');
        }
        src.append(") {}\n");

        try {
            Path outFile = outRoot.resolve(pkg.replace('.', '/')).resolve(recordName + ".java");
            if (outFile.getParent() != null) Files.createDirectories(outFile.getParent());
            Files.writeString(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + recordName + ".java for entity " + entity.getName() + ": " + e, e);
        }
    }

    /**
     * Return the entity's scalar fields — i.e. every {@link MetaField} that is
     * not an {@link ObjectField}. The {@code field.object} arm is deliberately
     * deferred (see class javadoc).
     */
    private static List<MetaField> scalarFields(MetaObject entity) {
        List<MetaField> out = new ArrayList<>();
        for (MetaField field : entity.getMetaFields()) {
            if (field instanceof ObjectField) continue;
            out.add(field);
        }
        return out;
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
