package com.metaobjects.generator.spring;

// Eject note (ADR-0034, JVM eject design): these siblings stay in
// com.metaobjects.generator.spring when this generator is copied out via
// `mvn metaobjects:eject` and its own package is renamed — an explicit import, not
// same-package bare-name resolution, is what keeps the ejected copy compiling.
import com.metaobjects.generator.spring.SpringJavaWriter;
import com.metaobjects.generator.spring.FindInbound;
import com.metaobjects.generator.spring.SpringNaming;

import com.metaobjects.MetaData;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.generator.util.GeneratorUtil;
import com.metaobjects.library.LibrarySources;
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
 *       ({@code com.metaobjects.object.extract.MetaObjectExtractor.extract(responseMo, input.llmResponseText(), format)},
 *       the format baked from the prompt's {@code @responseFormat} per ADR-0053)
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

    /** This generator's cross-port stable name — the key a library manifest declares
     *  its {@code anchor} under. */
    public static final String STABLE_NAME = "trace-helper";

    /**
     * FQNs of the library nodes a trace entity must (transitively) extend — read from
     * the shipped {@code library.json} manifests (FR-043 §6), never hard-coded here.
     *
     * <p>What it replaces: {@code "LlmCallBase"} compared against
     * {@link MetaData#getShortName()}, which matched ANY adopter entity of that name in
     * ANY package while never actually keying on the shipped abstract.</p>
     */
    public static final java.util.List<String> ANCHOR_FQNS =
            java.util.Collections.unmodifiableList(LibrarySources.generatorAnchors(STABLE_NAME));

    /** FQN of the runtime extract entry point (emitted as a source FQN string). */
    public static final String META_OBJECT_EXTRACT_FQN =
            "com.metaobjects.object.extract.MetaObjectExtractor";
    /** FQN of the reply-syntax enum the emitted extract call selects (ADR-0053). */
    public static final String EXTRACT_FORMAT_FQN =
            "com.metaobjects.render.extract.Format";
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
        for (MetaObject mo : GeneratorUtil.ownMetaObjects(loader)) {
            if (!appliesTo(mo) || !isSelected(mo)) continue;
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

        MetaObject responseVo = SpringNaming.payloadTarget(prompt, "responseRef");
        if (responseVo == null) {
            throw new GeneratorException(
                "trace-helper: entity \"" + entity.getName() + "\" prompt @responseRef \""
                    + responseRef + "\" does not resolve to an object.value or sourceless object.projection");
        }

        // ADR-0053 — the REPLY's syntax is @responseFormat (json|xml, default json).
        //
        // This site used to bake nothing at all: it called the 2-arg
        // MetaObjectExtractor.extract(mo, text) overload, which hardcodes Format.JSON. So a
        // prompt declaring an XML reply got a trace helper that parsed it as JSON — the
        // reply's syntax was inexpressible here, not merely mis-read. (@format was never
        // consulted, which is why this port needed a different fix from TypeScript's and
        // Python's, where @format WAS the source and had to be replaced.)
        String replyFormat = FindInbound.responseFormatOf(prompt);
        String formatEnum = FindInbound.isXml(replyFormat)
            ? EXTRACT_FORMAT_FQN + ".XML"
            : EXTRACT_FORMAT_FQN + ".JSON";

        String[] split = SpringNaming.splitFqn(entity.getName());
        String pkg = split[0];
        String shortName = split[1];
        String helperClass = SpringNaming.traceHelperName(shortName);
        String resultClass = shortName + "TraceResult";
        String fnName = "record" + SpringNaming.capitalize(shortName);

        SpringJavaWriter w = new SpringJavaWriter();
        w.header("// GENERATED — DO NOT EDIT — LLM-trace helper for object.entity `" + entity.getName() + "`");
        if (!pkg.isEmpty()) w.packageName(pkg);
        w.line("/**");
        w.line(" * Typed LLM-trace helper for {@code " + shortName + "}.");
        w.line(" *");
        w.line(" * <p>Extracts the typed response VO from {@code input.llmResponseText()} and");
        w.line(" * persists ONE trace row (base envelope + raw I/O + typed voRequest/voResponse)");
        w.line(" * via the supplied recorder. The render-call-record helper is intentionally");
        w.line(" * not emitted (BYO vendor-neutral caller; Java LlmClient seam not ported).</p>");
        w.line(" */");
        try (var cls = w.block("public final class " + helperClass + " {")) {
            w.line("private " + helperClass + "() { /* no instances */ }");
            w.blank();
            // Typed result record.
            w.line("/** Typed result of " + fnName
                + ": derived status/errorDetail + the parsed response VO (null when lost-required). */");
            w.line("public record " + resultClass + "(String status, String errorDetail, Object voResponse) {}");
            w.blank();
            writeRecordMethod(w, entity, responseVo, shortName, resultClass, fnName, formatEnum);
        }

        try {
            Path outFile = pkg.isEmpty()
                ? outRoot.resolve(helperClass + ".java")
                : outRoot.resolve(pkg.replace('.', '/')).resolve(helperClass + ".java");
            GeneratedFileWriter.write(outFile, w.toString(), entity);
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + helperClass + ".java for entity " + entity.getName() + ": " + e, e);
        }
    }

    /**
     * {@code record<Entity>(loader, recorder, input)}: extract the response value object, derive
     * the call's status from what was lost or malformed, and persist one trace row.
     */
    protected void writeRecordMethod(SpringJavaWriter w, MetaObject entity, MetaObject responseVo, String shortName,
                                     String resultClass, String fnName, String formatEnum) {
        w.line("/**");
        w.line(" * Record a single {@code " + shortName + "} LLM call: extract the response VO and persist a");
        w.line(" * trace row via {@code recorder} regardless of whether extraction succeeded.");
        w.line(" *");
        w.line(" * @param loader   the loader the trace + response MetaObjects resolve against");
        w.line(" * @param recorder the never-throwing write-side seam (Slice-1 OMDB recorder)");
        w.line(" * @param input    the LLM call fields; {@code llmRequest()} is the typed request payload,");
        w.line(" *                 threaded through as voRequest and JSON-stringified into the raw column");
        w.line(" */");
        w.line("public static " + resultClass + " " + fnName + "(");
        w.continuation(LOADER_FQN + " loader,");
        w.continuation(RECORDER_FQN + " recorder,");
        w.continuation(CALL_INPUT_FQN + " input) {");
        try (var m = w.bodyBlock()) {
            // Resolve MetaObjects by their loaded FQNs (baked at codegen time).
            w.line("com.metaobjects.object.MetaObject traceMo = loader.getMetaObjectByName("
                + quote(entity.getName()) + ");");
            w.line("com.metaobjects.object.MetaObject responseMo = loader.getMetaObjectByName("
                + quote(responseVo.getName()) + ");");
            // Tolerant extract → typed voResponse + lost-required gate.
            w.line("com.metaobjects.render.extract.ExtractionResult<Object> outcome =");
            w.deeper(1, () -> w.line(META_OBJECT_EXTRACT_FQN + ".extract(responseMo, input.llmResponseText(), "
                + formatEnum + ");"));
            // A required field that is lost OR malformed (present but unusable) has no value, so
            // either fails the call — the response is never handed back typed as the VO.
            w.text("""
                java.util.List<String> unusable = new java.util.ArrayList<>();
                if (outcome.report().hasLostRequired()) unusable.add("lost required: " + String.join(", ", outcome.report().lostRequired()));
                if (outcome.report().hasMalformedRequired()) unusable.add("malformed required: " + String.join(", ", outcome.report().malformedRequired()));
                boolean failed = !unusable.isEmpty();
                """);
            w.line("String status = failed ? " + CALL_INPUT_FQN + ".STATUS_ERROR : " + CALL_INPUT_FQN + ".STATUS_OK;");
            w.line("String errorDetail = failed ? String.join(\"; \", unusable) : null;");
            // Rebuild the input with derived status/errorDetail (extraction owns them).
            w.line(CALL_INPUT_FQN + " effective = new " + CALL_INPUT_FQN + "(");
            w.deeper(1, () -> w.text("""
                input.spanId(), input.traceId(), input.parentSpanId(), input.sessionId(),
                input.callType(), input.system(), input.startedAt(), input.llmRequest(),
                input.llmResponseText(), input.requestModel(), input.responseModel(),
                input.inputTokens(), input.outputTokens(), input.costMinor(), input.latencyMs(),
                input.finishReason(), status, errorDetail);
                """));
            // Build base row + set typed voRequest/voResponse via the field SPI.
            w.line(VALUE_OBJECT_FQN + " row = " + ROW_BUILDER_FQN + ".buildLlmCallRow(traceMo, effective);");
            w.text("""
                traceMo.getMetaField("voRequest").setObject(row, input.llmRequest());
                Object voResponse = failed ? null : outcome.data();
                traceMo.getMetaField("voResponse").setObject(row, voResponse);
                recorder.record(row);
                """);
            w.line("return new " + resultClass + "(status, errorDetail, voResponse);");
        }
    }

    // -------------------------------------------------------------------------
    // Resolution helpers
    // -------------------------------------------------------------------------

    /**
     * Walk the super chain looking for one of {@link #ANCHOR_FQNS}.
     *
     * <p>The FULL name, not the short one: within one loader an FQN identifies exactly
     * one node (a same-name redeclaration merges), so this is the node-identity compare
     * the TypeScript port makes against the resolved anchor node.</p>
     */
    protected static boolean extendsBase(MetaObject entity) {
        if (ANCHOR_FQNS.isEmpty()) return false;
        MetaObject cur = entity.getSuperObject();
        while (cur != null) {
            if (ANCHOR_FQNS.contains(cur.getName())) return true;
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
     * Resolve a canonical {@code @responseRef} value to its {@code object.value} target
     * exactly (ADR-0059 R7), through {@link SpringNaming#resolveValueObjectRef}. Prefer
     * {@link SpringNaming#payloadTarget} on the template node, which returns the target the
     * loader bound. {@code referrerPkg} is ignored.
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
