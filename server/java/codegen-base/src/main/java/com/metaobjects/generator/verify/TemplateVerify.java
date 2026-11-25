package com.metaobjects.generator.verify;

import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.object.MetaObject;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.render.FilesystemProvider;
import com.metaobjects.render.PayloadField;
import com.metaobjects.render.RenderException;
import com.metaobjects.render.TemplateEngines;
import com.metaobjects.render.Verify;
import com.metaobjects.render.VerifyError;
import com.metaobjects.render.VerifyOptions;
import com.metaobjects.template.MetaTemplate;
import com.metaobjects.template.PromptTemplate;
import com.metaobjects.template.TemplateConstants;
import com.metaobjects.loader.References;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Shared, Maven-free template/prompt drift check — the JVM equivalent of the
 * cross-port {@code verify --templates} surface (ADR-0021 D2). Powers
 * {@code meta:verify -Dmeta.verify.mode=templates} (Java + Kotlin alike, since
 * both share the one Maven goal).
 *
 * <p>Faithful port of the C# reference {@code MetaObjects.Cli/VerifyCommand.cs}
 * {@code Run(...)}: for every {@code template.*} node it
 * <ol>
 *   <li>derives the {@code @payloadRef} value-object's {@link PayloadField} field
 *       tree (the SAME walk {@code SpringRenderHelperGenerator} uses — object-ref
 *       fields recurse, cycle-guarded — so the build-time gate and this check agree),</li>
 *   <li>resolves every renderable body ref through a {@link FilesystemProvider}
 *       rooted at the on-disk template dir and runs the render {@link Verify} engine
 *       against each — reporting {@code {{field}}}↔payload drift, unresolved partials,
 *       and (prompts only) missing required output tags. The body refs are
 *       subtype-/kind-aware, mirroring the gen-time render-helper (#193):
 *       {@code template.prompt} → {@code @textRef} (with {@code @requiredSlots}/
 *       {@code @requiredTags}); {@code template.output} document → {@code @textRef};
 *       {@code template.output @kind=email} → {@code @subjectRef} + {@code @htmlBodyRef}
 *       + optional {@code @textBodyRef}. {@code @requiredSlots} never referenced are
 *       warnings (not failures).</li>
 * </ol>
 *
 * <p><b>Reuse, not reimplementation</b>: the actual drift logic is the render
 * {@link Verify} engine; this helper only walks the metadata to derive the field
 * tree and dispatches per subtype. It deliberately takes no Maven types so it is
 * unit-testable without a {@code Mojo} (matching how C#/Python keep verify logic
 * console/Maven-free).
 */
public final class TemplateVerify {

    private TemplateVerify() { /* no instances */ }

    /** Drift-finding kind: a {@code template.prompt} finding. */
    public static final String KIND_PROMPT = "prompt";
    /** Drift-finding kind: a {@code template.output} finding. */
    public static final String KIND_OUTPUT = "output";

    /**
     * A template's {@code @payloadRef} does not resolve to a loaded
     * {@code object.value} (empty derived field tree). Both subtypes raise this.
     */
    public static final String ERR_PAYLOAD_REF_UNRESOLVED = "ERR_PAYLOAD_REF_UNRESOLVED";

    /** A responding prompt's {@code @responseRef} names no loaded value shape with fields (an error). */
    public static final String ERR_RESPONSE_UNRESOLVED = "ERR_RESPONSE_UNRESOLVED";

    /**
     * An xml prompt's {@code @requiredTags} entry names neither the reply type nor one of its
     * fields (a warning): the body teaches the model the tag and the extractor reads the reply
     * type's fields, so a renamed reply field stops matching a tag the prompt still asks for.
     */
    public static final String ERR_RESPONSE_TAG_UNDECLARED = "ERR_RESPONSE_TAG_UNDECLARED";

    /** One reply finding: the code, the {@code @responseRef} value or offending tag, and whether it is a warning. */
    public record ResponseFinding(String code, String path, boolean warning) {}

    /** A single drift finding: which template, prompt-vs-output, the error code, the path. */
    public record Drift(String template, String kind, String code, String path) {}

    /**
     * The result of a {@code templates}-mode run.
     *
     * @param errors        hard drift findings (any one fails the build)
     * @param warnings      warning-level findings ({@code ERR_REQUIRED_SLOT_UNUSED})
     * @param unresolvedText human-readable notes for {@code @textRef}s that did not
     *                      resolve under the template root (also a failure)
     */
    public record Outcome(List<Drift> errors, List<Drift> warnings, List<String> unresolvedText) {
        /** Clean iff there are no drift errors and every {@code @textRef} resolved. */
        public boolean ok() {
            return errors.isEmpty() && unresolvedText.isEmpty();
        }
    }

    /**
     * Run the template-drift check against a loaded metadata graph.
     *
     * @param loader       a fully-initialised {@link MetaDataLoader}
     * @param templateRoot the on-disk directory each {@code @textRef} is resolved against
     */
    public static Outcome run(MetaDataLoader loader, Path templateRoot) {
        FilesystemProvider provider = new FilesystemProvider(templateRoot);

        List<Drift> errors = new ArrayList<>();
        List<Drift> warnings = new ArrayList<>();
        List<String> unresolved = new ArrayList<>();

        for (com.metaobjects.MetaData child : loader.getRoot().getChildren()) {
            if (!(child instanceof MetaTemplate tmpl)) continue;

            // The reply (@responseRef): its field tree, and an xml prompt's tag contract against it.
            // Independent of the payload check below, so it runs first.
            for (ResponseFinding f : responseFindings(loader, tmpl)) {
                Drift drift = new Drift(tmpl.getName(), KIND_PROMPT, f.code(), f.path());
                if (f.warning()) warnings.add(drift);
                else errors.add(drift);
            }

            String payloadRef = tmpl.getPayloadRef();
            // Missing @payloadRef is already a load-time error (prompt schema requires it).
            if (payloadRef == null || payloadRef.isEmpty()) continue;

            boolean isOutput = TemplateConstants.SUBTYPE_OUTPUT.equals(tmpl.getSubType());
            String kind = isOutput ? KIND_OUTPUT : KIND_PROMPT;

            // Both subtypes: @payloadRef must resolve to a loaded object.value (a
            // non-empty derived field tree). Catches a renamed VO before codegen.
            MetaObject payloadVo = valueObjectOrNull(References.refTarget(tmpl, "payloadRef"));
            List<PayloadField> fields = payloadVo == null
                    ? List.of()
                    : derivePayloadFieldTree(loader, payloadVo, new LinkedHashSet<>());
            if (fields.isEmpty()) {
                errors.add(new Drift(tmpl.getName(), kind, ERR_PAYLOAD_REF_UNRESOLVED, payloadRef));
                continue;
            }

            // Collect every renderable body ref for this template, mirroring the
            // gen-time render-helper drift gate so `verify` and `gen` agree (#193):
            //   template.prompt                    → @textRef (WITH required slots/tags).
            //   template.output document (default) → @textRef.
            //   template.output @kind=email        → @subjectRef + @htmlBodyRef + optional @textBodyRef.
            List<String> refs = new ArrayList<>();
            List<String> requiredSlots = null;
            List<String> requiredTags = null;
            if (isOutput) {
                String outKind = attrString(tmpl, TemplateConstants.ATTR_KIND);
                outKind = (outKind == null ? TemplateConstants.KIND_DEFAULT : outKind)
                        .toLowerCase(java.util.Locale.ROOT);
                if (TemplateConstants.KIND_EMAIL.equals(outKind)) {
                    addIfPresent(refs, attrString(tmpl, TemplateConstants.ATTR_SUBJECT_REF));
                    addIfPresent(refs, attrString(tmpl, TemplateConstants.ATTR_HTML_BODY_REF));
                    addIfPresent(refs, attrString(tmpl, TemplateConstants.ATTR_TEXT_BODY_REF));
                } else {
                    addIfPresent(refs, tmpl.getTextRef());
                }
            } else {
                addIfPresent(refs, tmpl.getTextRef());
                // Slot/tag requirements are a template.prompt concept; the email/document
                // gate does NOT apply them per part (they would false-flag a slot as
                // unused in each part). So only the prompt path carries them.
                requiredSlots = tmpl instanceof PromptTemplate p ? p.getRequiredSlots() : null;
                requiredTags = tmpl.getRequiredTags();
            }

            // No renderable body ref present — a loader-schema concern, not verify's
            // (a well-formed output always carries one; document→@textRef, email→subject+html).
            if (refs.isEmpty()) continue;

            VerifyOptions opts = new VerifyOptions(provider, requiredSlots, requiredTags);
            for (String ref : refs) {
                // Render-engine drift check: mustache variables ↔ payload field names.
                String text;
                try {
                    text = provider.resolve(ref);
                } catch (RenderException e) {
                    // ADR-0061: a Jinja-only body is refused by name (this port renders Mustache only).
                    if (!TemplateEngines.isEngineRefusal(e)) throw e;
                    errors.add(new Drift(tmpl.getName(), kind, TemplateEngines.ERR_TEMPLATE_ENGINE_UNSUPPORTED, ref));
                    continue;
                }
                if (text == null) {
                    unresolved.add("template \"" + tmpl.getName() + "\": ref \"" + ref
                            + "\" did not resolve under " + templateRoot);
                    continue;
                }
                for (VerifyError e : Verify.check(text, fields, opts)) {
                    Drift drift = new Drift(tmpl.getName(), kind, e.code(), e.path());
                    if (Verify.ERR_REQUIRED_SLOT_UNUSED.equals(e.code())) warnings.add(drift);
                    else errors.add(drift);
                }
            }
        }

        return new Outcome(errors, warnings, unresolved);
    }

    /**
     * The reply findings for one template, matching {@code response-verify.ts} (pinned by
     * {@code fixtures/response-verify-conformance}). Empty for anything that is not a
     * {@code template.prompt} carrying {@code @responseRef} — a prompt that elicits no typed reply
     * has nothing here. Every read is the resolving one (ADR-0039): a prompt may inherit
     * {@code @responseRef}, {@code @responseFormat} and {@code @requiredTags} via {@code extends}.
     */
    public static List<ResponseFinding> responseFindings(MetaDataLoader loader, MetaTemplate tmpl) {
        if (!TemplateConstants.SUBTYPE_PROMPT.equals(tmpl.getSubType())) return List.of();
        String responseRef = attrString(tmpl, TemplateConstants.ATTR_RESPONSE_REF);
        if (responseRef == null) return List.of();

        MetaObject reply = valueObjectOrNull(References.refTarget(tmpl, TemplateConstants.ATTR_RESPONSE_REF));
        List<PayloadField> tree = reply == null
                ? List.of()
                : derivePayloadFieldTree(loader, reply, new LinkedHashSet<>());
        if (tree.isEmpty()) {
            return List.of(new ResponseFinding(ERR_RESPONSE_UNRESOLVED, responseRef, false));
        }

        String format = attrString(tmpl, TemplateConstants.ATTR_RESPONSE_FORMAT);
        if (format == null || !TemplateConstants.RESPONSE_FORMAT_XML.equals(format.toLowerCase(java.util.Locale.ROOT))) {
            return List.of();
        }
        List<String> tags = tmpl.getRequiredTags();
        if (tags == null) return List.of();
        Set<String> known = new LinkedHashSet<>();
        known.add(reply.getShortName());
        collectFieldNames(tree, known);
        List<ResponseFinding> out = new ArrayList<>();
        for (String tag : tags) {
            if (!known.contains(tag)) out.add(new ResponseFinding(ERR_RESPONSE_TAG_UNDECLARED, tag, true));
        }
        return out;
    }

    private static void collectFieldNames(List<PayloadField> tree, Set<String> out) {
        for (PayloadField f : tree) {
            out.add(f.name());
            if (f.fields() != null) collectFieldNames(f.fields(), out);
        }
    }

    // -------------------------------------------------------------------------
    // Payload field-tree walk — mirrors SpringRenderHelperGenerator.derivePayloadFieldTree
    // (object-ref fields recurse; a `seen` set guards reference cycles; bare-shortname
    // objectRef resolution keeps the field tree byte-identical across all five ports).
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
     * The {@code object.value} a {@code field.object}'s {@code @objectRef} is bound to.
     */
    private static MetaObject resolveNestedObjectRef(MetaDataLoader loader, ObjectField field) {
        return valueObjectOrNull(References.refTarget(field, MetaObject.ATTR_OBJECT_REF));
    }

    /**
     * Resolving read of a string attr (ADR-0039: template attrs may be inherited via
     * {@code extends} — templates CAN extend). Returns null when absent or blank.
     */
    private static String attrString(com.metaobjects.MetaData md, String name) {
        // Raw resolving read (blank-guarding lives in addIfPresent, matching the C# port).
        return md.hasMetaAttr(name) ? md.getMetaAttr(name).getValueAsString() : null;
    }

    /** Append a non-blank ref to the list. */
    private static void addIfPresent(List<String> refs, String ref) {
        if (ref != null && !ref.isEmpty()) refs.add(ref);
    }

    private static MetaObject valueObjectOrNull(MetaObject obj) {
        return (obj != null && MetaObject.SUBTYPE_VALUE.equals(obj.getSubType())) ? obj : null;
    }
}
