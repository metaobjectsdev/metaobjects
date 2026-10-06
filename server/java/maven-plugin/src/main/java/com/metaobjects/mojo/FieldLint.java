package com.metaobjects.mojo;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.metaobjects.field.MetaField;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import org.yaml.snakeyaml.LoaderOptions;
import org.yaml.snakeyaml.Yaml;
import org.yaml.snakeyaml.constructor.SafeConstructor;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * {@code metaobjects:verify} — the field AUTHORING lint.
 *
 * <p>Two metadata mistakes about an object's FIELDS load with no error on every port:</p>
 * <ol>
 *   <li>An {@code identity.reference} whose {@code @fields} names a field the object does
 *       not have. The loader resolves {@code @references} (the target) and never looks at
 *       {@code @fields}, so a typo there produces a foreign key over a column nothing
 *       declares.</li>
 *   <li>Two {@code field.*} children with the same {@code name} in one object's
 *       {@code children} list. The later declaration is folded into the first, and one of
 *       a different subtype is dropped, both silently.</li>
 * </ol>
 *
 * <p><b>Why these are warnings and not load errors.</b> {@code docs/compatibility-policy.md}
 * does not allow a new load error for metadata that loads today, so every finding here is a
 * warning by construction: nothing in this class fails a build.</p>
 *
 * <p><b>The two halves read different things</b>, and have to. The reference half reads the
 * LOADED model, because "does this object have that field" is a question about the EFFECTIVE
 * field set — inherited through {@code extends} and merged from overlay files. The duplicate
 * half reads the RAW DOCUMENTS, because the merge has already erased the duplicate from the
 * model by the time anything can ask.</p>
 *
 * <p>Mirrors the TS reference ({@code packages/cli/src/lib/field-lint.ts} +
 * {@code packages/metadata/src/loader/declared-duplicate-fields.ts}). The codes, the message
 * text and the fixtures are shared: {@code fixtures/field-lint-conformance/}. Kotlin runs
 * through this same goal.</p>
 */
public final class FieldLint {

    /** An {@code identity.reference} lists a field its object does not have. */
    public static final String WARN_REFERENCE_FIELD_NOT_FOUND = "WARN_REFERENCE_FIELD_NOT_FOUND";
    /** One {@code children} list declares the same field name more than once. */
    public static final String WARN_DUPLICATE_FIELD_NAME = "WARN_DUPLICATE_FIELD_NAME";

    /** Opt-out environment variable, beside {@code -Dmeta.verify.noFieldLint} (Node {@code meta} parity). */
    public static final String ENV_OPT_OUT = "META_NO_FIELD_LINT";

    private static final String KEY_NAME = "name";
    private static final String KEY_PACKAGE = "package";
    private static final String KEY_CHILDREN = "children";
    private static final String ROOT_KEY_BARE = "metadata";
    private static final String ROOT_KEY_FUSED = "metadata.root";
    private static final String TYPE_OBJECT = MetaObject.TYPE_OBJECT;
    private static final String TYPE_FIELD = MetaField.TYPE_FIELD;
    private static final String PACKAGE_SEPARATOR = "::";
    private static final char TYPE_SUBTYPE_SEPARATOR = '.';
    /** The YAML authoring sugar for {@code isArray: true} — a suffix on the wrapper key. */
    private static final String ARRAY_SUFFIX = "[]";

    // The JSON string form, so the text is byte-identical to the other ports'.
    private static final Gson QUOTER = new GsonBuilder().disableHtmlEscaping().create();

    /** One advisory finding: its code, the node's address, and the message. */
    public record Finding(String code, String path, String message) {}

    private FieldLint() {}

    private static String quote(String value) {
        return QUOTER.toJson(value);
    }

    /** Report every {@code identity.reference} whose {@code @fields} names a field its object lacks. */
    public static List<Finding> lintReferenceFields(MetaDataLoader loader) {
        List<Finding> findings = new ArrayList<>();
        // ADR-0039: own — the root's own children in declaration order (a root has no super).
        for (MetaObject object : loader.getRoot().getChildren(MetaObject.class, false)) {
            String address = object.getName();
            // RESOLVING: the effective field set — a field inherited through `extends` or
            // added by an overlay file is a field the object has.
            Set<String> fields = new HashSet<>();
            for (MetaField field : object.getMetaFields()) fields.add(field.getName());
            // ADR-0039: own (sanctioned case) — report each DECLARATION once, on the object
            // that declares it. The resolving read would repeat an inherited reference on
            // every subtype.
            for (MetaIdentity identity : object.getChildren(MetaIdentity.class, false)) {
                if (!identity.isReference()) continue;
                // RESOLVING: getFields() reads @fields through the identity's own `extends`.
                for (String name : identity.getFields()) {
                    if (fields.contains(name)) continue;
                    findings.add(new Finding(
                            WARN_REFERENCE_FIELD_NOT_FOUND,
                            address + "." + identity.getName(),
                            "identity.reference " + quote(identity.getName()) + " lists " + quote(name)
                                    + " in @fields, but " + address + " has no field of that name, inherited and "
                                    + "overlaid fields included. Nothing checks this at load, so the reference is "
                                    + "built on a field that does not exist. Rename the entry to an existing field, "
                                    + "or declare the field."));
                }
            }
        }
        return findings;
    }

    /**
     * Structurally scan one document's raw content and report every field name a root-level
     * object declares more than once in its own {@code children} list.
     *
     * <p>Scope is ONE children list: a field redeclared by an overlay file, or by a subtype
     * overriding an inherited field, is not in one list and is not a finding. Malformed
     * shapes return an empty list; a syntax error throws, as the parser's own would.</p>
     *
     * @param yaml {@code true} for a YAML document, {@code false} for JSON
     */
    public static List<Finding> declaredDuplicateFields(String content, boolean yaml) {
        List<Finding> findings = new ArrayList<>();
        String normalized = !content.isEmpty() && content.charAt(0) == '﻿' ? content.substring(1) : content;
        Object parsed = yaml
                ? new Yaml(new SafeConstructor(new LoaderOptions())).load(normalized)
                : QUOTER.fromJson(normalized, Object.class);
        if (!(parsed instanceof Map<?, ?> document)) return findings;

        // JSON fuses the subtype onto the root key; sigil-free YAML may write the bare type.
        Object rootBody = document.containsKey(ROOT_KEY_FUSED) ? document.get(ROOT_KEY_FUSED) : document.get(ROOT_KEY_BARE);
        if (!(rootBody instanceof Map<?, ?> root)) return findings;
        String rootPkg = root.get(KEY_PACKAGE) instanceof String s ? s : "";
        if (!(root.get(KEY_CHILDREN) instanceof List<?> children)) return findings;

        for (Object child : children) {
            if (!(child instanceof Map<?, ?> wrapper)) continue;
            for (Map.Entry<?, ?> entry : wrapper.entrySet()) {
                if (!(entry.getKey() instanceof String wrapperKey) || !TYPE_OBJECT.equals(wrapperType(wrapperKey))) continue;
                if (!(entry.getValue() instanceof Map<?, ?> body)) continue;
                String name = declaredName(body);
                if (name == null || !(body.get(KEY_CHILDREN) instanceof List<?> members)) continue;

                // Insertion-ordered, so findings come out in document order.
                Map<String, Integer> counts = new LinkedHashMap<>();
                for (Object member : members) {
                    if (!(member instanceof Map<?, ?> memberWrapper)) continue;
                    for (Map.Entry<?, ?> memberEntry : memberWrapper.entrySet()) {
                        if (!(memberEntry.getKey() instanceof String memberKey) || !TYPE_FIELD.equals(wrapperType(memberKey))) continue;
                        String fieldName = declaredName(memberEntry.getValue());
                        if (fieldName != null) counts.merge(fieldName, 1, Integer::sum);
                    }
                }

                // The resolution key the parser gives a root-level node: its own `package`
                // (a `::`-prefixed one is relative to the root's), else the root's.
                String pkg = rootPkg;
                if (body.get(KEY_PACKAGE) instanceof String ownPkg && !ownPkg.isEmpty()) {
                    boolean relative = !rootPkg.trim().isEmpty() && ownPkg.startsWith(PACKAGE_SEPARATOR);
                    pkg = relative ? rootPkg + ownPkg : ownPkg;
                }
                String address = pkg.isEmpty() ? name : pkg + PACKAGE_SEPARATOR + name;
                for (Map.Entry<String, Integer> count : counts.entrySet()) {
                    if (count.getValue() < 2) continue;
                    findings.add(new Finding(
                            WARN_DUPLICATE_FIELD_NAME,
                            address + "." + count.getKey(),
                            address + " declares the field " + quote(count.getKey()) + " " + count.getValue()
                                    + " times in one children list. Nothing reports this at load, and only the first "
                                    + "declaration is certain to take effect. Remove or rename the duplicate."));
                }
            }
        }
        return findings;
    }

    /**
     * Run {@link #declaredDuplicateFields} over each metadata file. Unreadable or unparsable
     * files are skipped — the loader reports those itself.
     */
    public static List<Finding> lintDuplicateFields(List<Path> files) {
        List<Finding> findings = new ArrayList<>();
        for (Path file : files) {
            try {
                String lower = file.getFileName().toString().toLowerCase(Locale.ROOT);
                boolean yaml = lower.endsWith(".yaml") || lower.endsWith(".yml");
                findings.addAll(declaredDuplicateFields(Files.readString(file, StandardCharsets.UTF_8), yaml));
            } catch (Exception e) {
                // An advisory scan never breaks verify.
            }
        }
        return findings;
    }

    /** The TYPE segment of a wrapper key: {@code field.string[]} and bare {@code field} are both {@code field}. */
    private static String wrapperType(String key) {
        int dot = key.indexOf(TYPE_SUBTYPE_SEPARATOR);
        String head = dot < 0 ? key : key.substring(0, dot);
        return head.endsWith(ARRAY_SUFFIX) ? head.substring(0, head.length() - ARRAY_SUFFIX.length()) : head;
    }

    /** A node's declared name: the body's {@code name}, or the body itself when YAML wrote a scalar. */
    private static String declaredName(Object body) {
        Object name = body instanceof Map<?, ?> mapping ? mapping.get(KEY_NAME) : body;
        return name instanceof String s && !s.isEmpty() ? s : null;
    }
}
