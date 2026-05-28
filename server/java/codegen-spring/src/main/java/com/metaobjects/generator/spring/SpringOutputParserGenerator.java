package com.metaobjects.generator.spring;

import com.metaobjects.MetaData;
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
import java.util.List;

/**
 * Generator: one {@code <TemplateShortName>Parser} Java class per
 * {@code template.output} declaration, emitting a Jackson-backed throw-only
 * parser around the {@code @payloadRef} payload record produced by
 * {@link SpringPayloadGenerator} (no payload-shape re-declaration).
 *
 * <p>FR-006 — the Java port of the cross-language template-output parser
 * codegen. See {@code docs/superpowers/specs/2026-05-25-fr6-template-output-parser-codegen.md}
 * and ADR-0010 for the cross-port contract; this generator is the Spring/Java
 * sibling of TS's {@code outputParser()}, C#'s {@code OutputParserGenerator},
 * Python's {@code OutputParserGenerator}, and Kotlin's
 * {@code KotlinOutputParserGenerator}.
 *
 * <p>API shape (idiomatic Java/Spring throw-only per ADR-0010 §3 — matches
 * the Jackson convention; consumers wrap with their own try/catch when they
 * need explicit error handling):
 * <pre>
 *   public final class &lt;TemplateShortName&gt;Parser {
 *       private static final ObjectMapper MAPPER = new ObjectMapper();
 *
 *       private &lt;TemplateShortName&gt;Parser() {}
 *
 *       // Throws com.fasterxml.jackson.core.JsonProcessingException on bad input.
 *       public static &lt;TemplateShortName&gt;Payload parse(String text) throws JsonProcessingException {
 *           return MAPPER.readValue(text, &lt;TemplateShortName&gt;Payload.class);
 *       }
 *   }
 * </pre>
 *
 * <p>Skips and defensive cases (mirrors the cross-port behavior):
 * <ul>
 *   <li>{@code template.prompt} is ignored — only outputs need parsing.</li>
 *   <li>Missing {@code @payloadRef} — skipped (loader's validation pass
 *       normally rejects this first; defensive only).</li>
 *   <li>{@code @payloadRef} resolves to a non-VO target (e.g. {@code object.entity}) —
 *       skipped (same contract as {@link SpringPayloadGenerator}).</li>
 *   <li>Outputs are processed in stable name order for deterministic emission.</li>
 * </ul>
 *
 * <p>The emitted file's package matches {@link SpringPayloadGenerator}'s
 * ({@code <entity-pkg>.prompts}) so the payload record import is implicit
 * (same-package reference).
 *
 * <p><b>Consumer dependency.</b> The emitted parser file imports from
 * {@code com.fasterxml.jackson.databind.ObjectMapper} and
 * {@code com.fasterxml.jackson.core.JsonProcessingException}. Consumers
 * must have Jackson on their classpath; Spring Boot's
 * {@code spring-boot-starter-web} brings Jackson automatically. See
 * {@code KNOWN_GAPS.md} for the consumer-wiring contract.
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 * </ul>
 */
public class SpringOutputParserGenerator extends MultiFileDirectGeneratorBase<MetaObject> {

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
            return; // not a VO — same contract as SpringPayloadGenerator
        }

        String[] split = SpringNaming.splitFqn(template.getName());
        String templatePkg = split[0];
        String templateShort = split[1];
        String outPkg = templatePkg.isEmpty() ? "prompts" : templatePkg + ".prompts";
        // PascalCase the class names — templates authored in camelCase
        // (e.g. `npcTurn`) yield Java-idiomatic `NpcTurnParser` /
        // `NpcTurnPayload`. Pairs with SpringPayloadGenerator's matching
        // capitalisation so the parser's payload-class reference stays
        // consistent.
        String capitalized = capitalizeFirst(templateShort);
        String parserClass = capitalized + "Parser";
        String payloadClass = capitalized + "Payload";

        StringBuilder src = new StringBuilder();
        src.append("// GENERATED — DO NOT EDIT — parser for template.output `")
           .append(template.getName()).append("`\n");
        src.append("package ").append(outPkg).append(";\n\n");
        src.append("import com.fasterxml.jackson.core.JsonProcessingException;\n");
        src.append("import com.fasterxml.jackson.databind.ObjectMapper;\n\n");
        src.append("/** Parser for LLM responses matching the `")
           .append(templateShort).append("` template.output. */\n");
        src.append("public final class ").append(parserClass).append(" {\n\n");
        src.append("    private static final ObjectMapper MAPPER = new ObjectMapper();\n\n");
        src.append("    private ").append(parserClass).append("() { /* no instances */ }\n\n");
        src.append("    /**\n");
        src.append("     * Parse an LLM response into a typed {@link ")
           .append(payloadClass).append("}.\n");
        src.append("     *\n");
        src.append("     * @throws JsonProcessingException when the input is not valid JSON for the payload schema.\n");
        src.append("     */\n");
        src.append("    public static ").append(payloadClass).append(" parse(String text) throws JsonProcessingException {\n");
        src.append("        return MAPPER.readValue(text, ").append(payloadClass).append(".class);\n");
        src.append("    }\n");
        src.append("}\n");

        try {
            Path outFile = outRoot.resolve(outPkg.replace('.', '/')).resolve(parserClass + ".java");
            if (outFile.getParent() != null) Files.createDirectories(outFile.getParent());
            Files.writeString(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + parserClass + ".java for template " + template.getName() + ": " + e, e);
        }
    }

    /**
     * Uppercase the first character of {@code s}; pass through unchanged when
     * empty or already capitalised. Pairs with {@link SpringPayloadGenerator}'s
     * matching helper so the {@code <PayloadClass>} reference in the parser
     * matches the actual generated file name.
     */
    private static String capitalizeFirst(String s) {
        if (s == null || s.isEmpty()) return s;
        char c0 = s.charAt(0);
        if (Character.isUpperCase(c0)) return s;
        return Character.toUpperCase(c0) + s.substring(1);
    }

    /** Resolve {@code @payloadRef} to its {@code object.value} target (rejects entities). */
    private static MetaObject resolveValueObject(MetaDataLoader loader, String ref) {
        for (MetaObject obj : loader.getMetaObjects()) {
            if (!MetaObject.SUBTYPE_VALUE.equals(obj.getSubType())) continue;
            if (obj.getName().equals(ref)) return obj;
            String[] split = SpringNaming.splitFqn(obj.getName());
            if (split[1].equals(ref)) return obj;
        }
        return null;
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
        return capitalizeFirst(SpringNaming.splitFqn(md.getName())[1]) + "Parser.java";
    }
}
