package com.metaobjects.generator.verify;

import com.metaobjects.field.MetaField;
import com.metaobjects.field.ObjectField;
import com.metaobjects.object.MetaObject;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.render.FilesystemProvider;
import com.metaobjects.render.PayloadField;
import com.metaobjects.render.Verify;
import com.metaobjects.render.VerifyError;
import com.metaobjects.render.VerifyOptions;
import com.metaobjects.template.MetaTemplate;
import com.metaobjects.template.PromptTemplate;
import com.metaobjects.template.TemplateConstants;
import com.metaobjects.validation.SymbolTable;

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

        // ADR-0042 — resolve @payloadRef through the loader's OWN package-local symbol table
        // (#228), so a bare ref binds the template's own package (else root-level) and an FQN
        // binds exactly — the same contract the loader validated the ref under. The prior
        // package-blind bare-tail scan bound a same-short-named value-object in the WRONG
        // package under a cross-package collision (load-order-dependent), deriving the wrong
        // field tree and mis-reporting {{field}} drift.
        SymbolTable symbols = SymbolTable.build(loader.getRoot());

        for (com.metaobjects.MetaData child : loader.getRoot().getChildren()) {
            if (!(child instanceof MetaTemplate tmpl)) continue;

            String payloadRef = tmpl.getPayloadRef();
            // Missing @payloadRef is already a load-time error (prompt schema requires it).
            if (payloadRef == null || payloadRef.isEmpty()) continue;

            boolean isOutput = TemplateConstants.SUBTYPE_OUTPUT.equals(tmpl.getSubType());
            String kind = isOutput ? KIND_OUTPUT : KIND_PROMPT;

            // Both subtypes: @payloadRef must resolve to a loaded object.value (a
            // non-empty derived field tree). Catches a renamed VO before codegen.
            MetaObject payloadVo = resolveValueObject(symbols, payloadRef, tmpl.getPackage());
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
                String text = provider.resolve(ref);
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
            if (field instanceof ObjectField of) {
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
     * {@code object.value} by BARE short-name (the cross-port render-helper
     * consensus; the raw attr value is read directly, NOT package-folded).
     */
    private static MetaObject resolveNestedObjectRef(MetaDataLoader loader, ObjectField field) {
        if (!field.hasMetaAttr(MetaObject.ATTR_OBJECT_REF, false)) return null;
        String ref = field.getMetaAttr(MetaObject.ATTR_OBJECT_REF, false).getValueAsString();
        if (ref == null || ref.isEmpty()) return null;
        // ADR-0041: a FULLY-QUALIFIED @objectRef (contains "::") resolves EXACTLY on
        // the value-object's package-qualified name — never a bare-tail fallback. A
        // bare-tail match binds a same-named object.value in the WRONG package when
        // the short name collides across packages (e.g. two prompt trees each declare
        // their own `PlayerActionView`/`MemoryView`), yielding the wrong element
        // field-tree and spurious ERR_VAR_NOT_ON_PAYLOAD on the inner {{fields}}. A
        // bare ref (no "::") still matches the object.value's short name (the
        // cross-port render-helper consensus). Mirrors the Kotlin render helper.
        boolean fqn = ref.contains("::");
        String refShort = shortName(ref);
        for (MetaObject obj : loader.getMetaObjects()) {
            if (!MetaObject.SUBTYPE_VALUE.equals(obj.getSubType())) continue;
            boolean matches = fqn
                    ? obj.getName().equals(ref)
                    : shortName(obj.getName()).equals(refShort);
            if (matches) return obj;
        }
        return null;
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

    /**
     * Resolve {@code @payloadRef} to its {@code object.value} target under the loader's ADR-0042
     * package-local contract (rejects entities). {@code referrerPkg} is the template's own package
     * ({@code ""} for a root-level template): a bare ref binds {@code <referrerPkg>::<ref>} first,
     * else a root-level object; an FQN binds exactly — no cross-package bare-name fallback.
     */
    private static MetaObject resolveValueObject(SymbolTable symbols, String ref, String referrerPkg) {
        MetaObject obj = symbols.resolveObject(ref, referrerPkg == null ? "" : referrerPkg);
        return (obj != null && MetaObject.SUBTYPE_VALUE.equals(obj.getSubType())) ? obj : null;
    }

    /** Last {@code ::} segment of a (possibly packaged) metadata name. */
    private static String shortName(String fqn) {
        int sep = fqn.lastIndexOf("::");
        return sep < 0 ? fqn : fqn.substring(sep + 2);
    }
}
