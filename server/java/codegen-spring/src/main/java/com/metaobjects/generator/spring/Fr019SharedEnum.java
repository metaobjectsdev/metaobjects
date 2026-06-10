package com.metaobjects.generator.spring;

import com.metaobjects.MetaRoot;
import com.metaobjects.field.EnumField;
import com.metaobjects.field.MetaField;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.util.GeneratorUtil;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * FR-019 — shared + externally-provided enum resolution (Java/Spring port of the TS
 * reference {@code server/typescript/packages/codegen-ts/src/enum-shared.ts} and the
 * C# {@code Fr019SharedEnum}).
 *
 * <p>A reusable enum is a ROOT/package-level abstract {@code field.enum} (a sibling of
 * {@code object.entity}) that concrete entity fields {@code extends}. Per ADR-0026 such a
 * declaration is materialized ONCE per port as a standalone Java {@code enum} (one file,
 * {@code Priority.java}) and referenced, instead of being redeclared inline (a nested
 * {@code public enum E}) in every consuming DTO record.</p>
 *
 * <p>Two cases on the abstract declaration:</p>
 * <ul>
 *   <li>non-{@code @provided} → metaobjects MATERIALIZES the type once (a standalone
 *       {@code <Name>.java} in the declaration's metadata package), and consuming fields
 *       reference it (a bare {@code E} when the DTO shares the package, else the FQN
 *       {@code <pkg>.E}).</li>
 *   <li>{@code @provided: true} → metaobjects emits NOTHING for the type; consuming fields
 *       reference an existing hand-written/third-party type resolved via per-port codegen
 *       config (a package&rarr;namespace map + a single fallback, both generator args). The
 *       namespace never lives in metadata (ADR-0001); a missing config for a referenced
 *       provided enum is a codegen-time error naming the enum + its package.</li>
 * </ul>
 *
 * <p>The common inline case (a concrete {@code field.enum} with {@code @values} declared
 * directly, no root-extends — or an abstract enum nested INSIDE an entity) is UNCHANGED — it
 * stays a per-entity nested {@code <Owner><Field>}/super-named enum. Shared + {@code @provided}
 * are additive branches gated on "root-level abstract {@code field.enum}", so the inline default
 * output is byte-identical.</p>
 */
public final class Fr019SharedEnum {

    private Fr019SharedEnum() { /* no instances */ }

    /**
     * A shared (root-level abstract) enum declaration codegen must reason about.
     *
     * @param name        the materialized type name — the declaration's PascalCase short name
     *                    (cross-port identity, same scheme as {@link SpringTypeMapper#enumTypeName})
     * @param values      member symbols (the {@code @values} SSOT), verbatim
     * @param provided    {@code true} when the declaration carries {@code @provided: true}
     * @param metaPackage the declaration's metadata package in {@code ::} form (e.g.
     *                    {@code "acme::shop"}), the key into the provided-enum package map
     * @param javaPackage the same package in Java dotted form (e.g. {@code "acme.shop"})
     */
    public record SharedEnum(String name, List<String> values, boolean provided,
                             String metaPackage, String javaPackage) { }

    /** Per-port codegen config for resolving a {@code @provided} enum's Java namespace (ADR-0001).
     * Generator args, never metadata: a package&rarr;namespace map (keyed by metadata package in
     * {@code ::} form) plus a single {@code fallbackNamespace} for the one-namespace case. */
    public record ProvidedEnumConfig(String fallbackNamespace, Map<String, String> packageNamespaces) {
        public static ProvidedEnumConfig of(String fallbackNamespace, String packageMapArg) {
            return new ProvidedEnumConfig(
                fallbackNamespace == null || fallbackNamespace.isBlank() ? null : fallbackNamespace.trim(),
                parsePackageMap(packageMapArg));
        }
    }

    /**
     * Parse the {@code providedEnumPackages} generator arg — a {@code ;}-delimited list of
     * {@code <metaPackage>=<namespace>} entries (the metadata package in {@code ::} form), e.g.
     * {@code "acme::shop=com.acme.ext;acme::billing=com.acme.money"}. Returns an empty map for a
     * null/blank arg. Malformed entries (no {@code =}) are skipped.
     */
    public static Map<String, String> parsePackageMap(String arg) {
        Map<String, String> map = new LinkedHashMap<>();
        if (arg == null || arg.isBlank()) return map;
        for (String entry : arg.split(";")) {
            int eq = entry.indexOf('=');
            if (eq <= 0) continue;
            String key = entry.substring(0, eq).trim();
            String val = entry.substring(eq + 1).trim();
            if (!key.isEmpty() && !val.isEmpty()) map.put(key, val);
        }
        return map;
    }

    /**
     * The root-level abstract {@code field.enum} a concrete enum field resolves to via
     * {@code extends}, or {@code null} when the field is an inline enum (no root-abstract super).
     * A super qualifies only when it is (a) an {@link EnumField}, (b) abstract, AND (c) a direct
     * child of the metadata root ({@link MetaRoot}) — NOT an abstract field nested inside an object.
     */
    public static MetaField<?> resolveSharedEnumDecl(MetaField<?> field) {
        if (!(field instanceof EnumField)) return null;
        MetaField<?> sup = field.getSuperField();
        if (!(sup instanceof EnumField)) return null;
        if (!GeneratorUtil.isAbstract(sup)) return null;
        // The declaration must sit at the package/root level (a sibling of object.entity).
        if (!(sup.getParent() instanceof MetaRoot)) return null;
        return sup;
    }

    /** The shared-enum descriptor a field resolves to, or {@code null} for inline enums. */
    public static SharedEnum sharedEnumForField(MetaField<?> field) {
        MetaField<?> decl = resolveSharedEnumDecl(field);
        if (decl == null) return null;
        List<String> values = SpringTypeMapper.effectiveEnumValues((EnumField) decl);
        if (values.isEmpty()) return null;
        String[] split = SpringNaming.splitFqn(decl.getName()); // [javaPkg, shortName]
        String javaPackage = split[0];
        String name = SpringNaming.capitalize(split[1]);
        String metaPackage = metaPackageOf(decl.getName());
        return new SharedEnum(name, values, isProvided((EnumField) decl), metaPackage, javaPackage);
    }

    /** The declaration's metadata package in {@code ::} form, stripped of the trailing {@code ::Name}
     * (empty when the declaration carries no package). */
    private static String metaPackageOf(String fqn) {
        int idx = fqn.lastIndexOf("::");
        return idx < 0 ? "" : fqn.substring(0, idx);
    }

    /** Own-only read of {@code @provided} on an enum declaration. */
    private static boolean isProvided(EnumField decl) {
        if (!decl.hasMetaAttr(EnumField.ATTR_PROVIDED, false)) return false;
        Object raw = decl.getMetaAttr(EnumField.ATTR_PROVIDED, false).getValue();
        if (raw instanceof Boolean b) return b;
        return Boolean.parseBoolean(String.valueOf(raw));
    }

    /**
     * All shared (root-level abstract) enum declarations in the loaded model that are actually
     * CONSUMED by at least one concrete entity field — keyed by materialized type name, sorted by
     * name (deterministic). A declaration nobody extends is not materialized (no dangling type).
     * Only {@code object.entity} fields are considered (the DTO scope); payload value-objects keep
     * their own inline nesting.
     */
    public static List<SharedEnum> collectSharedEnums(MetaDataLoader loader) {
        Map<String, SharedEnum> out = new LinkedHashMap<>();
        for (MetaObject entity : loader.getMetaObjects()) {
            if (!MetaObject.SUBTYPE_ENTITY.equals(entity.getSubType())) continue;
            for (MetaField<?> field : entity.getMetaFields()) {
                SharedEnum shared = sharedEnumForField(field);
                if (shared == null) continue;
                out.putIfAbsent(shared.name(), shared);
            }
        }
        List<SharedEnum> list = new ArrayList<>(out.values());
        list.sort(Comparator.comparing(SharedEnum::name));
        return Collections.unmodifiableList(list);
    }

    /** The shared enums metaobjects MATERIALIZES (non-{@code @provided}, consumed). */
    public static List<SharedEnum> materializedSharedEnums(MetaDataLoader loader) {
        List<SharedEnum> out = new ArrayList<>();
        for (SharedEnum e : collectSharedEnums(loader)) if (!e.provided()) out.add(e);
        return out;
    }

    /**
     * The Java type reference a consuming DTO component emits for a shared/provided enum:
     * <ul>
     *   <li>materialized → a bare {@code E} when {@code owner} shares the enum's package, else the
     *       fully-qualified {@code <pkg>.E} (the materialized standalone type).</li>
     *   <li>{@code @provided} → {@code <ns>.E}, where {@code ns} resolves from the package map (keyed
     *       by the enum's declaring metadata package) then the single fallback. A missing config is a
     *       codegen-time {@link GeneratorException} naming the enum + its package (ADR-0026 / ADR-0001).</li>
     * </ul>
     */
    public static String typeReference(SharedEnum shared, MetaObject owner, ProvidedEnumConfig cfg) {
        if (!shared.provided()) {
            String ownerJavaPkg = SpringNaming.splitFqn(owner.getName())[0];
            if (shared.javaPackage().isEmpty() || shared.javaPackage().equals(ownerJavaPkg)) {
                return shared.name();
            }
            return shared.javaPackage() + "." + shared.name();
        }
        String ns = cfg.packageNamespaces().get(shared.metaPackage());
        if (ns == null || ns.isBlank()) ns = cfg.fallbackNamespace();
        if (ns == null || ns.isBlank()) {
            throw new GeneratorException(
                "provided enum \"" + shared.name() + "\" (declared in package \"" + shared.metaPackage()
                + "\") is marked @provided but no Java namespace is configured to reference it from. "
                + "Map its package via the providedEnumPackages generator arg "
                + "(\"" + shared.metaPackage() + "=your.app.enums\") or set the single "
                + "providedEnumNamespace fallback, so the generated code can reference \""
                + shared.name() + "\".");
        }
        return ns + "." + shared.name();
    }
}
