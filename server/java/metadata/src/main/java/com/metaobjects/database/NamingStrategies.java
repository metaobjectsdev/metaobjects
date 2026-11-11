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

    static {
        COLUMNS.put(ColumnNaming.SNAKE_CASE, ColumnNaming::toSnakeCase);
        COLUMNS.put(ColumnNaming.LITERAL, n -> n);
        COLUMNS.put(ColumnNaming.KEBAB_CASE, n -> ColumnNaming.toSnakeCase(n).replace('_', '-'));
        COLUMNS.put(ColumnNaming.PASCAL, ColumnNaming::toPascalColumn);
        TABLES.put(ColumnNaming.SNAKE_CASE, ColumnNaming::toSnakeCase);
        TABLES.put(ColumnNaming.LITERAL, n -> n);
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
        List<String> builtIns = columns ? BUILT_IN_COLUMNS : BUILT_IN_TABLES;
        List<String> registered = new ArrayList<>();
        for (String n : (columns ? COLUMNS : TABLES).keySet()) {
            if (!builtIns.contains(n)) registered.add(n);
        }
        return "\"naming." + key + "\" names \"" + name + "\", which no " + (columns ? "column" : "table")
            + "-naming strategy registered in the " + PORT + " port answers (built in: "
            + String.join(", ", builtIns) + "; registered by the application: "
            + (registered.isEmpty() ? "none" : String.join(", ", registered)) + "). Register it before "
            + ".metaobjects/config.json is read, or correct the name.";
    }
}
