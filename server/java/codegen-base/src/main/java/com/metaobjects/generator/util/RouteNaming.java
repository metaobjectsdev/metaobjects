package com.metaobjects.generator.util;

import com.metaobjects.database.ColumnNaming;

/**
 * THE REST collection-URL segment rule, shared by every JVM generator.
 *
 * <p>One rule in all five ports: the <b>entity name</b> {@code snake_case}d, then
 * pluralized. {@code Author} is served at {@code /authors}, {@code PostCategory} at
 * {@code /post_categories}. It is derived from the entity NAME and never from the
 * physical {@code @table}.</p>
 *
 * <p><b>Why this class exists.</b> Java's {@code SpringNaming} and Kotlin's
 * {@code KotlinNaming} each carried their own {@code pluralLowercase} — {@code
 * shortName.toLowerCase() + "s"} — and Kotlin's javadoc claimed it was "the same
 * trivial rule TS / C# / Java use". It was not: TS snake_cases and pluralizes
 * irregularly, C# pluralized irregularly then lowercased, and only Java matched
 * Kotlin. Four spellings of one URL, and {@code PostCategory} was served at
 * {@code /postcategorys}. Two hand-maintained copies of a rule with nothing tying
 * them together is what let the claim go stale, so the JVM ports now share ONE
 * implementation rather than two that agree by inspection.</p>
 *
 * <p>The gating scenario lives in {@code fixtures/api-contract-conformance/m2m/},
 * whose {@code PostCategory} is multi-word AND ends consonant+y, so it separates
 * every spelling the ports used to produce. The acronym case is pinned by unit
 * test in each port instead — no corpus entity carries one.</p>
 */
public final class RouteNaming {

    private RouteNaming() {
    }

    /**
     * The collection segment for an entity short name: {@code Author} → {@code authors},
     * {@code PostCategory} → {@code post_categories}, {@code HTTPServer} →
     * {@code http_servers}.
     *
     * <p>Reuses {@link ColumnNaming#toSnakeCase(String)} deliberately. That algorithm is
     * generic PascalCase→snake_case — it merely happens to live on the column-naming
     * class — and it is already byte-equivalent to the TS and C# ports' own. Copying it
     * here to avoid a cross-package call would recreate exactly the duplication this
     * class exists to remove.</p>
     */
    public static String collectionSegment(String shortName) {
        if (shortName == null || shortName.isEmpty()) return shortName;
        return pluralize(ColumnNaming.toSnakeCase(shortName));
    }

    /**
     * The cross-port pluralization contract, byte-identical in every port: a word ending
     * {@code s}/{@code x}/{@code z}/{@code ch}/{@code sh} takes {@code es}; a consonant
     * followed by {@code y} becomes {@code ies}; anything else takes {@code s}.
     *
     * <p>Expects an already-lowercased word (what {@code toSnakeCase} returns), which is
     * why the suffix tests are case-sensitive.</p>
     */
    public static String pluralize(String word) {
        if (word == null || word.isEmpty()) return word;
        if (word.endsWith("s") || word.endsWith("x") || word.endsWith("z")
                || word.endsWith("ch") || word.endsWith("sh")) {
            return word + "es";
        }
        if (word.length() > 1 && word.endsWith("y")
                && "aeiou".indexOf(word.charAt(word.length() - 2)) < 0) {
            return word.substring(0, word.length() - 1) + "ies";
        }
        return word + "s";
    }
}
