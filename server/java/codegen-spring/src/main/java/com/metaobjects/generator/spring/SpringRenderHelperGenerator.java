package com.metaobjects.generator.spring;

// Eject note (ADR-0034, JVM eject design): this sibling stays in
// com.metaobjects.generator.spring when this generator is copied out via
// `mvn metaobjects:eject` and its own package is renamed — an explicit import, not
// same-package bare-name resolution, is what keeps the ejected copy compiling.
import com.metaobjects.generator.spring.SpringJavaWriter;
import com.metaobjects.generator.spring.SpringNaming;

import com.metaobjects.MetaData;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.GeneratorIOWriter;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.render.FilesystemProvider;
import com.metaobjects.render.PayloadField;
import com.metaobjects.render.Verify;
import com.metaobjects.render.VerifyOptions;
import com.metaobjects.template.MetaTemplate;
import com.metaobjects.template.OutputTemplate;
import com.metaobjects.template.TemplateConstants;

import java.io.IOException;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import com.metaobjects.generator.util.GeneratedFileWriter;

/**
 * Generator: one {@code <TemplateShortName>RenderHelper} Java class per RENDERABLE
 * template declaration — {@code template.output} AND {@code template.prompt}, since both
 * render an outbound body (ADR-0052) — wrapping the EXISTING JVM
 * {@link com.metaobjects.render.Renderer} engine with a typed
 * {@code render(payload, provider)} entry point — and enforcing the mustache↔VO
 * drift check ({@link Verify}) at BUILD time.
 *
 * <p>Two shapes keyed off {@code @kind}:
 * <ul>
 *   <li>{@code document} (default) → renders {@code @textRef} in {@code @format}
 *       to a single {@code String}.</li>
 *   <li>{@code email} → renders {@code @subjectRef} (text) + {@code @htmlBodyRef}
 *       (html) (+ optional {@code @textBodyRef}, text) into an
 *       {@link com.metaobjects.render.EmailDocument}.</li>
 * </ul>
 *
 * <p><b>The headline is the BUILD-TIME drift gate.</b> BEFORE emitting, every
 * referenced mustache ({@code document}: {@code @textRef}; {@code email}: the
 * subject + html (+ optional text) part-refs) is resolved through a
 * {@link FilesystemProvider} rooted at the {@code templateRoot} arg and run
 * through {@link Verify#check}. If a referenced text is unresolvable OR carries
 * any NON-warning error (i.e. anything other than {@code ERR_REQUIRED_SLOT_UNUSED}
 * — a {@code {{field}}} not on the payload VO produces {@code ERR_VAR_NOT_ON_PAYLOAD}),
 * this THROWS a {@link GeneratorException} and FAILS codegen, naming the template,
 * the ref, the error code, and the offending field. This is what makes the build
 * fail when a mustache references a field the payload VO doesn't declare.
 *
 * <p>Reuse, not reimplementation: {@link com.metaobjects.render.Renderer} (the
 * emitted runtime call), {@link Verify} (the build-time gate),
 * {@link FilesystemProvider} (build-time ref resolution), and
 * {@link com.metaobjects.render.EmailDocument} (email return type). The payload
 * {@link PayloadField} tree is walked from the VO's {@code getMetaFields()} the
 * with object-ref fields recursing, cycle-guarded — mirroring the TS port's
 * {@code derivePayloadFieldTree}.
 *
 * <p>The typed {@code render(payload, provider)} takes the {@code @payloadRef} value object's
 * own record — the one {@link SpringValueObjectGenerator} emits, referenced fully qualified
 * (ADR-0056). <b>Requires {@link SpringValueObjectGenerator} in the same run.</b>
 *
 * <p>The emitted {@code <fieldTree>} literal is baked into the {@code RenderRequest}
 * {@code verify} argument so {@link com.metaobjects.render.Renderer}'s runtime
 * drift check matches the build-time gate that ran when this file was generated.
 *
 * <p>Skips: missing {@code @payloadRef}, or a {@code @payloadRef} that doesn't resolve to an
 * {@code object.value} or sourceless {@code object.projection}.
 *
 * <p>Args:
 * <ul>
 *   <li>{@code outputDir} (required): output directory root.</li>
 *   <li>{@code templateRoot} (required): on-disk template dir the build-time
 *       drift gate resolves each referenced mustache against.</li>
 * </ul>
 *
 * <p>Mirrors the TS port's {@code render-helper-file.ts} +
 * {@code templates/render-helper.ts} (Task 3); the drift message style matches
 * exactly: {@code render-helper drift: template "<Name>" ref "<ref>" — <CODE>: {{<field>}} not on payload VO}.
 */
public class SpringRenderHelperGenerator extends MultiFileDirectGeneratorBase<MetaObject> {

    /** Arg key for the on-disk template dir used by the build-time drift gate. */
    public static final String ARG_TEMPLATE_ROOT = "templateRoot";

    /** The template root is an input (ADR-0064): editing a template regenerates. */
    @Override
    public java.util.List<String> extraInputs() {
        return hasArg(ARG_TEMPLATE_ROOT) ? java.util.List.of(getArg(ARG_TEMPLATE_ROOT)) : java.util.List.of();
    }

    @Override
    protected Class<MetaObject> getFilterClass() {
        return MetaObject.class;
    }

    @Override
    public void execute(MetaDataLoader loader) {
        parseArgs();
        Path outRoot = Paths.get(outDir.getAbsolutePath());

        String templateRoot = getArg(ARG_TEMPLATE_ROOT, false);
        if (templateRoot == null || templateRoot.isEmpty()) {
            throw new GeneratorException(
                "SpringRenderHelperGenerator requires the '" + ARG_TEMPLATE_ROOT
                    + "' arg (the on-disk template dir) for the build-time drift gate");
        }
        FilesystemProvider provider = new FilesystemProvider(Paths.get(templateRoot));

        // Stable name order — matches the other ports' deterministic emission.
        // ADR-0039: root-scan discipline — resolving children accessor.
        List<MetaTemplate> renderable = new ArrayList<>();
        for (MetaTemplate t : loader.getRoot().getChildren(MetaTemplate.class, true)) {
            if (isRenderable(t)) {
                renderable.add(t);
            }
        }
        renderable.sort(Comparator.comparing(MetaTemplate::getName));

        for (MetaTemplate tmpl : renderable) {
            emit(tmpl, loader, outRoot, provider);
        }
    }

    /**
     * True iff this generator emits a render helper for {@code node}: the node is a
     * renderable template ({@link #isRenderable}) carrying a {@code @payloadRef} that
     * resolves (against {@code loader}) to an {@code object.value}. The render helper wraps
     * the JVM Renderer — {@code @kind=document|email} for an output template, and the
     * document shape for a prompt, which carries no {@code @kind}. Extracted from the
     * {@link #execute(MetaDataLoader)} filter combined with the per-template
     * {@link #emit} skip guard.
     */
    public static boolean appliesTo(MetaData node, MetaDataLoader loader) {
        if (!(node instanceof MetaTemplate template)) return false;
        if (!isRenderable(template)) return false;
        String payloadRef = template.getPayloadRef();
        if (payloadRef == null || payloadRef.isEmpty()) return false;
        return SpringNaming.payloadTarget(template, TemplateConstants.ATTR_PAYLOAD_REF) != null;
    }

    /**
     * True iff {@code t} is a template this generator renders. BOTH template subtypes
     * render — ADR-0052 makes the subtype axis DIRECTION, and a {@code template.prompt}
     * renders an outbound body exactly as a {@code template.output} does; only what comes
     * back differs, and that inbound tier belongs to the parser/extractor generators.
     *
     * <p>This used to be {@code SUBTYPE_OUTPUT} alone, which left a {@code template.prompt}
     * with no generated render helper on this port at all — an adopter could parse a model's
     * reply from generated code but had to hand-roll the call that produced the prompt.
     * A prompt carries no {@code @kind}, so it takes the document branch of {@link #emit}
     * naturally and the email branch stays output-only.
     */
    private static boolean isRenderable(MetaTemplate t) {
        return TemplateConstants.SUBTYPE_OUTPUT.equals(t.getSubType())
            || TemplateConstants.SUBTYPE_PROMPT.equals(t.getSubType());
    }

    protected void emit(MetaTemplate template, MetaDataLoader loader, Path outRoot,
                      FilesystemProvider provider) {
        if (!appliesTo(template, loader)) {
            return; // missing @payloadRef, or not a value shape
        }
        MetaObject payloadVo = SpringNaming.payloadTarget(template, TemplateConstants.ATTR_PAYLOAD_REF);

        String[] split = SpringNaming.splitFqn(template.getName());
        String templatePkg = split[0];
        String templateShort = split[1];
        String outPkg = SpringNaming.promptsPackage(templatePkg);
        String helperClass = SpringNaming.renderHelperName(templateShort);
        // ADR-0056 — the payload IS the @payloadRef value object's own record, emitted by
        // SpringValueObjectGenerator in the value object's package; referenced fully qualified.
        SpringNaming.requireReferenceable(outPkg, payloadVo, "template '" + template.getName() + "'");
        String payloadClass = SpringNaming.valueObjectRef(payloadVo);

        // Payload field tree — reused by both the build-time gate AND baked into
        // the emitted RenderRequest.verify so the runtime check matches the gate.
        List<PayloadField> fields = derivePayloadFieldTree(loader, payloadVo, new LinkedHashSet<>());
        String fieldTreeLiteral = fieldTreeLiteral(fields);

        boolean isEmail = TemplateConstants.KIND_EMAIL.equalsIgnoreCase(kindOf(template));

        java.util.function.Consumer<SpringJavaWriter> renderMethod;
        if (isEmail) {
            String subjectRef = attrPresent(template, TemplateConstants.ATTR_SUBJECT_REF)
                ? attr(template, TemplateConstants.ATTR_SUBJECT_REF) : null;
            String htmlBodyRef = attrPresent(template, TemplateConstants.ATTR_HTML_BODY_REF)
                ? attr(template, TemplateConstants.ATTR_HTML_BODY_REF) : null;
            String textBodyRef = attrPresent(template, TemplateConstants.ATTR_TEXT_BODY_REF)
                ? attr(template, TemplateConstants.ATTR_TEXT_BODY_REF) : null;
            if (subjectRef == null) {
                throw new GeneratorException("template.output \"" + template.getName()
                    + "\" (email) missing @subjectRef");
            }
            if (htmlBodyRef == null) {
                throw new GeneratorException("template.output \"" + template.getName()
                    + "\" (email) missing @htmlBodyRef");
            }

            // BUILD-TIME drift gate — every email part-ref is resolved + verified.
            gateRef(template.getName(), subjectRef, provider, fields);
            gateRef(template.getName(), htmlBodyRef, provider, fields);
            if (textBodyRef != null) {
                gateRef(template.getName(), textBodyRef, provider, fields);
            }

            final String sRef = subjectRef, hRef = htmlBodyRef, tRef = textBodyRef;
            renderMethod = out -> writeEmailRender(out, payloadClass, sRef, hRef, tRef, fieldTreeLiteral);
        } else {
            String textRef = attrPresent(template, TemplateConstants.ATTR_TEXT_REF)
                ? attr(template, TemplateConstants.ATTR_TEXT_REF) : null;
            if (textRef == null) {
                throw new GeneratorException("template." + template.getSubType() + " \""
                    + template.getName() + "\" missing @textRef");
            }
            String format = template.getFormat();
            Integer maxChars = template.getMaxChars();

            // BUILD-TIME drift gate.
            gateRef(template.getName(), textRef, provider, fields);

            renderMethod = out -> writeDocumentRender(out, payloadClass, textRef, format, maxChars, fieldTreeLiteral);
        }

        SpringJavaWriter w = new SpringJavaWriter();
        w.header("// GENERATED — DO NOT EDIT — render helper for template." + template.getSubType()
            + " `" + template.getName() + "`");
        if (!outPkg.isEmpty()) w.packageName(outPkg);
        w.line("/** Typed render helper for the `" + templateShort + "` template." + template.getSubType()
            + ". Wraps the render() engine; the payload field tree is");
        w.line(" *  baked into the RenderRequest so render()'s runtime drift check matches the");
        w.line(" *  build-time gate enforced when this file was generated. */");
        try (var cls = w.block("public final class " + helperClass + " {")) {
            w.line("private " + helperClass + "() { /* no instances */ }");
            w.blank();
            renderMethod.accept(w);
        }

        try {
            Path outFile = outRoot.resolve(outPkg.replace('.', '/')).resolve(helperClass + ".java");
            GeneratedFileWriter.write(outFile, w.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + helperClass + ".java for template " + template.getName() + ": " + e, e);
        }
    }

    /** The email shape: one {@code RenderRequest} per part, assembled into an {@code EmailDocument}. */
    protected void writeEmailRender(SpringJavaWriter w, String payloadClass, String subjectRef,
                                    String htmlBodyRef, String textBodyRef, String fieldTreeLiteral) {
        try (var m = w.block("public static com.metaobjects.render.EmailDocument render("
                + payloadClass + " payload, com.metaobjects.render.Provider provider) {")) {
            w.line("com.metaobjects.render.Renderer r = new com.metaobjects.render.Renderer();");
            w.line("return new com.metaobjects.render.EmailDocument(");
            w.deeper(1, () -> {
                writePartRequest(w, subjectRef, "text", fieldTreeLiteral, ",");
                writePartRequest(w, htmlBodyRef, "html", fieldTreeLiteral, ",");
                if (textBodyRef != null) {
                    writePartRequest(w, textBodyRef, "text", fieldTreeLiteral, ");");
                } else {
                    w.line("null);");
                }
            });
        }
    }

    /** One email part: {@code r.render(new RenderRequest(...))} followed by {@code tail}. */
    protected void writePartRequest(SpringJavaWriter w, String ref, String format, String fieldTreeLiteral, String tail) {
        w.line("r.render(new com.metaobjects.render.RenderRequest(");
        w.deeper(1, () -> {
            w.line("null, " + quote(ref) + ", payload, provider, \"" + format + "\",");
            w.line(fieldTreeLiteral + ", null))" + tail);
        });
    }

    /** The document shape (also every prompt): one {@code RenderRequest} returning the rendered text. */
    protected void writeDocumentRender(SpringJavaWriter w, String payloadClass, String textRef, String format,
                                       Integer maxChars, String fieldTreeLiteral) {
        try (var m = w.block("public static String render(" + payloadClass
                + " payload, com.metaobjects.render.Provider provider) {")) {
            w.line("return new com.metaobjects.render.Renderer().render(new com.metaobjects.render.RenderRequest(");
            w.deeper(1, () -> {
                w.line("null, " + quote(textRef) + ", payload, provider, " + quote(format) + ",");
                w.line(fieldTreeLiteral + ", " + (maxChars == null ? "null" : maxChars.toString()) + "));");
            });
        }
    }

    // -------------------------------------------------------------------------
    // Build-time drift gate
    // -------------------------------------------------------------------------

    /**
     * Run the build-time drift gate for one referenced mustache. Throws a
     * {@link GeneratorException} (fails codegen) when the ref is unresolvable OR
     * {@link Verify#check} reports a non-warning error. Warnings
     * ({@link Verify#ERR_REQUIRED_SLOT_UNUSED}) are tolerated. Matches the TS
     * port's {@code gateRef} message style exactly.
     */
    protected static void gateRef(String templateName, String ref,
                                FilesystemProvider provider, List<PayloadField> fields) {
        String text = provider.resolve(ref);
        if (text == null) {
            throw new GeneratorException(
                "render-helper drift: template \"" + templateName + "\" ref \"" + ref
                    + "\" — unresolved (provider returned no text)");
        }
        VerifyOptions opts = new VerifyOptions(provider, null, null);
        // Fully-qualified: com.metaobjects.render.VerifyError, NOT java.lang.VerifyError.
        for (com.metaobjects.render.VerifyError e : Verify.check(text, fields, opts)) {
            if (Verify.ERR_REQUIRED_SLOT_UNUSED.equals(e.code())) continue; // warning
            throw new GeneratorException(
                "render-helper drift: template \"" + templateName + "\" ref \"" + ref
                    + "\" — " + e.code() + ": {{" + e.path() + "}} not on payload VO");
        }
    }

    // -------------------------------------------------------------------------
    // Payload field-tree walk (the value object's field iteration +
    // the TS derivePayloadFieldTree). Object-ref fields recurse; a `seen` set
    // guards reference cycles. Decoupled from origin/aggregate type resolution —
    // Verify only needs the field NAME tree + which fields push a context.
    // -------------------------------------------------------------------------

    private static List<PayloadField> derivePayloadFieldTree(
            MetaDataLoader loader, MetaObject vo, Set<String> seen) {
        if (vo == null || seen.contains(vo.getName())) return List.of();
        seen.add(vo.getName());
        List<PayloadField> fields = new ArrayList<>();
        for (MetaField<?> field : vo.getMetaFields()) {
            // ADR-0039: isArrayType() is the EFFECTIVE (inherited-via-extends) array-ness; the
            // own-only isArray() flag would read false for a field that inherits @isArray.
            boolean isArray = field.isArrayType();
            if (field instanceof ObjectField of) {
                MetaObject target = resolveNestedObjectRef(loader, of);
                if (target != null && MetaObject.SUBTYPE_VALUE.equals(target.getSubType())) {
                    List<PayloadField> children =
                        derivePayloadFieldTree(loader, target, new LinkedHashSet<>(seen));
                    fields.add(PayloadField.object(field.getName(), children, isArray));
                    continue;
                }
            }
            fields.add(PayloadField.scalar(field.getName(), isArray));
        }
        return fields;
    }

    /**
     * The {@code object.value} a {@code field.object}'s {@code @objectRef} is bound to (the
     * target the loader recorded, read resolving so an inherited ref works), or {@code null}
     * when the field has no ref, nothing resolves, or the target is not an {@code object.value}.
     */
    protected static MetaObject resolveNestedObjectRef(MetaDataLoader loader, ObjectField field) {
        MetaObject target = com.metaobjects.loader.References.refTarget(field, MetaObject.ATTR_OBJECT_REF);
        return target != null && MetaObject.SUBTYPE_VALUE.equals(target.getSubType()) ? target : null;
    }

    /**
     * Emit a {@code List<PayloadField>} as deterministic Java construction code
     * ({@code java.util.List.of(...)}): {@code PayloadField.scalar("name")} and
     * {@code PayloadField.object("nested", List.of(...))}, each with a trailing {@code , true} when the field is an array. An empty tree emits
     * {@code java.util.List.of()}.
     */
    protected static String fieldTreeLiteral(List<PayloadField> fields) {
        if (fields.isEmpty()) return "java.util.List.of()";
        StringBuilder sb = new StringBuilder("java.util.List.of(");
        for (int i = 0; i < fields.size(); i++) {
            if (i > 0) sb.append(", ");
            PayloadField f = fields.get(i);
            if (f.fields() != null) {
                sb.append("com.metaobjects.render.PayloadField.object(")
                  .append(quote(f.name())).append(", ")
                  .append(fieldTreeLiteral(f.fields())).append(f.isArray() ? ", true)" : ")");
            } else {
                sb.append("com.metaobjects.render.PayloadField.scalar(")
                  .append(quote(f.name())).append(f.isArray() ? ", true)" : ")");
            }
        }
        sb.append(")");
        return sb.toString();
    }

    // -------------------------------------------------------------------------
    // Local helpers
    // -------------------------------------------------------------------------

    // ADR-0039: template.* attrs RESOLVE through extends (includeParentData=true, the
    // default) — a template is a registered type that can be an `extends` target, so its
    // refs (@kind/@payloadRef/@subjectRef/@textRef/…) inherit. Matches the TS reference + C#.

    /** Resolve {@code @kind} (RESOLVING attr — ADR-0039), defaulting to {@code document}. */
    private static String kindOf(MetaTemplate template) {
        if (template instanceof OutputTemplate
                && template.hasMetaAttr(TemplateConstants.ATTR_KIND)) {
            String v = template.getMetaAttr(TemplateConstants.ATTR_KIND).getValueAsString();
            if (v != null && !v.isEmpty()) return v;
        }
        return TemplateConstants.KIND_DEFAULT;
    }

    /** Resolving template attr presence (ADR-0039). */
    private static boolean attrPresent(MetaTemplate template, String attr) {
        return template.hasMetaAttr(attr);
    }

    /** Resolving template attr value (ADR-0039). */
    private static String attr(MetaTemplate template, String attr) {
        return template.getMetaAttr(attr).getValueAsString();
    }

    /**
     * Resolve a canonical {@code @payloadRef} value to its {@code object.value} target
     * exactly (ADR-0059 R7), through {@link SpringNaming#resolveValueObjectRef}. Prefer
     * {@link SpringNaming#payloadTarget} on the template node, which returns the target the
     * loader bound. {@code referrerPkg} is ignored. Distinct from this file's OWN
     * {@link #resolveNestedObjectRef} (the {@code @objectRef} field-tree walk).
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
        return SpringNaming.renderHelperName(SpringNaming.splitFqn(md.getName())[1]) + ".java";
    }
}
