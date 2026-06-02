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
 *   <li>for {@code template.output}: a payload-resolution-only check (the parser
 *       schema is derived from the same VO; field-tree drift surfaces here AND at
 *       gen time),</li>
 *   <li>for {@code template.prompt}: resolves {@code @textRef} through a
 *       {@link FilesystemProvider} rooted at the on-disk template dir and runs the
 *       render {@link Verify} engine — reporting {@code {{field}}}↔payload drift,
 *       unresolved partials, and missing required output tags. {@code @requiredSlots}
 *       that are never referenced are warnings (not failures).</li>
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

        for (com.metaobjects.MetaData child : loader.getRoot().getChildren()) {
            if (!(child instanceof MetaTemplate tmpl)) continue;

            String payloadRef = tmpl.getPayloadRef();
            // Missing @payloadRef is already a load-time error (prompt schema requires it).
            if (payloadRef == null || payloadRef.isEmpty()) continue;

            boolean isOutput = TemplateConstants.SUBTYPE_OUTPUT.equals(tmpl.getSubType());
            String kind = isOutput ? KIND_OUTPUT : KIND_PROMPT;

            // Both subtypes: @payloadRef must resolve to a loaded object.value (a
            // non-empty derived field tree). Catches a renamed VO before codegen.
            MetaObject payloadVo = resolveValueObject(loader, payloadRef);
            List<PayloadField> fields = payloadVo == null
                    ? List.of()
                    : derivePayloadFieldTree(loader, payloadVo, new LinkedHashSet<>());
            if (fields.isEmpty()) {
                errors.add(new Drift(tmpl.getName(), kind, ERR_PAYLOAD_REF_UNRESOLVED, payloadRef));
                continue;
            }

            if (isOutput) {
                // Output's parser schema is derived from the same VO that drives prompt
                // rendering — payload-VO resolution above covers the drift contract.
                // No @textRef walk: output templates may not carry one (the parser is
                // schema-driven), and the generator surfaces gen-time issues directly.
                continue;
            }

            // template.prompt branch — Mustache + tag/slot checks via the render engine.
            String textRef = tmpl.getTextRef();
            if (textRef == null || textRef.isEmpty()) continue;

            String text = provider.resolve(textRef);
            if (text == null) {
                unresolved.add("template \"" + tmpl.getName() + "\": @textRef \"" + textRef
                        + "\" did not resolve under " + templateRoot);
                continue;
            }

            List<String> requiredSlots = tmpl instanceof PromptTemplate p ? p.getRequiredSlots() : null;
            List<String> requiredTags = tmpl.getRequiredTags();

            VerifyOptions opts = new VerifyOptions(provider, requiredSlots, requiredTags);
            for (VerifyError e : Verify.check(text, fields, opts)) {
                Drift drift = new Drift(tmpl.getName(), kind, e.code(), e.path());
                if (Verify.ERR_REQUIRED_SLOT_UNUSED.equals(e.code())) warnings.add(drift);
                else errors.add(drift);
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
        String refShort = shortName(ref);
        for (MetaObject obj : loader.getMetaObjects()) {
            if (!MetaObject.SUBTYPE_VALUE.equals(obj.getSubType())) continue;
            if (shortName(obj.getName()).equals(refShort)) return obj;
        }
        return null;
    }

    /** Resolve {@code @payloadRef} to its {@code object.value} target (rejects entities). */
    private static MetaObject resolveValueObject(MetaDataLoader loader, String ref) {
        for (MetaObject obj : loader.getMetaObjects()) {
            if (!MetaObject.SUBTYPE_VALUE.equals(obj.getSubType())) continue;
            if (obj.getName().equals(ref)) return obj;
            if (shortName(obj.getName()).equals(ref)) return obj;
        }
        return null;
    }

    /** Last {@code ::} segment of a (possibly packaged) metadata name. */
    private static String shortName(String fqn) {
        int sep = fqn.lastIndexOf("::");
        return sep < 0 ? fqn : fqn.substring(sep + 2);
    }
}
