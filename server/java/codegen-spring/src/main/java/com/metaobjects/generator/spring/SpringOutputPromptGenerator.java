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
 * Generator: one {@code <TemplateShortName>OutputPrompt} Java class per
 * {@code template.output} declaration (where {@code @format} is {@code json}
 * or {@code xml}), emitting a static {@code renderFormat()} / {@code renderFormat(PromptOverrides)}
 * pair backed by {@code OutputFormatRenderer} from the {@code metaobjects-render} module.
 *
 * <p>FR-010 Plan 3 — the Java prompt-fragment codegen. Mirrors the structure of
 * {@link SpringOutputParserGenerator}: same base class, same package derivation,
 * same stable-name-order iteration, same {@code @payloadRef} resolution, same
 * defensive skip rules.
 *
 * <p>Emitted class shape:
 * <pre>
 *   // GENERATED — DO NOT EDIT — output-format prompt for template.output `AnswerOutput`
 *   package acme.ai.prompts;
 *
 *   public final class AnswerOutputPrompt {
 *
 *       private static final com.metaobjects.render.prompt.OutputFormatSpec SPEC = ...;
 *
 *       private AnswerOutputPrompt() { /* no instances *&#47; }
 *
 *       /** The output-format instruction fragment. *&#47;
 *       public static String renderFormat() {
 *           return com.metaobjects.render.prompt.OutputFormatRenderer.render(
 *               SPEC, com.metaobjects.render.prompt.PromptOverrides.none());
 *       }
 *
 *       public static String renderFormat(com.metaobjects.render.prompt.PromptOverrides overrides) {
 *           return com.metaobjects.render.prompt.OutputFormatRenderer.render(SPEC, overrides);
 *       }
 *   }
 * </pre>
 *
 * <p>Skips:
 * <ul>
 *   <li>{@code template.prompt} nodes — only outputs need prompt-fragment codegen.</li>
 *   <li>Missing or non-VO {@code @payloadRef}.</li>
 *   <li>{@code @format} values other than {@code json} or {@code xml}.</li>
 * </ul>
 *
 * <p>The {@code SPEC}'s {@code rootName} is the capitalized payload class name
 * (e.g. {@code "AnswerOutputPayload"}) — matches the convention used by Plan 2's
 * extract codegen so both artifacts agree on the root name.
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 * </ul>
 */
public class SpringOutputPromptGenerator extends MultiFileDirectGeneratorBase<MetaObject> {

    @Override
    protected Class<MetaObject> getFilterClass() {
        return MetaObject.class;
    }

    @Override
    public void execute(MetaDataLoader loader) {
        parseArgs();
        Path outRoot = Paths.get(outDir.getAbsolutePath());

        // Stable name order — matches the other ports' deterministic emission.
        // ADR-0039: root-scan discipline — resolving children accessor.
        List<MetaTemplate> outputs = new ArrayList<>();
        for (MetaTemplate t : loader.getRoot().getChildren(MetaTemplate.class, true)) {
            if (TemplateConstants.SUBTYPE_OUTPUT.equals(t.getSubType())) {
                outputs.add(t);
            }
        }
        outputs.sort((a, b) -> a.getName().compareTo(b.getName()));

        for (MetaTemplate tmpl : outputs) {
            emit(tmpl, loader, outRoot);
        }
    }

    /**
     * True iff this generator emits an output-format prompt for {@code node}: the
     * node is a {@code template.output} whose {@code @format} is {@code json} or
     * {@code xml} AND whose {@code @payloadRef} resolves (against {@code loader})
     * to an {@code object.value}. Extracted from the {@link #execute(MetaDataLoader)}
     * {@code SUBTYPE_OUTPUT} filter combined with the per-template {@link #emit}
     * format + payload guards.
     */
    public static boolean appliesTo(MetaData node, MetaDataLoader loader) {
        if (!(node instanceof MetaTemplate template)) return false;
        if (!TemplateConstants.SUBTYPE_OUTPUT.equals(template.getSubType())) return false;
        String format = template.getFormat();
        boolean supported = TemplateConstants.FORMAT_JSON.equalsIgnoreCase(format)
                || TemplateConstants.FORMAT_XML.equalsIgnoreCase(format);
        if (!supported) return false;
        String payloadRef = template.getPayloadRef();
        if (payloadRef == null || payloadRef.isEmpty()) return false;
        return resolveValueObject(loader, payloadRef) != null;
    }

    protected void emit(MetaTemplate template, MetaDataLoader loader, Path outRoot) {
        if (!appliesTo(template, loader)) {
            return; // unsupported @format, missing @payloadRef, or not a VO
        }
        MetaObject payloadVo = resolveValueObject(loader, template.getPayloadRef());

        String[] split = SpringNaming.splitFqn(template.getName());
        String templatePkg = split[0];
        String templateShort = split[1];
        String outPkg = SpringNaming.promptsPackage(templatePkg);
        String promptClass = SpringNaming.promptName(templateShort);
        String payloadClass = SpringNaming.payloadName(templateShort);

        // The SPEC rootName agrees with the payload class name so both prompt and
        // extract artifacts share the same root element name.
        String specLiteral = OutputFormatSpecEmitter.specLiteral(payloadVo, template, payloadClass);

        StringBuilder src = new StringBuilder();
        src.append("// GENERATED — DO NOT EDIT — output-format prompt for template.output `")
           .append(template.getName()).append("`\n");
        src.append("package ").append(outPkg).append(";\n\n");
        src.append("import com.metaobjects.render.prompt.OutputFormatSpec;\n");
        src.append("import com.metaobjects.render.prompt.OutputFormatRenderer;\n");
        src.append("import com.metaobjects.render.prompt.PromptField;\n");
        src.append("import com.metaobjects.render.prompt.PromptOverrides;\n");
        src.append("import com.metaobjects.render.prompt.PromptStyle;\n");
        src.append("import com.metaobjects.render.extract.FieldKind;\n");
        src.append("import com.metaobjects.render.extract.Format;\n");
        src.append("\n");
        src.append("/** Output-format prompt fragment for the `")
           .append(templateShort).append("` template.output. */\n");
        src.append("public final class ").append(promptClass).append(" {\n\n");
        src.append("    private static final OutputFormatSpec SPEC =\n");
        src.append("        ").append(specLiteral).append(";\n\n");
        src.append("    private ").append(promptClass).append("() { /* no instances */ }\n\n");
        src.append("    /** The output-format instruction fragment (\"produce your answer like this\"). */\n");
        src.append("    public static String renderFormat() {\n");
        src.append("        return OutputFormatRenderer.render(SPEC, PromptOverrides.none());\n");
        src.append("    }\n\n");
        src.append("    public static String renderFormat(PromptOverrides overrides) {\n");
        src.append("        return OutputFormatRenderer.render(SPEC, overrides);\n");
        src.append("    }\n");
        src.append("}\n");

        try {
            Path outFile = outRoot.resolve(outPkg.replace('.', '/')).resolve(promptClass + ".java");
            if (outFile.getParent() != null) Files.createDirectories(outFile.getParent());
            Files.writeString(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + promptClass + ".java for template " + template.getName() + ": " + e, e);
        }
    }

    /** Resolve {@code @payloadRef} to its {@code object.value} target (rejects entities). */
    protected static MetaObject resolveValueObject(MetaDataLoader loader, String ref) {
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
        return SpringNaming.promptName(SpringNaming.splitFqn(md.getName())[1]) + ".java";
    }
}
