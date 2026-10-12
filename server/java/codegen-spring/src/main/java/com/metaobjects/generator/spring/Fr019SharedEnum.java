package com.metaobjects.generator.spring;

// Eject note (ADR-0034 Amendment 8): `mvn metaobjects:eject` copies this file with the generators
// that call it. The naming and type-mapping siblings stay in com.metaobjects.generator.spring, so
// they are imported by name — a bare same-package reference would not resolve from the copy.
import com.metaobjects.field.EnumField;
import com.metaobjects.field.MetaField;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.generator.util.GeneratorUtil;
import com.metaobjects.generator.spring.SpringNaming;
import com.metaobjects.generator.spring.SpringTypeMapper;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;

import java.io.IOException;
import java.nio.file.Path;
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
 * {@code object.entity}) that a concrete field anywhere — on an {@code object.entity},
 * {@code object.projection}, or {@code object.value} — reaches via (possibly multi-hop)
 * {@code extends}, resolved by the single cross-generator authority
 * {@link EnumField#resolveSharedEnumDeclaration}. Per ADR-0026 such a declaration is
 * materialized ONCE per port as a standalone Java {@code enum} (one file, {@code Priority.java})
 * and referenced, instead of being redeclared inline (a nested {@code public enum E}) in every
 * consuming record.</p>
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
                             String metaPackage, String javaPackage,
                             Map<String, Integer> intValueMap) { }

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
     * The shared-enum declaration {@code field} resolves to via {@code extends}, or {@code null}
     * when the field is an inline enum. Delegates entirely to the single cross-generator
     * authority, {@link EnumField#resolveSharedEnumDeclaration} (metadata module) — the SAME
     * function the Kotlin port and the #246 loader validator call, so the two JVM generators and
     * the loader can never disagree about what "shared" means. See that method's Javadoc for the
     * full rule (nearest-declaration-wins, an own-{@code @values}/{@code @intValueMap} node stops
     * the walk, no hop limit, no hosting-object-subtype condition).
     */
    public static MetaField<?> resolveSharedEnumDecl(MetaField<?> field) {
        return EnumField.resolveSharedEnumDeclaration(field);
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
        return new SharedEnum(name, values, isProvided((EnumField) decl), metaPackage, javaPackage,
            SpringTypeMapper.intValueMap((EnumField) decl));
    }

    /** The declaration's metadata package in {@code ::} form, stripped of the trailing {@code ::Name}
     * (empty when the declaration carries no package). */
    private static String metaPackageOf(String fqn) {
        int idx = fqn.lastIndexOf("::");
        return idx < 0 ? "" : fqn.substring(0, idx);
    }

    /**
     * Read {@code @provided} on an enum declaration. ADR-0039: {@code @provided} is a
     * declaration-layer marker (like {@code @isAbstract}) — it describes THIS
     * declaration's provided-ness, never inherited through extends. KEPT own-only.
     */
    private static boolean isProvided(EnumField decl) {
        if (!decl.hasMetaAttr(EnumField.ATTR_PROVIDED, false)) return false;
        Object raw = decl.getMetaAttr(EnumField.ATTR_PROVIDED, false).getValue();
        if (raw instanceof Boolean b) return b;
        return Boolean.parseBoolean(String.valueOf(raw));
    }

    /**
     * All shared (root-level abstract) enum declarations in the loaded model that are actually
     * CONSUMED by at least one concrete object field — keyed by materialized type name, sorted by
     * name (deterministic). A declaration nobody extends is not materialized (no dangling type).
     * Scans every concrete {@code object.entity}, {@code object.projection} AND
     * {@code object.value} (there is no condition on the hosting object's SUBTYPE — a projection
     * or value-object field reaching a shared declaration must-generate it too); abstract objects
     * are skipped (nothing is generated for them directly — a concrete subtype's resolving
     * {@link MetaObject#getMetaFields()} already sees their inherited fields). Scans the WHOLE
     * loader regardless of which objects a particular generator invocation is narrowed to, so a
     * run filtered down to a single consuming object still materializes the type it reaches.
     */
    public static List<SharedEnum> collectSharedEnums(MetaDataLoader loader) {
        Map<String, SharedEnum> out = new LinkedHashMap<>();
        for (MetaObject owner : loader.getMetaObjects()) {
            if (GeneratorUtil.isAbstract(owner)) continue;
            String subType = owner.getSubType();
            if (!MetaObject.SUBTYPE_ENTITY.equals(subType)
                && !MetaObject.SUBTYPE_PROJECTION.equals(subType)
                && !MetaObject.SUBTYPE_VALUE.equals(subType)) continue;
            for (MetaField<?> field : owner.getMetaFields()) {
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
     * The opt-in generator arg ({@code emitSharedEnums=true}) with which the value-object and
     * output-parser generators write the materialized shared enums into their own
     * {@code outputDir}. {@link SpringDtoGenerator} owns those files and always writes them, so
     * the arg is for a run that includes one of the other two WITHOUT the DTO generator. Leaving
     * it off elsewhere is what keeps one {@code <Name>.java} per shared enum when the generators
     * write to separate output directories.
     */
    public static final String ARG_EMIT_SHARED_ENUMS = "emitSharedEnums";

    /**
     * Write each materialized shared enum as a standalone top-level Java {@code enum} in its
     * declaring package — {@code <pkg>/<Name>.java} containing {@code public enum <Name> { A, B, C }}
     * — for EVERY shared enum the model consumes, whichever object reaches it. Provided enums
     * emit nothing (referenced externally). Called by {@link SpringDtoGenerator} on every run and
     * by the value-object and output-parser generators only under {@link #ARG_EMIT_SHARED_ENUMS}.
     */
    public static void emitMaterialized(MetaDataLoader loader, Path outRoot) {
        for (SharedEnum shared : materializedSharedEnums(loader)) {
            StringBuilder src = new StringBuilder();
            if (!shared.javaPackage().isEmpty()) {
                src.append("package ").append(shared.javaPackage()).append(";\n\n");
            }
            src.append("/** GENERATED — shared enum ").append(shared.name())
               .append(". Do not hand-edit; regenerated from metadata. */\n");
            src.append(SpringTypeMapper.enumDeclaration(shared.name(), shared.values(), shared.intValueMap()))
               .append("\n");
            try {
                Path outFile = outRoot.resolve(shared.javaPackage().replace('.', '/'))
                                      .resolve(shared.name() + ".java");
                GeneratedFileWriter.write(outFile, src.toString());
            } catch (IOException e) {
                throw new GeneratorException(
                    "failed writing shared enum " + shared.name() + ".java: " + e, e);
            }
        }
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
        }
        return qualifiedTypeReference(shared, cfg);
    }

    /**
     * The always-qualified reference ({@code <pkg>.E} / {@code <ns>.E}) for generated code that
     * lives in a package of its own — the output parser sits in {@code <pkg>.prompts}, never in
     * the enum's package, so it cannot use the bare same-package form.
     */
    public static String qualifiedTypeReference(SharedEnum shared, ProvidedEnumConfig cfg) {
        if (!shared.provided()) {
            return shared.javaPackage().isEmpty() ? shared.name() : shared.javaPackage() + "." + shared.name();
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
