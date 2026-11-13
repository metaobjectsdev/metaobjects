package com.metaobjects.generator.util;

import com.metaobjects.database.ColumnNaming;
import com.metaobjects.database.NamingStrategies;
import com.metaobjects.database.PhysicalNaming;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.object.CollectionNames;
import com.metaobjects.object.MetaObject;
import com.metaobjects.source.RdbSource;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

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
     * The REST collection segment {@code obj} is served under, the cross-port rule shared with
     * TypeScript and C# ({@code fixtures/naming-conformance/collection-segments.json}): its own
     * {@code @collectionName} wins, snake_cased by {@link #snakeCollectionName}; else the
     * pluralizer the project configures ({@code naming.collections}) over its name, snake_cased the
     * same way; else the rule every port has always served ({@link #collectionSegment(String)}).
     * A pluralizer is applied only when the project configures one, so an unconfigured project's
     * segments never move. Every JVM generator that emits a REST path reads this.
     */
    public static String collectionSegment(MetaObject obj) {
        String declared = CollectionNames.declared(obj);
        if (declared != null) return snakeCollectionName(declared);
        String configured = PhysicalNaming.of(obj).collections();
        if (configured != null) {
            return snakeCollectionName(NamingStrategies.pluralizer(configured).apply(obj.getShortName()));
        }
        return collectionSegment(obj.getShortName());
    }

    private static final Pattern ACRONYM_PLURAL = Pattern.compile("^(.*[A-Z])(e?s)$");

    /**
     * snake_case a collection name with an acronym-aware split: a trailing plural {@code s} /
     * {@code es} after a capital is a suffix of the acronym, not a word of its own
     * ({@code FAQs} -&gt; {@code faqs}, {@code TaxIDs} -&gt; {@code tax_ids}, {@code PDFBoxes} -&gt;
     * {@code pdf_boxes}). Any other name is {@link ColumnNaming#toSnakeCase}.
     */
    public static String snakeCollectionName(String s) {
        Matcher m = ACRONYM_PLURAL.matcher(s);
        return m.matches() ? ColumnNaming.toSnakeCase(m.group(1)) + m.group(2) : ColumnNaming.toSnakeCase(s);
    }

    /**
     * The four letters that precede a genuinely SINGULAR "...s" ending in the common
     * patterns this codebase's entity names hit — status, address, bonus, alias, gas,
     * analysis. Anything else before a final "s" reads as already-plural.
     */
    private static final String ALREADY_PLURAL_EXCLUDED_PRECEDING_CHARS = "suia";

    /**
     * True when {@code word} already reads as a plural noun, so running it through the
     * ordinary suffix rule would double it — the real defect this exists to fix:
     * {@code program_purchase_stats} -&gt; {@code program_purchase_statses} shipped as a
     * REST collection path in an adopter's app.
     *
     * <p>Heuristic, not a dictionary: a word ending in {@code s} is already-plural
     * UNLESS the character immediately before that final {@code s} is one of
     * s/u/i/a (case-insensitive). Covers stats, settings, details, news, analytics,
     * series, photos; leaves status, address, bonus, alias, gas, analysis on the
     * ordinary suffix path (unchanged).</p>
     *
     * <p>Known miss, deliberately not fixed here: a genuinely singular word ending in
     * "...s" with none of those four letters before it reads as already-plural too —
     * {@code lens} -&gt; {@code lens} (correct plural {@code lenses}). Fixing that needs
     * a real dictionary, which this is not; the heuristic optimizes for the shape the
     * doubling defect actually hits (entity names that are already a plural
     * concept).</p>
     */
    private static boolean isAlreadyPlural(String word) {
        if (word.length() < 2) return false;
        char last = Character.toLowerCase(word.charAt(word.length() - 1));
        if (last != 's') return false;
        char before = Character.toLowerCase(word.charAt(word.length() - 2));
        return ALREADY_PLURAL_EXCLUDED_PRECEDING_CHARS.indexOf(before) < 0;
    }

    /**
     * FROZEN — byte-for-byte the pre-fix suffix-only pluralization rule, with no
     * already-plural detection. This is exposed only so {@link #pluralize} can fall
     * back to it; every OTHER call site in this class / port goes through
     * {@link #pluralize}. The DEFAULT PHYSICAL name fallback lives in a completely
     * separate, independently-frozen implementation
     * ({@code MetaSource#pluralizeInternal} in {@code metadata}) — this method is
     * NOT that one, and the two must never be merged into a single call site.
     */
    private static String pluralizeLegacySuffixOnly(String word) {
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

    /**
     * The cross-port pluralization contract, byte-identical in every port: a word ending
     * {@code s}/{@code x}/{@code z}/{@code ch}/{@code sh} takes {@code es}; a consonant
     * followed by {@code y} becomes {@code ies}; anything else takes {@code s}. Adds
     * already-plural detection ({@link #isAlreadyPlural}) on top of that historical
     * suffix rule ({@link #pluralizeLegacySuffixOnly}) — API/code-surface pluralization
     * only; the DEFAULT PHYSICAL table name fallback is frozen separately
     * ({@code MetaSource#pluralizeInternal}), so an existing adopter database never sees
     * a proposed rename.
     *
     * <p>Expects an already-lowercased word (what {@code toSnakeCase} returns), which is
     * why the suffix tests are case-sensitive.</p>
     */
    public static String pluralize(String word) {
        if (word == null || word.isEmpty()) return word;
        if (isAlreadyPlural(word)) return word;
        return pluralizeLegacySuffixOnly(word);
    }

    /** The shared-ledger code for two objects that take one collection name (fixtures/conformance/ERROR-CODES.json). */
    public static final String ERR_COLLECTION_NAME_COLLISION = "ERR_COLLECTION_NAME_COLLISION";

    /**
     * Refuse a generation run in which two DISTINCT entities/projections resolve to the
     * same REST collection segment ({@link #collectionSegment}) — e.g. {@code Address}
     * and {@code Addresses} both landing on {@code /addresses}. Reachable from stock
     * metadata now that {@link #pluralize} no longer doubles an already-plural word:
     * before that fix {@code Addresses} legacy-pluralized to {@code addresseses}, so the
     * pair never collided.
     *
     * <p>Called ONCE, over the full entity set, before any generator runs
     * ({@code MetaDataGeneratorMojo#executeGenerators}) — the single choke point shared
     * by every JVM generator (Java's {@code codegen-spring} AND Kotlin's
     * {@code codegen-kotlin}, both invoked through the same {@code metaobjects:generate}
     * Maven goal). The scope is the whole run because the name it compares is a served path:
     * one Spring app mounts every generated controller under the same prefix, so two objects
     * whose segments match serve one route whatever their packages (their classes and
     * repositories are in their own Java packages and never collide). Counted over the objects
     * that emit a collection ({@link #emitsCollection}):
     * a value object, an abstract object and one with no {@code source.rdb} never get a
     * controller, repository or route, so they cannot collide on one — a layered model's
     * abstract {@code enterprise::Payer} beside a concrete {@code core::Payer} is not a
     * collision.</p>
     *
     * <p>A PURE function of the entity set, never of traversal order: the reported pair
     * is deterministic (first-seen-by-input-order "owner" of a collection segment;
     * thrown as soon as a second, different entity claims the same one). The message leads
     * with the shared-ledger code {@value #ERR_COLLECTION_NAME_COLLISION}, the code every
     * port raises for this refusal; it is a codegen-time error, so it is a plain
     * {@link GeneratorException} rather than a loader {@code ErrorCode} constant.</p>
     */
    public static void assertNoCollectionNameCollisions(List<MetaObject> entities) {
        Map<String, MetaObject> ownerOfSegment = new HashMap<>();
        for (MetaObject obj : entities) {
            if (!emitsCollection(obj)) continue;
            String segment = collectionSegment(obj);
            MetaObject existing = ownerOfSegment.get(segment);
            if (existing != null) {
                if (existing != obj) {
                    throw new GeneratorException(
                        ERR_COLLECTION_NAME_COLLISION + ": \"" + existing.getName() + "\" and \"" + obj.getName()
                        + "\" both resolve to the REST collection segment \"" + segment + "\" — set @collectionName "
                        + "on one, or rename it, so the segments differ. Default PHYSICAL table names are unaffected "
                        + "by this rule and are not involved in the collision.");
                }
            } else {
                ownerOfSegment.put(segment, obj);
            }
        }
    }

    /**
     * Whether {@code obj} gets a collection (a controller, repository, route): not a value
     * object, not abstract, and backed by a {@code source.rdb}. The TypeScript, C# and Python
     * ports count the same objects.
     */
    static boolean emitsCollection(MetaObject obj) {
        if (MetaObject.SUBTYPE_VALUE.equals(obj.getSubType())) return false;
        if (GeneratorUtil.isAbstract(obj)) return false;
        // ADR-0039: RESOLVING — a source inherited through extends backs the object too.
        return obj.getSources(true).stream().anyMatch(s -> s instanceof RdbSource);
    }
}
