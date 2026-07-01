package com.metaobjects.source;

import com.metaobjects.MetaData;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.registry.MetaDataRegistry;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Abstract base source metadata — describes where an object's data lives.
 *
 * <p>Concrete subtypes:</p>
 * <ul>
 *   <li>{@link RdbSource} ({@code source.rdb}) — relational database table/view/stored proc.</li>
 * </ul>
 *
 * <p>Read-only-ness is derived from {@code @kind}: view / materializedView / storedProc /
 * tableFunction are read-only; table (the default) is writable.</p>
 */
public abstract class MetaSource extends MetaData {

    // === TYPE AND SUBTYPE CONSTANTS ===

    /** Source type constant — MetaSource owns this concept. */
    public static final String TYPE_SOURCE = "source";

    /** Abstract base source subtype — never instantiate directly. */
    public static final String SUBTYPE_BASE = "base";

    // === ATTRIBUTE NAME CONSTANTS ===
    //
    // Per-kind physical-name aliases (FR-016 / ADR-0018) — one canonical attr
    // key per rdb @kind. The single internal physical-name "slot" on a source
    // is filled by whichever alias matches @kind; the canonical serializer
    // emits the kind-matching alias regardless of which spelling was on input.

    /** Physical SQL table name. Canonical attr for {@code @kind: "table"} (default). */
    public static final String ATTR_TABLE = "table";

    /** Physical SQL view name. Canonical attr for {@code @kind: "view"}. */
    public static final String ATTR_VIEW = "view";

    /** Physical SQL materialized-view name. Canonical attr for {@code @kind: "materializedView"}. */
    public static final String ATTR_MATERIALIZED_VIEW = "materializedView";

    /** Physical SQL stored-procedure name. Canonical attr for {@code @kind: "storedProc"}. */
    public static final String ATTR_PROC = "proc";

    /** Physical SQL table-function name. Canonical attr for {@code @kind: "tableFunction"}. */
    public static final String ATTR_FUNCTION = "function";

    /** Object kind: table / view / materializedView / storedProc / tableFunction. */
    public static final String ATTR_KIND = "kind";

    /** Multi-source role: primary / replica / index / cache / publish / mirror. */
    public static final String ATTR_ROLE = "role";

    /** DB schema / namespace (Postgres default "public"; SQLite rejects non-default values). */
    public static final String ATTR_SCHEMA = "schema";

    // === KIND VALUE CONSTANTS ===

    public static final String KIND_TABLE             = "table";
    public static final String KIND_VIEW              = "view";
    public static final String KIND_MATERIALIZED_VIEW = "materializedView";
    public static final String KIND_STORED_PROC       = "storedProc";
    public static final String KIND_TABLE_FUNCTION    = "tableFunction";

    /** Default kind when {@code @kind} is absent. */
    public static final String DEFAULT_KIND = KIND_TABLE;

    /**
     * The set of {@code @kind} values that make a source read-only.
     * Derived: {@code isReadOnly() = READ_ONLY_KINDS.contains(getEffectiveKind())}.
     */
    public static final Set<String> READ_ONLY_KINDS = Set.of(
        KIND_VIEW,
        KIND_MATERIALIZED_VIEW,
        KIND_STORED_PROC,
        KIND_TABLE_FUNCTION
    );

    /** All valid {@code @kind} values. Used by {@code ValidationPhase} for enum-membership checks. */
    public static final Set<String> VALID_KINDS = Set.of(
        KIND_TABLE,
        KIND_VIEW,
        KIND_MATERIALIZED_VIEW,
        KIND_STORED_PROC,
        KIND_TABLE_FUNCTION
    );

    /**
     * FR-016 / ADR-0018: map of {@code @kind} → canonical kind-aware physical-name
     * attr key. Drives the four-step physical-name resolution rule and the
     * canonical-serializer per-kind rewrite. The single internal physical-name
     * "slot" on a source is the value of whichever alias matches the source's
     * {@code @kind}.
     *
     * <p>{@link LinkedHashMap} so iteration order matches {@link #VALID_KINDS}.</p>
     */
    public static final Map<String, String> PHYSICAL_NAME_ATTR_BY_KIND;
    static {
        Map<String, String> m = new LinkedHashMap<>();
        m.put(KIND_TABLE,             ATTR_TABLE);
        m.put(KIND_VIEW,              ATTR_VIEW);
        m.put(KIND_MATERIALIZED_VIEW, ATTR_MATERIALIZED_VIEW);
        m.put(KIND_STORED_PROC,       ATTR_PROC);
        m.put(KIND_TABLE_FUNCTION,    ATTR_FUNCTION);
        PHYSICAL_NAME_ATTR_BY_KIND = java.util.Collections.unmodifiableMap(m);
    }

    /**
     * FR-016 / ADR-0018: every kind-aware physical-name alias key, ordered for
     * deterministic iteration (matches the {@link #PHYSICAL_NAME_ATTR_BY_KIND}
     * insertion order).
     */
    public static final List<String> ALL_PHYSICAL_NAME_ALIASES = List.of(
        ATTR_TABLE,
        ATTR_VIEW,
        ATTR_MATERIALIZED_VIEW,
        ATTR_PROC,
        ATTR_FUNCTION
    );

    // === ROLE VALUE CONSTANTS ===

    public static final String ROLE_PRIMARY = "primary";
    public static final String ROLE_REPLICA = "replica";
    public static final String ROLE_INDEX   = "index";
    public static final String ROLE_CACHE   = "cache";
    public static final String ROLE_PUBLISH = "publish";
    public static final String ROLE_MIRROR  = "mirror";

    /** Default role when {@code @role} is absent. */
    public static final String DEFAULT_ROLE = ROLE_PRIMARY;

    /** All valid {@code @role} values. Used by {@code ValidationPhase} for enum-membership checks. */
    public static final Set<String> VALID_ROLES = Set.of(
        ROLE_PRIMARY, ROLE_REPLICA, ROLE_INDEX, ROLE_CACHE, ROLE_PUBLISH, ROLE_MIRROR
    );

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    protected MetaSource(String subType, String name) {
        super(TYPE_SOURCE, subType, name);
    }

    // -----------------------------------------------------------------------
    // Type registration
    // -----------------------------------------------------------------------

    /**
     * Register the abstract {@code source.base} type with all four attrs declared.
     * Called by {@link SourceTypesMetaDataProvider}.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(MetaSource.class, def -> {
            def.type(TYPE_SOURCE).subType(SUBTYPE_BASE)
               .description("Abstract base source metadata — describes where an object's data lives")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE)
               // Accept any attr child (for extensibility)
               .optionalChild(MetaAttribute.TYPE_ATTR, "*", "*");

            // SP-G Unit 6a: the physical / structural source attrs (@table, @view,
            // @materializedView, @proc, @function, @kind, @role, @schema) are declared
            // on the CONCRETE source.rdb subtype (RdbSource), not the abstract base —
            // matching the cross-port canonical (source.base is attr-free).
        });
    }

    // -----------------------------------------------------------------------
    // Accessors
    // -----------------------------------------------------------------------

    /**
     * Returns the value of {@code @table}, or {@code null} if absent.
     * Callers should fall back to the entity's logical name via the naming strategy.
     */
    public String getTableName() {
        return hasMetaAttr(ATTR_TABLE)
            ? getMetaAttr(ATTR_TABLE).getValueAsString()
            : null;
    }

    /**
     * Returns the {@code @kind} value, defaulting to {@link #DEFAULT_KIND} ("table")
     * when the attribute is absent.
     */
    public String getEffectiveKind() {
        return hasMetaAttr(ATTR_KIND)
            ? getMetaAttr(ATTR_KIND).getValueAsString()
            : DEFAULT_KIND;
    }

    /**
     * Returns the {@code @role} value, defaulting to {@link #DEFAULT_ROLE} ("primary")
     * when the attribute is absent.
     */
    public String getRole() {
        return hasMetaAttr(ATTR_ROLE)
            ? getMetaAttr(ATTR_ROLE).getValueAsString()
            : DEFAULT_ROLE;
    }

    /**
     * Returns {@code true} when {@code @kind} names a read-only construct
     * (view, materializedView, storedProc, tableFunction).
     */
    public boolean isReadOnly() {
        return READ_ONLY_KINDS.contains(getEffectiveKind());
    }

    /**
     * Returns {@code true} when this source is writable (i.e. not read-only).
     */
    public boolean isWritable() {
        return !isReadOnly();
    }

    /**
     * Returns the value of {@code @schema}, or {@code null} if absent.
     */
    public String getSchema() {
        return hasMetaAttr(ATTR_SCHEMA)
            ? getMetaAttr(ATTR_SCHEMA).getValueAsString()
            : null;
    }

    /**
     * FR-016 / ADR-0018: resolved physical SQL name for this source, following
     * the four-step rule:
     * <ol>
     *   <li>Kind-matching alias (e.g. {@code @proc} when {@code @kind: "storedProc"}).</li>
     *   <li>Legacy {@code @table} for non-table kind (pre-1.0 fallback).</li>
     *   <li>Source's bare structural {@code name} via snake_case (skipped when
     *       the name was auto-generated by the parser, e.g. {@code rdb1}).</li>
     *   <li>Owning entity's name via {@code pluralize(snake_case(...))}.</li>
     * </ol>
     *
     * <p>Callers needing the legacy raw {@code @table} slot only should use
     * {@link #getTableName()}; codegen / migrate / runtime should use
     * {@code getPhysicalName()}.</p>
     */
    public String getPhysicalName() {
        String kind = getEffectiveKind();

        // Step 1: kind-matching alias.
        // ADR-0039: source physical-name attrs are inheritable effective source
        // properties — RESOLVE (default includeParentData=true), matching getTableName()/
        // getEffectiveKind()/getRole() above and the C# port's resolving PhysicalName.
        String canonicalAttr = PHYSICAL_NAME_ATTR_BY_KIND.get(kind);
        if (canonicalAttr != null && hasMetaAttr(canonicalAttr)) {
            String v = getMetaAttr(canonicalAttr).getValueAsString();
            if (v != null && !v.isEmpty()) return v;
        }

        // Step 2: legacy @table for non-table kind.
        if (canonicalAttr != null && !ATTR_TABLE.equals(canonicalAttr)
                && hasMetaAttr(ATTR_TABLE)) {
            String legacy = getMetaAttr(ATTR_TABLE).getValueAsString();
            if (legacy != null && !legacy.isEmpty()) return legacy;
        }

        // Step 3: source's structural `name` via snake_case (no pluralization —
        // the source's name IS the logical name). Skip the parser's
        // auto-generated <subType>N names so a nameless authored source falls
        // through to Step 4 (matches TS, where unnamed sources have name === "").
        String shortName = getShortName();
        if (shortName != null && !shortName.isEmpty() && !isAutoGeneratedSourceName(shortName)) {
            return toSnakeCaseInternal(shortName);
        }

        // Step 4: owning entity's name via pluralize(snake_case). The MetaData
        // parent of a source is always the entity that declared it.
        MetaData owner = getParent();
        if (owner != null) {
            String ownerName = owner.getShortName();
            if (ownerName != null && !ownerName.isEmpty()) {
                return pluralizeInternal(toSnakeCaseInternal(ownerName));
            }
        }

        return "";
    }

    /**
     * Returns {@code true} when the given short name matches the parser's
     * auto-naming pattern for source nodes ({@code <subType>N} — e.g. {@code rdb1}).
     * Mirrors {@link com.metaobjects.io.json.CanonicalJsonSerializer}'s
     * suppression of auto-names on emit so the FR-016 four-step rule treats
     * authored vs auto-generated source names consistently across ports.
     */
    private boolean isAutoGeneratedSourceName(String shortName) {
        String subType = getSubType();
        String expectedPrefix = (subType != null && !subType.isEmpty())
            ? subType.toLowerCase()
            : TYPE_SOURCE.toLowerCase();
        // Auto-generated name matches EXACTLY <expectedPrefix><digits>.
        if (!shortName.startsWith(expectedPrefix)) return false;
        String tail = shortName.substring(expectedPrefix.length());
        if (tail.isEmpty()) return false;
        for (int i = 0; i < tail.length(); i++) {
            if (!Character.isDigit(tail.charAt(i))) return false;
        }
        return true;
    }

    /**
     * Snake-case conversion mirroring the TS reference {@code toSnakeCase}:
     * {@code XMLHttpRequest} → {@code xml_http_request},
     * {@code OrderItem} → {@code order_item}.
     */
    private static String toSnakeCaseInternal(String s) {
        if (s == null || s.isEmpty()) return s;
        // Step 1: ACRONYM + CapitalizedWord boundary (e.g. XMLHttp → XML_Http).
        String p1 = s.replaceAll("([A-Z]+)([A-Z][a-z])", "$1_$2");
        // Step 2: lowercase/digit + Capitalized boundary (e.g. orderItem → order_Item).
        String p2 = p1.replaceAll("([a-z0-9])([A-Z])", "$1_$2");
        return p2.toLowerCase();
    }

    /**
     * Tiny inflector mirroring the TS reference {@code pluralize}: handles the
     * (s|x|z|ch|sh) → +es and consonant-y → +ies cases; otherwise +s.
     */
    private static String pluralizeInternal(String s) {
        if (s == null || s.isEmpty()) return s;
        String lower = s.toLowerCase();
        if (lower.endsWith("s") || lower.endsWith("x") || lower.endsWith("z")
                || lower.endsWith("ch") || lower.endsWith("sh")) {
            return s + "es";
        }
        if (lower.endsWith("y") && lower.length() >= 2) {
            char before = lower.charAt(lower.length() - 2);
            if ("aeiou".indexOf(before) < 0) {
                return s.substring(0, s.length() - 1) + "ies";
            }
        }
        return s + "s";
    }

    @Override
    public String toString() {
        return String.format("%s[%s:%s]{table=%s, kind=%s, role=%s}",
            getClass().getSimpleName(),
            getType(),
            getSubType(),
            getTableName(),
            getEffectiveKind(),
            getRole());
    }
}
