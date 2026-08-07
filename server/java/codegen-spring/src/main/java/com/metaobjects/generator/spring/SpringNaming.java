package com.metaobjects.generator.spring;

import com.metaobjects.MetaData;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
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

    /** First {@link RdbSource} child of {@code entity}, or {@code null} when absent. */
    public static RdbSource firstRdbSource(MetaObject entity) {
        for (MetaData child : entity.getChildren()) {
            if (child instanceof RdbSource) return (RdbSource) child;
        }
        return null;
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
     * Naive pluralisation: lowercase + "s". Matches the cross-port reference
     * (TS / C# / Kotlin all use the same trivial rule for the default route
     * segment). Consumers needing irregular plurals (e.g. {@code Person} →
     * {@code people}) can override the generated {@code @RequestMapping} value
     * by hand-editing the file — the {@code GENERATED} banner is advisory,
     * not a hard merge gate, since regeneration overwrites.
     */
    public static String pluralLowercase(String shortName) {
        return shortName.toLowerCase() + "s";
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
     * ({@code SpringRenderHelperGenerator}, {@code SpringPayloadGenerator},
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

    /** {@code ExtractorCodeGenerator}: {@code className + "Extractor"} (entity class name). */
    public static String extractorName(String className) {
        return className + "Extractor";
    }

    /** {@code SpringControllerGenerator}: route base {@code "/api/" + pluralLowercase(shortName)}. */
    public static String controllerPath(String shortName) {
        return "/api/" + pluralLowercase(shortName);
    }

    /**
     * Output package for template-helper artifacts:
     * {@code pkg.isEmpty() ? "prompts" : pkg + ".prompts"}. Shared verbatim by
     * the render-helper / payload / output-prompt / output-parser generators.
     */
    public static String promptsPackage(String pkg) {
        return pkg.isEmpty() ? "prompts" : pkg + ".prompts";
    }

    /** {@code SpringRenderHelperGenerator}: {@code capitalize(templateShort) + "RenderHelper"}. */
    public static String renderHelperName(String templateShort) {
        return capitalize(templateShort) + "RenderHelper";
    }

    /** {@code SpringPayloadGenerator}: {@code capitalize(templateShort) + "Payload"}. */
    public static String payloadName(String templateShort) {
        return capitalize(templateShort) + "Payload";
    }

    /** {@code SpringOutputPromptGenerator}: {@code capitalize(templateShort) + "Prompt"}. */
    public static String promptName(String templateShort) {
        return capitalize(templateShort) + "Prompt";
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
}
