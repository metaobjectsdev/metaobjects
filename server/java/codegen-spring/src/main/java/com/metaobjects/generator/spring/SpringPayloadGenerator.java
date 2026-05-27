package com.metaobjects.generator.spring;

import com.metaobjects.MetaData;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.template.MetaTemplate;
import com.metaobjects.template.TemplateConstants;

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
 * Generator: one {@code <TemplateShortName>Payload} Java record per
 * {@code template.output} declaration, derived from the template's
 * {@code @payloadRef} {@link MetaObject#SUBTYPE_VALUE} object's field tree.
 *
 * <p>The emitted record is the typed wire shape that
 * {@link SpringOutputParserGenerator}'s parser returns. Idiomatic Spring
 * convention: a Java 21 record with no annotations — Jackson handles
 * deserialization positionally + by name without {@code @JsonProperty}
 * decoration when field names match.
 *
 * <p>FR-006 — the Java port of the cross-language template-output payload
 * codegen. See {@code docs/superpowers/specs/2026-05-25-fr6-template-output-parser-codegen.md}
 * and ADR-0010 for the cross-port contract; this is the Spring-flavoured
 * sibling of TS's {@code generatePayloadInterfaces()}, C#'s
 * {@code PayloadCodegen}, Kotlin's {@code KotlinPayloadGenerator}, and
 * Python's payload module.
 *
 * <p>Output package mirrors Kotlin: {@code <entity-pkg>.prompts} when the
 * template lives under a package (so {@code acme::ai::NpcResponseOutput}
 * lands in {@code acme.ai.prompts.NpcResponseOutputPayload}), and the
 * bare {@code prompts} package when no metadata package is set.
 *
 * <p>Skips and defensive cases:
 * <ul>
 *   <li>{@code template.prompt} is ignored — only outputs need a payload
 *       record in the codegen-spring pipeline. (Prompt-side codegen is the
 *       render layer's job; this is the parse-on-receipt sibling.)</li>
 *   <li>Missing {@code @payloadRef} — skipped (loader's validation pass
 *       normally rejects this first; defensive only).</li>
 *   <li>{@code @payloadRef} resolves to a non-VO target — skipped (payloads
 *       must be {@code object.value}; matches the cross-port contract).</li>
 *   <li>Templates are processed in stable name order for deterministic emission.</li>
 * </ul>
 *
 * <p><b>Day-1 deferrals</b> (see {@code KNOWN_GAPS.md}):
 * <ul>
 *   <li>{@code origin.*} children on payload fields are NOT yet honoured —
 *       the record uses each field's own scalar type via
 *       {@link SpringTypeMapper#javaTypeName(MetaField)}. Origin-driven
 *       projections (passthrough / aggregate / collection) are tracked in
 *       {@code KNOWN_GAPS.md} for a follow-up.</li>
 *   <li>{@link ObjectField} children are skipped (mirrors {@link SpringDtoGenerator}).</li>
 * </ul>
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 * </ul>
 */
public class SpringPayloadGenerator extends MultiFileDirectGeneratorBase<MetaObject> {

    @Override
    protected Class<MetaObject> getFilterClass() {
        return MetaObject.class;
    }

    @Override
    public void execute(MetaDataLoader loader) {
        parseArgs();
        Path outRoot = Paths.get(outDir.getAbsolutePath());

        // Stable name order — matches the other ports' deterministic emission.
        List<MetaTemplate> outputs = new ArrayList<>();
        for (MetaData child : loader.getRoot().getChildren()) {
            if (child instanceof MetaTemplate t && TemplateConstants.SUBTYPE_OUTPUT.equals(t.getSubType())) {
                outputs.add(t);
            }
        }
        outputs.sort((a, b) -> a.getName().compareTo(b.getName()));

        for (MetaTemplate tmpl : outputs) {
            emit(tmpl, loader, outRoot);
        }
    }

    private void emit(MetaTemplate template, MetaDataLoader loader, Path outRoot) {
        String payloadRef = template.getPayloadRef();
        if (payloadRef == null || payloadRef.isEmpty()) {
            return; // loader validation normally catches this first
        }
        MetaObject payloadVo = resolveValueObject(loader, payloadRef);
        if (payloadVo == null) {
            return; // not a VO — same contract as Kotlin / C# / Python
        }

        String[] split = SpringNaming.splitFqn(template.getName());
        String templatePkg = split[0];
        String templateShort = split[1];
        String outPkg = templatePkg.isEmpty() ? "prompts" : templatePkg + ".prompts";
        String recordName = templateShort + "Payload";

        StringBuilder src = new StringBuilder();
        src.append("package ").append(outPkg).append(";\n\n");
        src.append("/** GENERATED — payload for template.output `").append(template.getName())
           .append("`. Do not hand-edit; regenerated from metadata. */\n");
        src.append("public record ").append(recordName).append("(\n");

        Iterator<MetaField> it = scalarFields(payloadVo).iterator();
        while (it.hasNext()) {
            MetaField field = it.next();
            String type = SpringTypeMapper.javaTypeName(field);
            src.append("    ").append(type).append(' ').append(field.getName());
            if (it.hasNext()) src.append(',');
            src.append('\n');
        }
        src.append(") {}\n");

        try {
            Path outFile = outRoot.resolve(outPkg.replace('.', '/')).resolve(recordName + ".java");
            if (outFile.getParent() != null) Files.createDirectories(outFile.getParent());
            Files.writeString(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + recordName + ".java for template " + template.getName() + ": " + e, e);
        }
    }

    /** Resolve {@code @payloadRef} to its {@code object.value} target (rejects entities). */
    private static MetaObject resolveValueObject(MetaDataLoader loader, String ref) {
        // Direct lookup first (FQN); fall back to short-name match across all loaded objects.
        for (MetaObject obj : loader.getMetaObjects()) {
            if (!MetaObject.SUBTYPE_VALUE.equals(obj.getSubType())) continue;
            if (obj.getName().equals(ref)) return obj;
            String[] split = SpringNaming.splitFqn(obj.getName());
            if (split[1].equals(ref)) return obj;
        }
        return null;
    }

    /** Scalar payload fields — same filter SpringDtoGenerator uses (skips ObjectField). */
    private static List<MetaField> scalarFields(MetaObject vo) {
        List<MetaField> out = new ArrayList<>();
        for (MetaField field : vo.getMetaFields()) {
            if (field instanceof ObjectField) continue;
            out.add(field);
        }
        return out;
    }

    // === MultiFileDirectGeneratorBase abstract-method stubs ====================
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
        return SpringNaming.splitFqn(md.getName())[1] + "Payload.java";
    }
}
