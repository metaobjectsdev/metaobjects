package com.metaobjects.generator.spring;

import com.metaobjects.generator.util.RestSurfaceGate;
import com.metaobjects.generator.util.RouteNaming;
import com.metaobjects.MetaData;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.generator.spring.runtime.RecordComponentNames;
import com.metaobjects.source.RdbSource;

/**
 * Internal naming helpers for the Spring codegen package. Parallels the
 * {@code PackageMapping} object in {@code codegen-kotlin}; kept package-private
 * here because the rest of the module is the only caller.
 *
 * <p>Two responsibilities:</p>
 * <ul>
 *   <li>Translate metadata package syntax ({@code a::b::c}) to Java package
 *       syntax ({@code a.b.c}) and split an FQN into
 *       ({@code packageName}, {@code shortName}).</li>
 *   <li>Compute the route-segment pluralisation rule
 *       ({@code Author} → {@code authors}) used by both the
 *       {@code @RequestMapping} value on the generated controller and the
 *       cross-port URL grammar
 *       ({@code docs/features/api-contract.md}).</li>
 * </ul>
 */
public final class SpringNaming {

    private SpringNaming() { /* no instances */ }

    /**
     * First {@link RdbSource} child of {@code entity}, or {@code null} when absent.
     * Delegates to {@link RestSurfaceGate#firstRdbSource} — the emit gate reads the same
     * source and the two must not be able to disagree about which one is "first".
     */
    public static RdbSource firstRdbSource(MetaObject entity) {
        return RestSurfaceGate.firstRdbSource(entity);
    }

    /** Convert metadata package separator {@code ::} to Java {@code .}. */
    public static String toJavaPackage(String metadataPackage) {
        return metadataPackage.replace("::", ".");
    }

    /** Split a fully-qualified metadata name into its Java {@code (packageName, shortName)}. */
    public static String[] splitFqn(String fqn) {
        int lastSep = fqn.lastIndexOf("::");
        if (lastSep < 0) {
            return new String[] { "", fqn };
        }
        return new String[] {
            toJavaPackage(fqn.substring(0, lastSep)),
            fqn.substring(lastSep + 2)
        };
    }

    /**
     * ADR-0042 — resolve a metadata OBJECT reference (bare or FQN) to a {@link MetaObject}
     * under the package-local contract, or {@code null} when nothing matches:
     * <ul>
     *   <li><b>FQN</b> {@code ref} (contains {@code "::"}) → EXACT match on
     *       {@link MetaData#getName()}. No bare-tail fallback, so an FQN pointing at one
     *       package never binds a same-named object in another.</li>
     *   <li><b>bare</b> {@code ref} (no {@code "::"}) → the referrer's OWN package
     *       ({@code <referrerPkg>::<ref>}) first, else a root-level (unpackaged) object
     *       whose name IS {@code ref}. Package-local BEFORE root-level; no cross-package
     *       short-name scan, no bare-tail fallback.</li>
     * </ul>
     * Mirrors the loader's own {@code ValidationPhase#resolveRootObject} (the same contract
     * the TS/Python/C# ports' canonical resolvers implement), so a codegen-time
     * {@code @payloadRef}/{@code @responseRef} resolution agrees with the loader's own
     * validation of the same ref under a cross-package short-name collision.
     *
     * @param referrerPkg the effective package of the node carrying the ref ("" for root-level)
     */
    public static MetaObject resolveObjectRef(MetaDataLoader loader, String ref, String referrerPkg) {
        if (ref == null) return null;
        String pkg = referrerPkg == null ? "" : referrerPkg;
        if (ref.contains("::")) {
            for (MetaObject obj : loader.getMetaObjects()) {
                if (ref.equals(obj.getName())) return obj;
            }
            return null;
        }
        String localKey = pkg.isEmpty() ? ref : pkg + "::" + ref;
        MetaObject own = null;
        MetaObject rootLevel = null;
        for (MetaObject obj : loader.getMetaObjects()) {
            String key = obj.getName();
            if (key == null) continue;
            if (key.equals(localKey)) own = obj;
            if (key.equals(ref)) rootLevel = obj;
        }
        if (own != null) return own;
        return localKey.equals(ref) ? null : rootLevel;
    }

    /**
     * Resolve {@code ref} to its payload-shape target under the same ADR-0042
     * package-local contract as {@link #resolveObjectRef}. #210 — a template-level
     * payload target is an {@code object.value} OR a SOURCELESS
     * {@code object.projection} (rejects entities and sourced projections; the
     * loader enforces the same set). The shared home for every
     * {@code @payloadRef}/{@code @responseRef} resolution in this package — callers
     * derive {@code referrerPkg} via
     * {@code MetaDataUtil.findPackageForMetaData(referrerNode)} (walks parents, so it
     * works for both a root-level template and a nested {@code template.prompt}).
     */
    public static MetaObject resolveValueObjectRef(MetaDataLoader loader, String ref, String referrerPkg) {
        MetaObject obj = resolveObjectRef(loader, ref, referrerPkg);
        return (obj != null && isLegalPayloadTarget(obj)) ? obj : null;
    }

    /**
     * #210 — a template-level payload target ({@code @payloadRef} / {@code @responseRef})
     * is an {@code object.value} OR a SOURCELESS {@code object.projection}.
     * "Sourceless" is the #248 persistability contract: no declared/inherited
     * {@code source.*} child (a concrete projection cannot inherit one —
     * {@code ERR_PROJECTION_INHERITED_SOURCE}). Nested {@code field.object @objectRef}
     * targets stay value-only (the loader enforces both halves).
     */
    public static boolean isLegalPayloadTarget(MetaObject obj) {
        if (MetaObject.SUBTYPE_VALUE.equals(obj.getSubType())) return true;
        if (!MetaObject.SUBTYPE_PROJECTION.equals(obj.getSubType())) return false;
        // ADR-0039: resolving (includeParentData=true) — a source anywhere in the
        // extends chain binds the projection to a backing store, disqualifying it.
        return obj.getChildren(com.metaobjects.source.MetaSource.class, true).isEmpty();
    }

    /**
     * The REST collection segment: the ENTITY NAME {@code snake_case}d and then
     * pluralized ({@code Author} → {@code authors}, {@code PostCategory} →
     * {@code post_categories}). Delegates to {@link RouteNaming}, which Kotlin's
     * generator shares, so the JVM ports cannot drift from each other.
     *
     * <p>It was {@code shortName.toLowerCase() + "s"}, and the javadoc here claimed
     * that matched TS / C# / Kotlin. Only Kotlin matched: TS snake_cases then
     * pluralizes irregularly and C# pluralized irregularly then lowercased, so one
     * URL had four spellings and {@code PostCategory} was served at
     * {@code /postcategorys}. The old note also told consumers to hand-edit the
     * generated {@code @RequestMapping} — which does not survive here, because
     * regeneration overwrites on the JVM rather than three-way merging.</p>
     */
    public static String collectionSegment(String shortName) {
        return RouteNaming.collectionSegment(shortName);
    }

    // ---------------------------------------------------------------------
    // Generated-name seam.
    //
    // Each method below returns EXACTLY the string the corresponding generator
    // concatenates inline today (verbatim, behavior-preserving). Generators are
    // routed through these methods in a follow-up task so the api-docs IR shares
    // one source of truth for emitted type names. Do not change a literal here
    // without changing the generator and re-verifying byte output.
    // ---------------------------------------------------------------------

    /**
     * Capitalize the first character. Mirrors the {@code capitalizeFirst}
     * helper duplicated across the template-helper generators
     * ({@code SpringRenderHelperGenerator},
     * {@code SpringOutputPromptGenerator}, {@code SpringOutputParserGenerator},
     * {@code LlmTraceHelperGenerator}).
     */
    public static String capitalize(String s) {
        if (s == null || s.isEmpty()) return s;
        char c0 = s.charAt(0);
        if (Character.isUpperCase(c0)) return s;
        return Character.toUpperCase(c0) + s.substring(1);
    }

    /** {@code SpringDtoGenerator}: {@code shortName + "Dto"}. */
    public static String dtoName(String shortName) {
        return shortName + "Dto";
    }

    /** {@code SpringRepositoryGenerator}: {@code shortName + "Repository"}. */
    public static String repositoryName(String shortName) {
        return shortName + "Repository";
    }

    /** {@code SpringDtoGenerator} (FR-035): {@code shortName + "Patch"} — the presence-tracked patch shape. */
    public static String patchName(String shortName) {
        return shortName + "Patch";
    }

    /** {@code SpringControllerGenerator}: {@code shortName + "Controller"}. */
    public static String controllerName(String shortName) {
        return shortName + "Controller";
    }

    /** {@code SpringFilterAllowlistGenerator}: {@code shortName + "FilterAllowlist"}. */
    public static String filterAllowlistName(String shortName) {
        return shortName + "FilterAllowlist";
    }

    /**
     * {@code SpringNamesGenerator}: {@code shortName + "Names"} — the per-object
     * physical database name constants class (spec A1/A2/A6).
     */
    public static String namesName(String shortName) {
        return shortName + "Names";
    }

    /** {@code ExtractorCodeGenerator}: {@code className + "Extractor"} (entity class name). */
    public static String extractorName(String className) {
        return className + "Extractor";
    }

    /** {@code SpringControllerGenerator}: route base {@code "/api/" + collectionSegment(shortName)}. */
    public static String controllerPath(String shortName) {
        return "/api/" + collectionSegment(shortName);
    }

    /**
     * Output package for TEMPLATE-keyed artifacts: {@code pkg + ".prompts"}, or the root
     * package when the template has no package. Shared verbatim by the render-helper /
     * output-prompt / output-parser generators. A value object's own record never lands here
     * (ADR-0056): {@link SpringValueObjectGenerator} writes it into the value object's package.
     *
     * <p>A no-package template stays in the root package, rather than a bare {@code prompts}
     * package, because its artifacts reference the value object's record — and a no-package
     * value object lives in the root package, which Java cannot import from a named one.</p>
     */
    public static String promptsPackage(String pkg) {
        return pkg.isEmpty() ? "" : pkg + ".prompts";
    }

    /**
     * The fully-qualified reference to the record {@link SpringValueObjectGenerator} emits for
     * {@code vo} — what every template-tier generator names a payload or response by (ADR-0056).
     * Bare when {@code vo} has no package.
     */
    public static String valueObjectRef(MetaObject vo) {
        String[] split = splitFqn(vo.getName());
        return split[0].isEmpty() ? split[1] : split[0] + "." + split[1];
    }

    /**
     * Fail codegen when a file in {@code fromPkg} would have to name {@code vo}'s root-package
     * record: Java cannot import a class from the root package into a named one, so the emitted
     * file would not compile. {@code what} names the referring template, for the message.
     */
    public static void requireReferenceable(String fromPkg, MetaObject vo, String what) {
        if (fromPkg.isEmpty() || !splitFqn(vo.getName())[0].isEmpty()) return;
        throw new com.metaobjects.generator.GeneratorException(
            what + " references value object '" + vo.getName() + "', which has no package. Java "
                + "cannot reference a root-package class from the named package '" + fromPkg
                + "' — declare '" + vo.getName() + "' in a package");
    }

    /** {@code SpringRenderHelperGenerator}: {@code capitalize(templateShort) + "RenderHelper"}. */
    public static String renderHelperName(String templateShort) {
        return capitalize(templateShort) + "RenderHelper";
    }

    /**
     * {@code SpringOutputPromptGenerator}: {@code capitalize(templateShort) +
     * "ResponseFormat"} — the FR-010 fragment class that tells a model how to format its
     * reply.
     *
     * <p>ADR-0052 D4 renamed this from {@code <Short>Prompt}: the fragment is now
     * generated FROM a {@code template.prompt}, so the old suffix produced
     * {@code ClassifyPromptPrompt}. Mirrors C#'s
     * {@code CSharpNaming.ResponseFormatClassName}.
     */
    public static String responseFormatName(String templateShort) {
        return capitalize(templateShort) + "ResponseFormat";
    }

    /** {@code SpringOutputParserGenerator}: {@code capitalize(templateShort) + "Parser"}. */
    public static String parserName(String templateShort) {
        return capitalize(templateShort) + "Parser";
    }

    /** {@code LlmTraceHelperGenerator}: {@code shortName + "TraceHelper"}. */
    public static String traceHelperName(String shortName) {
        return shortName + "TraceHelper";
    }

    // ---------------------------------------------------------------------
    // ADR-0038 — reverse-relationship navigation via explicit FK finders.
    //
    // For each FK relationship (entity {@code E} references {@code T} via an
    // {@code identity.reference} FK field), {@code E}'s repository gains a finder
    // returning the {@code E} rows matching a given {@code T} id. Two variants:
    // a single-value finder and a batched (anti-N+1) {@code …In} finder.
    //
    // The CROSS-PORT INVARIANT is the FK-FIELD DERIVATION (not a verbatim
    // cross-port method name): the disambiguator segment is the FK field name,
    // PascalCased, with a single trailing {@code Id} dropped. Because FK field
    // names are unique within an entity, the segment — and so the finder — is
    // unique by construction. Three same-pair FKs (GameSession → Scene ×3) yield
    // three distinct finders ({@code findByCurrentScene} /
    // {@code findByLastOpeningNarrativeScene} / {@code findByTransitioningFromScene}),
    // never colliding. The repository method name is idiomatic Spring Data
    // ({@code findBy<FkField>} — the entity is implied by the repository), matching
    // the shape a JVM adopter hand-writes; the TS port spells it
    // {@code find<EPlural>By<FkField>} (the entity is NOT implied there).
    // ---------------------------------------------------------------------

    /**
     * The reverse-finder disambiguator segment derived from an FK field name:
     * PascalCase, dropping a single trailing {@code Id} (but never reducing a bare
     * {@code "id"}/{@code "Id"} to the empty string). E.g. {@code currentSceneId} →
     * {@code CurrentScene}; {@code playerId} → {@code Player}; {@code id} → {@code Id}.
     */
    public static String reverseFinderFkSegment(String fkFieldName) {
        String pascal = capitalize(fkFieldName);
        return pascal.length() > 2 && pascal.endsWith("Id")
            ? pascal.substring(0, pascal.length() - 2)
            : pascal;
    }

    /** {@code SpringRepositoryGenerator}: reverse single-value finder name {@code findBy<FkField>}. */
    public static String reverseFinderName(String fkFieldName) {
        return "findBy" + reverseFinderFkSegment(fkFieldName);
    }

    /** {@code SpringRepositoryGenerator}: reverse batched finder name {@code findBy<FkField>In}. */
    public static String reverseFinderInName(String fkFieldName) {
        return reverseFinderName(fkFieldName) + "In";
    }

    /**
     * Whether a record component named {@code fieldName} would fail to compile (JLS 8.10.3).
     *
     * <p>The set itself lives in {@link RecordComponentNames}, in the runtime package, because
     * the generated PATCH handler needs the same rule at RUN time to name a Bean Validation
     * property. One definition, so the two times cannot disagree.
     */
    public static boolean isIllegalRecordComponent(String fieldName) {
        return RecordComponentNames.isReserved(fieldName);
    }

    /**
     * The Java name a record component must use for a field called {@code fieldName}.
     *
     * <p>The WIRE name is unaffected: every caller pairs this with
     * {@link #jsonPropertyAnnotation(String)} so the field still serializes and deserializes
     * under its declared name.
     *
     * <p>Applies to every place the name becomes a Java METHOD, not only the component that
     * declares it — accessor CALL sites, a plain class's accessor, an interface's method, and
     * the property-name STRING handed to {@code Validator#validateValue}. Missing one of those
     * does not always break the build: a {@code String}-typed {@code toString()} on the
     * generated Patch compiles and silently overrides {@code Object.toString()}.
     */
    public static String recordComponentName(String fieldName) {
        return RecordComponentNames.escape(fieldName);
    }

    /**
     * {@code @JsonProperty("<fieldName>") } when the component had to be renamed, else empty.
     *
     * <p>Without it the escape would leak to the wire: Jackson names a record's JSON
     * property after the component, so an escaped {@code notify_} would serialize as
     * {@code notify_} and this port would disagree with the other four about the payload.
     */
    public static String jsonPropertyAnnotation(String fieldName) {
        return isIllegalRecordComponent(fieldName)
            ? "@com.fasterxml.jackson.annotation.JsonProperty(\"" + fieldName + "\")"
            : "";
    }
}
