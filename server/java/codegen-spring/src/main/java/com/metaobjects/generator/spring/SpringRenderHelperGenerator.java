package com.metaobjects.generator.spring;

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

/**
 * Generator: one {@code <TemplateShortName>RenderHelper} Java class per
 * {@code template.output} declaration, wrapping the EXISTING JVM
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
 * same way {@code SpringPayloadGenerator} walks it (object-ref fields recurse,
 * cycle-guarded) — mirroring the TS port's {@code derivePayloadFieldTree}.
 *
 * <p>The emitted {@code <fieldTree>} literal is baked into the {@code RenderRequest}
 * {@code verify} argument so {@link com.metaobjects.render.Renderer}'s runtime
 * drift check matches the build-time gate that ran when this file was generated.
 *
 * <p>Skips (same contract as {@code SpringOutputPromptGenerator} /
 * {@code SpringPayloadGenerator}): missing {@code @payloadRef}, or a
 * {@code @payloadRef} that doesn't resolve to an {@code object.value}.
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
        List<MetaTemplate> outputs = new ArrayList<>();
        for (MetaTemplate t : loader.getRoot().getChildren(MetaTemplate.class, true)) {
            if (TemplateConstants.SUBTYPE_OUTPUT.equals(t.getSubType())) {
                outputs.add(t);
            }
        }
        outputs.sort(Comparator.comparing(MetaTemplate::getName));

        for (MetaTemplate tmpl : outputs) {
            emit(tmpl, loader, outRoot, provider);
        }
    }

    /**
     * True iff this generator emits a render helper for {@code node}: the node is a
     * {@code template.output} carrying a {@code @payloadRef} that resolves (against
     * {@code loader}) to an {@code object.value}. The render helper wraps the JVM
     * Renderer for {@code @kind=document|email} output templates. Extracted from
     * the {@link #execute(MetaDataLoader)} {@code SUBTYPE_OUTPUT} filter combined
     * with the per-template {@link #emit} skip guard.
     */
    public static boolean appliesTo(MetaData node, MetaDataLoader loader) {
        if (!(node instanceof MetaTemplate template)) return false;
        if (!TemplateConstants.SUBTYPE_OUTPUT.equals(template.getSubType())) return false;
        String payloadRef = template.getPayloadRef();
        if (payloadRef == null || payloadRef.isEmpty()) return false;
        return resolveValueObject(loader, payloadRef,
            com.metaobjects.util.MetaDataUtil.findPackageForMetaData(template)) != null;
    }

    protected void emit(MetaTemplate template, MetaDataLoader loader, Path outRoot,
                      FilesystemProvider provider) {
        if (!appliesTo(template, loader)) {
            return; // missing @payloadRef, or not a VO — same contract as SpringPayloadGenerator
        }
        MetaObject payloadVo = resolveValueObject(loader, template.getPayloadRef(),
            com.metaobjects.util.MetaDataUtil.findPackageForMetaData(template));

        String[] split = SpringNaming.splitFqn(template.getName());
        String templatePkg = split[0];
        String templateShort = split[1];
        String outPkg = SpringNaming.promptsPackage(templatePkg);
        String helperClass = SpringNaming.renderHelperName(templateShort);
        // SpringPayloadGenerator names the payload record <CapitalizedTemplateShortName>Payload
        // (derived from the template short name, NOT the VO name) into the same
        // <pkg>.prompts package — reference it by its same-package short name.
        String payloadClass = SpringNaming.payloadName(templateShort);

        // Payload field tree — reused by both the build-time gate AND baked into
        // the emitted RenderRequest.verify so the runtime check matches the gate.
        List<PayloadField> fields = derivePayloadFieldTree(loader, payloadVo, new LinkedHashSet<>());
        String fieldTreeLiteral = fieldTreeLiteral(fields);

        boolean isEmail = TemplateConstants.KIND_EMAIL.equalsIgnoreCase(kindOf(template));

        StringBuilder body = new StringBuilder();
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

            body.append("    public static com.metaobjects.render.EmailDocument render(")
                .append(payloadClass).append(" payload, com.metaobjects.render.Provider provider) {\n");
            body.append("        com.metaobjects.render.Renderer r = new com.metaobjects.render.Renderer();\n");
            body.append("        return new com.metaobjects.render.EmailDocument(\n");
            body.append("            r.render(new com.metaobjects.render.RenderRequest(\n")
                .append("                null, ").append(quote(subjectRef))
                .append(", payload, provider, \"text\",\n")
                .append("                ").append(fieldTreeLiteral).append(", null)),\n");
            body.append("            r.render(new com.metaobjects.render.RenderRequest(\n")
                .append("                null, ").append(quote(htmlBodyRef))
                .append(", payload, provider, \"html\",\n")
                .append("                ").append(fieldTreeLiteral).append(", null)),\n");
            if (textBodyRef != null) {
                body.append("            r.render(new com.metaobjects.render.RenderRequest(\n")
                    .append("                null, ").append(quote(textBodyRef))
                    .append(", payload, provider, \"text\",\n")
                    .append("                ").append(fieldTreeLiteral).append(", null)));\n");
            } else {
                body.append("            null);\n");
            }
            body.append("    }\n");
        } else {
            String textRef = attrPresent(template, TemplateConstants.ATTR_TEXT_REF)
                ? attr(template, TemplateConstants.ATTR_TEXT_REF) : null;
            if (textRef == null) {
                throw new GeneratorException("template.output \"" + template.getName()
                    + "\" (document) missing @textRef");
            }
            String format = template.getFormat();
            Integer maxChars = template.getMaxChars();

            // BUILD-TIME drift gate.
            gateRef(template.getName(), textRef, provider, fields);

            body.append("    public static String render(")
                .append(payloadClass).append(" payload, com.metaobjects.render.Provider provider) {\n");
            body.append("        return new com.metaobjects.render.Renderer().render(new com.metaobjects.render.RenderRequest(\n");
            body.append("            null, ").append(quote(textRef)).append(", payload, provider, ")
                .append(quote(format)).append(",\n");
            body.append("            ").append(fieldTreeLiteral).append(", ")
                .append(maxChars == null ? "null" : maxChars.toString()).append("));\n");
            body.append("    }\n");
        }

        StringBuilder src = new StringBuilder();
        src.append("// GENERATED — DO NOT EDIT — render helper for template.output `")
           .append(template.getName()).append("`\n");
        src.append("package ").append(outPkg).append(";\n\n");
        src.append("/** Typed render helper for the `").append(templateShort)
           .append("` template.output. Wraps the render() engine; the payload field tree is\n")
           .append(" *  baked into the RenderRequest so render()'s runtime drift check matches the\n")
           .append(" *  build-time gate enforced when this file was generated. */\n");
        src.append("public final class ").append(helperClass).append(" {\n\n");
        src.append("    private ").append(helperClass).append("() { /* no instances */ }\n\n");
        src.append(body);
        src.append("}\n");

        try {
            Path outFile = outRoot.resolve(outPkg.replace('.', '/')).resolve(helperClass + ".java");
            if (outFile.getParent() != null) Files.createDirectories(outFile.getParent());
            Files.writeString(outFile, src.toString());
        } catch (IOException e) {
            throw new GeneratorException(
                "failed writing " + helperClass + ".java for template " + template.getName() + ": " + e, e);
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
    // Payload field-tree walk (mirrors SpringPayloadGenerator field iteration +
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
            if (field instanceof ObjectField of) {
                // Resolve the nested @objectRef by BARE short-name — the cross-port
                // render-helper consensus (TS findObject: c.type === OBJECT &&
                // c.name === ref). Do NOT use of.getObjectRef() here: that runs the
                // JVM package-FOLDING resolver, which expands a bare ref relative to
                // the FIELD's package and diverges from TS/C#/Python/Kotlin for a
                // PACKAGED payload VO. The render-helper field-tree must resolve
                // identically across all five ports; only this walk changes —
                // MetaDataUtil.getObjectRef and other generators are untouched.
                MetaObject target = resolveNestedObjectRef(loader, of);
                if (target != null && MetaObject.SUBTYPE_VALUE.equals(target.getSubType())) {
                    List<PayloadField> children =
                        derivePayloadFieldTree(loader, target, new LinkedHashSet<>(seen));
                    fields.add(PayloadField.object(field.getName(), children));
                    continue;
                }
            }
            fields.add(PayloadField.scalar(field.getName()));
        }
        return fields;
    }

    /**
     * Resolve a {@code field.object}'s {@code @objectRef} to its target
     * {@code object.value} under the ADR-0042 package-local contract — mirroring the
     * TS render-helper's {@code resolveObjectRef(root, ref, declaringFieldPkg)}:
     * <ul>
     *   <li>an <b>FQN</b> {@code @objectRef} (contains {@code ::}) resolves EXACTLY on
     *       the object's package-qualified name — never a bare-tail fallback that would
     *       bind a same-named {@code object.value} in the WRONG package;</li>
     *   <li>a <b>bare</b> {@code @objectRef} resolves in the DECLARING field's package
     *       ({@code <fieldPkg>::<ref>} — correct for a {@code field.object} inherited via
     *       extends across packages), else a root-level {@code object.value}. Package-local
     *       BEFORE root-level; no cross-package short-name fallback.</li>
     * </ul>
     * Returns {@code null} if the field has no {@code @objectRef} or nothing resolves.
     */
    protected static MetaObject resolveNestedObjectRef(MetaDataLoader loader, ObjectField field) {
        // ADR-0039: @objectRef is an inheritable effective field property — a concrete
        // field.object may inherit it from an abstract parent via extends. RESOLVE
        // (default includeParentData=true); own-only would miss the inherited ref.
        if (!field.hasMetaAttr(MetaObject.ATTR_OBJECT_REF)) return null;
        String ref = field.getMetaAttr(MetaObject.ATTR_OBJECT_REF).getValueAsString();
        if (ref == null || ref.isEmpty()) return null;
        boolean fqn = ref.contains("::");
        // The DECLARING field's package (walks parents; for an inherited field.object it is
        // the package where the field is DECLARED, not where it is used).
        String referrerPkg = com.metaobjects.util.MetaDataUtil.findPackageForMetaData(field);
        if (referrerPkg == null) referrerPkg = "";
        String localKey = (fqn || referrerPkg.isEmpty()) ? ref : referrerPkg + "::" + ref;
        MetaObject own = null;
        MetaObject rootLevel = null;
        for (MetaObject obj : loader.getMetaObjects()) {
            if (!MetaObject.SUBTYPE_VALUE.equals(obj.getSubType())) continue;
            if (obj.getName().equals(localKey)) own = obj;
            if (!fqn && obj.getName().equals(ref)) rootLevel = obj;
        }
        if (fqn) return own;
        return own != null ? own : rootLevel;
    }

    /**
     * Emit a {@code List<PayloadField>} as deterministic Java construction code
     * ({@code java.util.List.of(...)}): {@code PayloadField.scalar("name")} and
     * {@code PayloadField.object("nested", List.of(...))}. An empty tree emits
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
                  .append(fieldTreeLiteral(f.fields())).append(")");
            } else {
                sb.append("com.metaobjects.render.PayloadField.scalar(")
                  .append(quote(f.name())).append(")");
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
     * Resolve {@code @payloadRef} to its {@code object.value} target (rejects entities)
     * under the ADR-0042 package-local contract (#228) — was a package-BLIND bare-name
     * scan (first match wins, load-order-dependent); now delegates to the shared
     * {@link SpringNaming#resolveValueObjectRef}. Distinct from this file's OWN
     * {@link #resolveNestedObjectRef} (the {@code @objectRef} field-tree walk), which was
     * ALREADY package-local-correct.
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
