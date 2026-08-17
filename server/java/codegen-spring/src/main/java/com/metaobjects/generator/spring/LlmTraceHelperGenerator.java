package com.metaobjects.generator.spring;

import com.metaobjects.MetaData;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.generator.util.GeneratorUtil;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.template.MetaTemplate;
import com.metaobjects.template.PromptTemplate;
import com.metaobjects.template.TemplateConstants;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Collection;
import java.util.Comparator;
import com.metaobjects.generator.util.GeneratedFileWriter;

/**
 * Generator: one {@code <Entity>TraceHelper} Java class per concrete
 * {@code object.entity} that (a) transitively {@code extends}
 * {@code metaobjects::ai::LlmCallBase} AND (b) nests a {@code template.prompt}
 * carrying {@code @responseRef}. Java port of the TypeScript
 * {@code trace-helper-file.ts} {@code record<Entity>} half (Slice 2).
 *
 * <p>The emitted class exposes a single static {@code record<Entity>(...)} that:
 * <ol>
 *   <li>resolves the response payload {@link MetaObject} (the {@code @responseRef}
 *       VO) and the trace entity {@link MetaObject} from the supplied loader;</li>
 *   <li>runs the runtime tolerant extract
 *       ({@code com.metaobjects.object.extract.MetaObjectExtractor.extract(responseMo, input.llmResponseText())})
 *       into a typed {@code voResponse} (a lost-required field → {@code status="error"},
 *       {@code voResponse=null}) — mirroring the TS reference's lost-required gate;</li>
 *   <li>builds the base trace row via the Slice-1
 *       {@code com.metaobjects.manager.db.ai.LlmTraceRowBuilder#buildLlmCallRow}
 *       (the 18 {@code LlmCallBase} base fields + raw {@code llmRequest}/{@code llmResponse}),
 *       folding in the derived {@code status}/{@code errorDetail};</li>
 *   <li>sets the typed {@code voRequest} (the request payload, i.e. {@code input.llmRequest()})
 *       and {@code voResponse} columns on the row via the field SPI;</li>
 *   <li>persists the row ONCE via the supplied
 *       {@code com.metaobjects.manager.db.ai.LlmCallRecorder} (the never-throwing
 *       Slice-1 OMDB recorder seam);</li>
 *   <li>returns a typed {@code <Entity>TraceResult} record
 *       ({@code status}, {@code errorDetail}, {@code voResponse}).</li>
 * </ol>
 *
 * <p><b>{@code call<Entity>} is intentionally NOT emitted.</b> The render→call→record
 * loop needs an {@code LlmClient} seam that is BYO / vendor-neutral in Java (the Java
 * {@code LlmClient} seam is not ported — ADR-0024). This generator covers only the
 * parse-then-persist half, consistent with the cross-port slicing.
 *
 * <p><b>No {@code om}/{@code omdb} compile dependency.</b> Exactly like
 * {@link com.metaobjects.generator.direct.object.javacode.ExtractorCodeGenerator},
 * the emitted source references the runtime extract ({@code metaobjects-om}) and the
 * recorder + row builder ({@code metaobjects-omdb}) <b>by fully-qualified-name string
 * only</b>. Those resolve on the <i>consumer's</i> classpath (where {@code om}/{@code omdb}
 * are present), never against {@code codegen-spring} at build time.
 *
 * <p>Skips (no helper emitted) when: the entity is abstract, does not derive from
 * {@code LlmCallBase}, has no nested {@code template.prompt}, or that prompt carries
 * no {@code @responseRef} (the typed-result contract requires it). The request type is
 * left untyped ({@code Object}) — the Java payload-VO surface is the strict typed layer;
 * the trace helper threads the request payload through as the generic {@code llmRequest}.
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 * </ul>
 *
 * <p>Registered as the cross-port stable name {@code trace-helper}
 * ({@code fixtures/generator-registry-conformance/registry.json}); TS is the reference.
 */
public class LlmTraceHelperGenerator extends MultiFileDirectGeneratorBase<MetaObject> {

    /** The abstract base entity a trace entity must (transitively) extend. */
    public static final String LLM_CALL_BASE = "LlmCallBase";

    /** FQN of the runtime extract entry point (emitted as a source FQN string). */
    public static final String META_OBJECT_EXTRACT_FQN =
            "com.metaobjects.object.extract.MetaObjectExtractor";
    /** FQN of the never-throwing recorder seam (emitted as a source FQN string). */
    public static final String RECORDER_FQN =
            "com.metaobjects.manager.db.ai.LlmCallRecorder";
    /** FQN of the call-input carrier (emitted as a source FQN string). */
    public static final String CALL_INPUT_FQN =
            "com.metaobjects.manager.db.ai.LlmCallInput";
    /** FQN of the base-row builder (emitted as a source FQN string). */
    public static final String ROW_BUILDER_FQN =
            "com.metaobjects.manager.db.ai.LlmTraceRowBuilder";
    /** FQN of the loader the generated helper accepts. */
    public static final String LOADER_FQN = "com.metaobjects.loader.MetaDataLoader";
    /** FQN of the ValueObject the row builder returns / we set typed columns on. */
    public static final String VALUE_OBJECT_FQN = "com.metaobjects.object.value.ValueObject";

    @Override
    protected Class<MetaObject> getFilterClass() {
        return MetaObject.class;
    }

    @Override
    public void execute(MetaDataLoader loader) {
        parseArgs();
        Path outRoot = Paths.get(outDir.getAbsolutePath());

        // Stable name order — deterministic emission, matching the other generators.
        java.util.List<MetaObject> entities = new java.util.ArrayList<>();
        for (MetaObject mo : loader.getMetaObjects()) {
            if (!appliesTo(mo)) continue;
            entities.add(mo);
        }
        entities.sort(Comparator.comparing(MetaObject::getName));

        for (MetaObject entity : entities) {
            emit(entity, loader, outRoot);
        }
    }

    /**
     * True iff this generator emits a trace helper for {@code entity}: a concrete
     * (non-abstract) {@code object.entity} that transitively {@code extends}
     * {@code LlmCallBase}, nests a {@code template.prompt}, AND that prompt carries
     * {@code @responseRef} (the typed-result contract requires it). Extracted
     * verbatim from the combined {@link #execute(MetaDataLoader)} +
     * {@link #emit(MetaObject, MetaDataLoader, java.nio.file.Path)} skip guards.
     *
     * <p>Note: this predicate only asks whether {@code @responseRef} is PRESENT.
     * A present-but-unresolvable {@code @responseRef} is an authoring error the
     * {@code emit} path raises as a {@link GeneratorException} — it is not a
     * silent skip, so it is intentionally outside this inclusion predicate.</p>
     */
    public static boolean appliesTo(MetaObject entity) {
        if (!MetaObject.SUBTYPE_ENTITY.equals(entity.getSubType())) return false;
        if (GeneratorUtil.isAbstract(entity)) return false;
        if (!extendsBase(entity)) return false;
        PromptTemplate prompt = firstPrompt(entity);
        if (prompt == null) return false;
        String responseRef = prompt.getResponseRef();
        return responseRef != null && !responseRef.isEmpty();
    }

    protected void emit(MetaObject entity, MetaDataLoader loader, Path outRoot) {
        PromptTemplate prompt = firstPrompt(entity);
        if (prompt == null) return;

        String responseRef = prompt.getResponseRef();
        if (responseRef == null || responseRef.isEmpty()) return; // @responseRef gates the helper

        // #228 — referrer is the PROMPT (the @responseRef is authored on it), not the
        // entity: findPackageForMetaData walks parents, so a nested prompt still
        // resolves the entity's effective package when the prompt itself carries none.
        MetaObject responseVo = resolveValueObject(loader, responseRef,
            com.metaobjects.util.MetaDataUtil.findPackageForMetaData(prompt));
        if (responseVo == null) {
            throw new GeneratorException(
                "trace-helper: entity \"" + entity.getName() + "\" prompt @responseRef \""
                    + responseRef + "\" does not resolve to an object.value or sourceless object.projection");
        }

        String[] split = SpringNaming.splitFqn(entity.getName());
        String pkg = split[0];
        String shortName = split[1];
        String helperClass = SpringNaming.traceHelperName(shortName);
        String resultClass = shortName + "TraceResult";
        String fnName = "record" + SpringNaming.capitalize(shortName);

        StringBuilder src = new StringBuilder();
        src.append("// GENERATED — DO NOT EDIT — LLM-trace helper for object.entity `")
           .append(entity.getName()).append("`\n");
        if (!pkg.isEmpty()) {
            src.append("package ").append(pkg).append(";\n\n");
        }
        src.append("/**\n");
        src.append(" * Typed LLM-trace helper for {@code ").append(shortName).append("}.\n");
        src.append(" *\n");
        src.append(" * <p>Extracts the typed response VO from {@code input.llmResponseText()} and\n");
        src.append(" * persists ONE trace row (base envelope + raw I/O + typed voRequest/voResponse)\n");
        src.append(" * via the supplied recorder. The render-call-record helper is intentionally\n");
        src.append(" * not emitted (BYO vendor-neutral caller; Java LlmClient seam not ported).</p>\n");
        src.append(" */\n");
        src.append("public final class ").append(helperClass).append(" {\n\n");
        src.append("    private ").append(helperClass).append("() { /* no instances */ }\n\n");

        // Typed result record.
        src.append("    /** Typed result of ").append(fnName)
           .append(": derived status/errorDetail + the parsed response VO (null when lost-required). */\n");
        src.append("    public record ").append(resultClass)
           .append("(String status, String errorDetail, Object voResponse) {}\n\n");

        // record<Entity>(...)
        src.append("    /**\n");
        src.append("     * Record a single {@code ").append(shortName)
           .append("} LLM call: extract the response VO and persist a\n");
        src.append("     * trace row via {@code recorder} regardless of whether extraction succeeded.\n");
        src.append("     *\n");
        src.append("     * @param loader   the loader the trace + response MetaObjects resolve against\n");
        src.append("     * @param recorder the never-throwing write-side seam (Slice-1 OMDB recorder)\n");
        src.append("     * @param input    the LLM call fields; {@code llmRequest()} is the typed request payload,\n");
        src.append("     *                 threaded through as voRequest and JSON-stringified into the raw column\n");
        src.append("     */\n");
        src.append("    public static ").append(resultClass).append(" ").append(fnName).append("(\n");
        src.append("            ").append(LOADER_FQN).append(" loader,\n");
        src.append("            ").append(RECORDER_FQN).append(" recorder,\n");
        src.append("            ").append(CALL_INPUT_FQN).append(" input) {\n");
        // Resolve MetaObjects by their loaded FQNs (baked at codegen time).
        src.append("        com.metaobjects.object.MetaObject traceMo = loader.getMetaObjectByName(")
           .append(quote(entity.getName())).append(");\n");
        src.append("        com.metaobjects.object.MetaObject responseMo = loader.getMetaObjectByName(")
           .append(quote(responseVo.getName())).append(");\n");
        // Tolerant extract → typed voResponse + lost-required gate.
        src.append("        com.metaobjects.render.extract.ExtractionResult<Object> outcome =\n");
        src.append("            ").append(META_OBJECT_EXTRACT_FQN)
           .append(".extract(responseMo, input.llmResponseText());\n");
        src.append("        boolean failed = outcome.report().hasLostRequired();\n");
        src.append("        String status = failed ? ").append(CALL_INPUT_FQN).append(".STATUS_ERROR : ")
           .append(CALL_INPUT_FQN).append(".STATUS_OK;\n");
        src.append("        String errorDetail = failed\n");
        src.append("            ? \"lost required: \" + String.join(\", \", outcome.report().lostRequired())\n");
        src.append("            : null;\n");
        // Rebuild the input with derived status/errorDetail (extraction owns them).
        src.append("        ").append(CALL_INPUT_FQN).append(" effective = new ")
           .append(CALL_INPUT_FQN).append("(\n");
        src.append("            input.spanId(), input.traceId(), input.parentSpanId(), input.sessionId(),\n");
        src.append("            input.callType(), input.system(), input.startedAt(), input.llmRequest(),\n");
        src.append("            input.llmResponseText(), input.requestModel(), input.responseModel(),\n");
        src.append("            input.inputTokens(), input.outputTokens(), input.costMinor(), input.latencyMs(),\n");
        src.append("            input.finishReason(), status, errorDetail);\n");
        // Build base row + set typed voRequest/voResponse via the field SPI.
        src.append("        ").append(VALUE_OBJECT_FQN).append(" row = ").append(ROW_BUILDER_FQN)
           .append(".buildLlmCallRow(traceMo, effective);\n");
        src.append("        traceMo.getMetaField(\"voRequest\").setObject(row, input.llmRequest());\n");
        src.append("        Object voResponse = failed ? null : outcome.data();\n");
        src.append("        traceMo.getMetaField(\"voResponse\").setObject(row, voResponse);\n");
        // Persist once via the recorder (never throws).
        src.append("        recorder.record(row);\n");
        src.append("        return new ").append(resultClass)
           .append("(status, errorDetail, voResponse);\n");
        src.append("    }\n");
        src.append("}\n");

        try {
            Path outFile = pkg.isEmpty()
                ? outRoot.resolve(helperClass + ".java")
                : outRoot.resolve(pkg.replace('.', '/')).resolve(helperClass + ".java");
            GeneratedFileWriter.write(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + helperClass + ".java for entity " + entity.getName() + ": " + e, e);
        }
    }

    // -------------------------------------------------------------------------
    // Resolution helpers
    // -------------------------------------------------------------------------

    /** Walk the super chain looking for a node short-named {@link #LLM_CALL_BASE}. */
    protected static boolean extendsBase(MetaObject entity) {
        MetaObject cur = entity.getSuperObject();
        while (cur != null) {
            if (LLM_CALL_BASE.equals(cur.getShortName())) return true;
            cur = cur.getSuperObject();
        }
        return false;
    }

    /** First own {@code template.prompt} child of {@code entity}, or {@code null}. */
    protected static PromptTemplate firstPrompt(MetaObject entity) {
        for (MetaData child : entity.getChildren()) {
            if (child instanceof PromptTemplate p) return p;
            if (child instanceof MetaTemplate t
                    && TemplateConstants.SUBTYPE_PROMPT.equals(t.getSubType())
                    && t instanceof PromptTemplate pt) {
                return pt;
            }
        }
        return null;
    }

    /**
     * Resolve a {@code @responseRef} to its {@code object.value} target under the
     * ADR-0042 package-local contract (#228). Was a package-BLIND bare-name scan that,
     * worse, reduced the REF ITSELF to its trailing {@code ::} segment before matching
     * — the #219/#244 bare-tail-fallback pattern: an FQN {@code @responseRef} that
     * failed an exact match would still bind ANY same-bare-named {@code object.value}
     * in a WRONG package (first match, load-order-dependent), not just a genuinely
     * bare ref. Now delegates to the shared {@link SpringNaming#resolveValueObjectRef}
     * (FQN matches exactly, never a bare-tail fallback).
     */
    protected static MetaObject resolveValueObject(MetaDataLoader loader, String ref, String referrerPkg) {
        return SpringNaming.resolveValueObjectRef(loader, ref, referrerPkg);
    }

    /** Java string-literal quoting with the common escapes. */
    private static String quote(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder(s.length() + 2);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\': sb.append("\\\\"); break;
                case '"':  sb.append("\\\""); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:   sb.append(c);
            }
        }
        sb.append('"');
        return sb.toString();
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
        return SpringNaming.traceHelperName(SpringNaming.splitFqn(md.getName())[1]) + ".java";
    }
}
