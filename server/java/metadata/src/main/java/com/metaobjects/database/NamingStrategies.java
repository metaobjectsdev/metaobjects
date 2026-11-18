package com.metaobjects.database;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * ADR-0058 Amendment 1 — the physical-naming strategies, by name: the built-ins, and the ones
 * an application registers. {@code .metaobjects/config.json} selects one by name
 * ({@code "naming": { "columns": "<name>" }}), and {@link PhysicalNaming#of(String, String)} —
 * which every config reader calls — refuses a name nothing here answers when the file is read.
 * So an application registers BEFORE the project-aware load: in its startup, a Spring
 * {@code @Configuration}'s static initializer, or a Maven codegen extension on the plugin's
 * classpath. Process-wide, like the type registry an application extends. Wrapping a built-in
 * is one line:
 *
 * <pre>{@code
 * NamingStrategies.registerColumns("pascal-acronyms",
 *     n -> n.equals("npi") ? "NPI" : NamingStrategies.column(ColumnNaming.PASCAL).apply(n));
 * }</pre>
 *
 * <p>Shared by both JVM ports: the Kotlin generators resolve through {@link ColumnNaming}, which
 * resolves through here.</p>
 */
public final class NamingStrategies {

    private NamingStrategies() {}

    /** A naming strategy: a bare metadata name in, a physical name out. */
    @FunctionalInterface
    public interface NamingFunction {
        String apply(String name);
    }

    /** The port this registry belongs to, as every port's unknown-strategy message names it. */
    private static final String PORT = "Java";

    /** The column rules every port builds in, in the order the conformance corpus lists them. */
    public static final List<String> BUILT_IN_COLUMNS =
        List.of(ColumnNaming.SNAKE_CASE, ColumnNaming.LITERAL, ColumnNaming.KEBAB_CASE, ColumnNaming.PASCAL);

    /** The table rules every port builds in. */
    public static final List<String> BUILT_IN_TABLES = List.of(ColumnNaming.SNAKE_CASE, ColumnNaming.LITERAL);

    private static final Map<String, NamingFunction> COLUMNS = new LinkedHashMap<>();
    private static final Map<String, NamingFunction> TABLES = new LinkedHashMap<>();

    /** The cross-port pluralizer (already-plural detection, then the suffix rule). */
    public static final String PLURALIZER_STANDARD = "standard";
    /** The name as it is. */
    public static final String PLURALIZER_NONE = "none";
    /** The pluralizers every port builds in. */
    public static final List<String> BUILT_IN_PLURALIZERS = List.of(PLURALIZER_STANDARD, PLURALIZER_NONE);
    /** The pluralizer an object without {@code @collectionName} gets when {@code naming.collections} is absent. */
    public static final String DEFAULT_PLURALIZER = PLURALIZER_STANDARD;

    private static final Map<String, NamingFunction> PLURALIZERS = new LinkedHashMap<>();

    static {
        COLUMNS.put(ColumnNaming.SNAKE_CASE, ColumnNaming::toSnakeCase);
        COLUMNS.put(ColumnNaming.LITERAL, n -> n);
        COLUMNS.put(ColumnNaming.KEBAB_CASE, n -> ColumnNaming.toSnakeCase(n).replace('_', '-'));
        COLUMNS.put(ColumnNaming.PASCAL, ColumnNaming::toPascalColumn);
        TABLES.put(ColumnNaming.SNAKE_CASE, ColumnNaming::toSnakeCase);
        TABLES.put(ColumnNaming.LITERAL, n -> n);
        PLURALIZERS.put(PLURALIZER_STANDARD, NamingStrategies::standardPluralize);
        PLURALIZERS.put(PLURALIZER_NONE, n -> n);
    }

    /**
     * Registers a pluralizer under {@code name}: an object name in, its collection name out.
     * {@code "naming": { "collections": "<name>" }} then selects it; an object's own
     * {@code @collectionName} always wins over it. A built-in cannot be replaced.
     */
    public static void registerPluralizer(String name, NamingFunction apply) {
        register(PLURALIZERS, BUILT_IN_PLURALIZERS, name, apply, "collection-naming (pluralizer)");
    }

    public static synchronized boolean isPluralizer(String name) {
        return PLURALIZERS.containsKey(name);
    }

    /** Every registered pluralizer's name: the built-ins, then the application's. */
    public static synchronized List<String> registeredPluralizers() {
        return new ArrayList<>(PLURALIZERS.keySet());
    }

    /** The pluralizer registered as {@code name}. Throws, naming it, when nothing answers it. */
    public static synchronized NamingFunction pluralizer(String name) {
        NamingFunction fn = PLURALIZERS.get(name);
        if (fn == null) throw new MetaDataException(unknownMessage("collections", name), ErrorCode.ERR_BAD_ATTR_VALUE);
        return fn;
    }

    /**
     * The {@code standard} pluralizer, the rule every port shares
     * ({@code fixtures/naming-conformance/already-plural-pluralize.json}): a name ending in
     * {@code s} not preceded by s/u/i/a is already plural and stays; else the suffix rule.
     * Case-insensitive, and the name keeps its own casing.
     */
    public static String standardPluralize(String s) {
        if (s == null || s.isEmpty()) return s;
        String lower = s.toLowerCase(java.util.Locale.ROOT);
        if (lower.length() >= 2 && lower.endsWith("s") && "suia".indexOf(lower.charAt(lower.length() - 2)) < 0) {
            return s;
        }
        if (lower.endsWith("s") || lower.endsWith("x") || lower.endsWith("z")
                || lower.endsWith("ch") || lower.endsWith("sh")) {
            return s + "es";
        }
        if (lower.length() > 1 && lower.endsWith("y") && "aeiou".indexOf(lower.charAt(lower.length() - 2)) < 0) {
            return s.substring(0, s.length() - 1) + "ies";
        }
        return s + "s";
    }

    /**
     * Registers a column strategy under {@code name}. A built-in name cannot be replaced
     * ({@link IllegalArgumentException}); registering a name of your own again replaces it.
     */
    public static void registerColumns(String name, NamingFunction apply) {
        register(COLUMNS, BUILT_IN_COLUMNS, name, apply, "column-naming");
    }

    /** Registers a table rule under {@code name}; see {@link #registerColumns}. */
    public static void registerTables(String name, NamingFunction apply) {
        register(TABLES, BUILT_IN_TABLES, name, apply, "table-naming");
    }

    private static void register(Map<String, NamingFunction> into, List<String> builtIns, String name,
                                 NamingFunction apply, String kind) {
        if (name == null || name.isEmpty()) {
            throw new IllegalArgumentException("a " + kind + " strategy needs a non-empty name");
        }
        Objects.requireNonNull(apply, "apply");
        if (builtIns.contains(name)) {
            throw new IllegalArgumentException("\"" + name + "\" is a built in " + kind
                + " strategy and cannot be replaced; register yours under another name");
        }
        synchronized (NamingStrategies.class) {
            into.put(name, apply);
        }
    }

    /**
     * TEST-ONLY: forget every strategy the application registered, leaving the built-ins. The
     * registry is process-wide, so a test that registers one resets it when it is done rather than
     * leaving it for the next test to find. Not for production code.
     */
    public static synchronized void resetForTesting() {
        COLUMNS.keySet().retainAll(BUILT_IN_COLUMNS);
        TABLES.keySet().retainAll(BUILT_IN_TABLES);
        PLURALIZERS.keySet().retainAll(BUILT_IN_PLURALIZERS);
    }

    /** True when {@code name} is a registered column strategy, built in or the application's. */
    public static synchronized boolean isColumn(String name) {
        return COLUMNS.containsKey(name);
    }

    /** True when {@code name} is a registered table rule, built in or the application's. */
    public static synchronized boolean isTable(String name) {
        return TABLES.containsKey(name);
    }

    /** Every registered column strategy: the built-ins in corpus order, then the application's. */
    public static synchronized List<String> registeredColumns() {
        return new ArrayList<>(COLUMNS.keySet());
    }

    /** Every registered table rule: the built-ins, then the application's. */
    public static synchronized List<String> registeredTables() {
        return new ArrayList<>(TABLES.keySet());
    }

    /**
     * The column strategy registered as {@code name}.
     *
     * @throws MetaDataException ({@code ERR_BAD_ATTR_VALUE}) naming it, when nothing answers it —
     *     never a silent fallback, which would bind a whole schema to the wrong columns
     */
    public static synchronized NamingFunction column(String name) {
        NamingFunction fn = COLUMNS.get(name);
        if (fn == null) throw new MetaDataException(unknownMessage("columns", name), ErrorCode.ERR_BAD_ATTR_VALUE);
        return fn;
    }

    /** The table rule registered as {@code name}; throws like {@link #column}. */
    public static synchronized NamingFunction table(String name) {
        NamingFunction fn = TABLES.get(name);
        if (fn == null) throw new MetaDataException(unknownMessage("tables", name), ErrorCode.ERR_BAD_ATTR_VALUE);
        return fn;
    }

    /**
     * What every port says when a config names a strategy no registered strategy answers: the
     * same words in every port, with that port's name. {@code key} is {@code columns} or
     * {@code tables}.
     */
    public static synchronized String unknownMessage(String key, String name) {
        boolean columns = "columns".equals(key);
        boolean collections = "collections".equals(key);
        List<String> builtIns = columns ? BUILT_IN_COLUMNS : collections ? BUILT_IN_PLURALIZERS : BUILT_IN_TABLES;
        List<String> registered = new ArrayList<>();
        for (String n : (columns ? COLUMNS : collections ? PLURALIZERS : TABLES).keySet()) {
            if (!builtIns.contains(n)) registered.add(n);
        }
        String kind = columns ? "column-naming" : collections ? "collection-naming (pluralizer)" : "table-naming";
        return "\"naming." + key + "\" names \"" + name + "\", which no " + kind
            + " strategy registered in the " + PORT + " port answers (built in: "
            + String.join(", ", builtIns) + "; registered by the application: "
            + (registered.isEmpty() ? "none" : String.join(", ", registered)) + "). Register it before "
            + ".metaobjects/config.json is read, or correct the name.";
    }
}
