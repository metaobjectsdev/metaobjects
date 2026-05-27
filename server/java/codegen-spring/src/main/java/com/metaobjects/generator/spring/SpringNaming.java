package com.metaobjects.generator.spring;

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
}
