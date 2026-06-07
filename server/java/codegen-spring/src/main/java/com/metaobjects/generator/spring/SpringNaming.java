package com.metaobjects.generator.spring;

import com.metaobjects.MetaData;
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
final class SpringNaming {

    private SpringNaming() { /* no instances */ }

    /** First {@link RdbSource} child of {@code entity}, or {@code null} when absent. */
    static RdbSource firstRdbSource(MetaObject entity) {
        for (MetaData child : entity.getChildren()) {
            if (child instanceof RdbSource) return (RdbSource) child;
        }
        return null;
    }

    /** Convert metadata package separator {@code ::} to Java {@code .}. */
    static String toJavaPackage(String metadataPackage) {
        return metadataPackage.replace("::", ".");
    }

    /** Split a fully-qualified metadata name into its Java {@code (packageName, shortName)}. */
    static String[] splitFqn(String fqn) {
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
     * Naive pluralisation: lowercase + "s". Matches the cross-port reference
     * (TS / C# / Kotlin all use the same trivial rule for the default route
     * segment). Consumers needing irregular plurals (e.g. {@code Person} →
     * {@code people}) can override the generated {@code @RequestMapping} value
     * by hand-editing the file — the {@code GENERATED} banner is advisory,
     * not a hard merge gate, since regeneration overwrites.
     */
    static String pluralLowercase(String shortName) {
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
    static String capitalize(String s) {
        if (s == null || s.isEmpty()) return s;
        char c0 = s.charAt(0);
        if (Character.isUpperCase(c0)) return s;
        return Character.toUpperCase(c0) + s.substring(1);
    }

    /** {@code SpringDtoGenerator}: {@code shortName + "Dto"}. */
    static String dtoName(String shortName) {
        return shortName + "Dto";
    }

    /** {@code SpringRepositoryGenerator}: {@code shortName + "Repository"}. */
    static String repositoryName(String shortName) {
        return shortName + "Repository";
    }

    /** {@code SpringControllerGenerator}: {@code shortName + "Controller"}. */
    static String controllerName(String shortName) {
        return shortName + "Controller";
    }

    /** {@code SpringFilterAllowlistGenerator}: {@code shortName + "FilterAllowlist"}. */
    static String filterAllowlistName(String shortName) {
        return shortName + "FilterAllowlist";
    }

    /** {@code ExtractorCodeGenerator}: {@code className + "Extractor"} (entity class name). */
    static String extractorName(String className) {
        return className + "Extractor";
    }

    /** {@code SpringControllerGenerator}: route base {@code "/api/" + pluralLowercase(shortName)}. */
    static String controllerPath(String shortName) {
        return "/api/" + pluralLowercase(shortName);
    }

    /**
     * Output package for template-helper artifacts:
     * {@code pkg.isEmpty() ? "prompts" : pkg + ".prompts"}. Shared verbatim by
     * the render-helper / payload / output-prompt / output-parser generators.
     */
    static String promptsPackage(String pkg) {
        return pkg.isEmpty() ? "prompts" : pkg + ".prompts";
    }

    /** {@code SpringRenderHelperGenerator}: {@code capitalize(templateShort) + "RenderHelper"}. */
    static String renderHelperName(String templateShort) {
        return capitalize(templateShort) + "RenderHelper";
    }

    /** {@code SpringPayloadGenerator}: {@code capitalize(templateShort) + "Payload"}. */
    static String payloadName(String templateShort) {
        return capitalize(templateShort) + "Payload";
    }

    /** {@code SpringOutputPromptGenerator}: {@code capitalize(templateShort) + "Prompt"}. */
    static String promptName(String templateShort) {
        return capitalize(templateShort) + "Prompt";
    }

    /** {@code SpringOutputParserGenerator}: {@code capitalize(templateShort) + "Parser"}. */
    static String parserName(String templateShort) {
        return capitalize(templateShort) + "Parser";
    }

    /** {@code LlmTraceHelperGenerator}: {@code shortName + "TraceHelper"}. */
    static String traceHelperName(String shortName) {
        return shortName + "TraceHelper";
    }
}
