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

    protected void emit(MetaTemplate template, MetaDataLoader loader, Path outRoot) {
        // Only emit for json/xml formats.
        String format = template.getFormat();
        boolean supported = TemplateConstants.FORMAT_JSON.equalsIgnoreCase(format)
                || TemplateConstants.FORMAT_XML.equalsIgnoreCase(format);
        if (!supported) {
            return;
        }

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
        String capitalized = capitalizeFirst(templateShort);
        String promptClass = capitalized + "Prompt";
        String payloadClass = capitalized + "Payload";

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

    /**
     * Uppercase the first character of {@code s}; pass through unchanged when
     * empty or already capitalised. Mirrors {@link SpringOutputParserGenerator}'s
     * matching helper.
     */
    private static String capitalizeFirst(String s) {
        if (s == null || s.isEmpty()) return s;
        char c0 = s.charAt(0);
        if (Character.isUpperCase(c0)) return s;
        return Character.toUpperCase(c0) + s.substring(1);
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
        return capitalizeFirst(SpringNaming.splitFqn(md.getName())[1]) + "Prompt.java";
    }
}
