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
import com.metaobjects.generator.util.GeneratedFileWriter;

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

        // ADR-0052: the direction rule lives in FindInbound, never re-derived here.
        for (MetaTemplate tmpl : FindInbound.inboundTemplates(loader)) {
            emit(tmpl, loader, outRoot);
        }
    }

    /**
     * True iff this generator emits a response-format prompt fragment for {@code node}:
     * a {@code template.prompt} whose {@code @responseRef} resolves (against
     * {@code loader}) to an {@code object.value}. Single source of truth shared by the
     * generator loop AND the api-docs builder.
     *
     * <p>ADR-0052/0053: the gate is {@code @responseRef} PRESENCE, not a format value.
     * The old {@code @format ∈ {json,xml}} gate read the syntax of the OUTBOUND body to
     * decide whether to instruct the model about the syntax of its REPLY — so a
     * text-bodied prompt asking for a JSON answer, the common case, got no fragment at
     * all. Both formats now get one; {@code @responseFormat} only selects which.
     */
    public static boolean appliesTo(MetaData node, MetaDataLoader loader) {
        return FindInbound.isInbound(node, loader);
    }

    protected void emit(MetaTemplate template, MetaDataLoader loader, Path outRoot) {
        FindInbound.InboundShape shape = FindInbound.responseShape(loader, template);
        if (shape == null) {
            return; // no @responseRef, or it does not resolve to a VO
        }
        MetaObject payloadVo = shape.vo();

        String[] split = SpringNaming.splitFqn(template.getName());
        String templatePkg = split[0];
        String templateShort = split[1];
        String outPkg = SpringNaming.promptsPackage(templatePkg);
        String promptClass = SpringNaming.responseFormatName(templateShort);
        // ADR-0052: the fragment describes the RESPONSE shape, so its root name is the
        // response record — never the @payloadRef record, which types the request.
        String responseClass = SpringNaming.responseName(templateShort);

        // The SPEC rootName agrees with the response record name so the fragment and the
        // parser agree on the root element name.
        String specLiteral = OutputFormatSpecEmitter.specLiteral(payloadVo, template, responseClass);

        StringBuilder src = new StringBuilder();
        src.append("// GENERATED — DO NOT EDIT — response-format fragment for template.prompt `")
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
        src.append("/** Response-format prompt fragment for the `")
           .append(templateShort).append("` template.prompt. */\n");
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
            GeneratedFileWriter.write(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + promptClass + ".java for template " + template.getName() + ": " + e, e);
        }
    }

    /**
     * Resolve {@code @payloadRef} to its {@code object.value} target (rejects entities)
     * under the ADR-0042 package-local contract (#228) — was a package-BLIND bare-name
     * scan (first match wins, load-order-dependent); now delegates to the shared
     * {@link SpringNaming#resolveValueObjectRef}.
     */
    protected static MetaObject resolveValueObject(MetaDataLoader loader, String ref, String referrerPkg) {
        return SpringNaming.resolveValueObjectRef(loader, ref, referrerPkg);
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
        return SpringNaming.responseFormatName(SpringNaming.splitFqn(md.getName())[1]) + ".java";
    }
}
