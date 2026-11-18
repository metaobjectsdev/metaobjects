package com.metaobjects.database;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;

/**
 * ADR-0058 — the project's physical-naming rules: the {@code naming} block of
 * {@code .metaobjects/config.json}, carried by the loaded {@link MetaRoot} and read by
 * every resolver through {@link #of(MetaData)} — codegen (including the names generators),
 * {@code meta migrate}, the runtime, and {@code verify}. Codegen and the runtime cannot
 * disagree, because neither configures its own rule any more; see
 * {@link ColumnNaming#removedConfigurationMessage(String, String)} for the refusal every
 * former configuration source now gives.
 *
 * <p>Cross-port sibling: TypeScript's {@code PhysicalNaming} / {@code physicalNamingOf}
 * ({@code metadata/src/naming.ts}).</p>
 */
public final class PhysicalNaming {

    /** Table-naming rule: the entity (or source) name cased by this, never pluralized itself —
     *  pluralization is the separate, frozen legacy step applied only on the entity-name
     *  fallback (step 4 of {@code MetaSource#getPhysicalName()}). */
    public static final String TABLE_LITERAL = ColumnNaming.LITERAL;
    public static final String TABLE_SNAKE_CASE = ColumnNaming.SNAKE_CASE;

    /** The project default for each rule — what {@code meta migrate} has always created. */
    public static final String DEFAULT_COLUMNS = ColumnNaming.SNAKE_CASE;
    public static final String DEFAULT_TABLES = TABLE_SNAKE_CASE;

    /** Both rules at their default. */
    public static final PhysicalNaming DEFAULT = new PhysicalNaming(DEFAULT_COLUMNS, DEFAULT_TABLES, null);

    private final String columns;
    private final String tables;
    private final String collections;

    private PhysicalNaming(String columns, String tables, String collections) {
        this.columns = columns;
        this.tables = tables;
        this.collections = collections;
    }

    /**
     * Validates and builds a {@code PhysicalNaming}. Callers are config readers
     * ({@code NeutralConfig}, a conformance-corpus runner): each value is the NAME of a strategy
     * registered in {@link NamingStrategies} — a built-in, or one the application registered
     * before the read (ADR-0058 Amendment 1). A name nothing answers is refused
     * ({@code ERR_BAD_ATTR_VALUE}), naming it, never silently defaulted — a typo would otherwise
     * bind a whole schema to the wrong names and report success.
     *
     * @throws MetaDataException on a {@code columns} name no column strategy answers, or a
     *     {@code tables} name no table rule answers ({@code kebab-case} and {@code pascal} are
     *     column rules only)
     */
    public static PhysicalNaming of(String columns, String tables) {
        if (!NamingStrategies.isColumn(columns)) {
            throw new MetaDataException(NamingStrategies.unknownMessage("columns", columns), ErrorCode.ERR_BAD_ATTR_VALUE);
        }
        if (!NamingStrategies.isTable(tables)) {
            throw new MetaDataException(NamingStrategies.unknownMessage("tables", tables), ErrorCode.ERR_BAD_ATTR_VALUE);
        }
        return new PhysicalNaming(columns, tables, null);
    }

    /**
     * As {@link #of(String, String)}, with the pluralizer an object without
     * {@code @collectionName} takes its collection name from ({@code naming.collections});
     * {@code null} means {@link NamingStrategies#DEFAULT_PLURALIZER}.
     */
    public static PhysicalNaming of(String columns, String tables, String collections) {
        PhysicalNaming base = of(columns, tables);
        if (collections != null && !NamingStrategies.isPluralizer(collections)) {
            throw new MetaDataException(NamingStrategies.unknownMessage("collections", collections), ErrorCode.ERR_BAD_ATTR_VALUE);
        }
        return new PhysicalNaming(base.columns, base.tables, collections);
    }

    /** The {@code naming.columns} strategy's name — a built-in or an application-registered one. */
    public String columns() {
        return columns;
    }

    /** The {@code naming.tables} rule's name — a built-in or an application-registered one. */
    public String tables() {
        return tables;
    }

    /** The configured pluralizer ({@code naming.collections}), or {@code null} when none is named. */
    public String collections() {
        return collections;
    }

    /** {@code name} cased by the table rule registered as {@code rule} (never pluralized — that
     *  is a separate, frozen step). Throws on a name nothing registered. */
    public static String applyTableRule(String name, String rule) {
        return NamingStrategies.table(rule).apply(name);
    }

    /**
     * The physical-naming rules for the tree {@code node} belongs to: what the nearest
     * ancestor carrying them exposes (set by the project-aware load from
     * {@code .metaobjects/config.json}), else {@link #DEFAULT} — a tree loaded with no
     * project, or a node reaching no carrier at all.
     *
     * <p>Walks to {@link com.metaobjects.MetaRoot} for an attached node, same as always.
     * A node detached from the loaded tree — {@code ReportReadModel}'s read model is the
     * one case in this codebase, built fresh off its report and never attached as a child
     * of any root (see its class doc) — carries its OWN copy, captured from the report's
     * root at build time, so resolving a derived field's column still sees the project's
     * rule rather than silently falling back to {@link #DEFAULT} the moment the model
     * detaches it from the tree.</p>
     */
    public static PhysicalNaming of(MetaData node) {
        MetaData d = node;
        while (d != null) {
            if (d instanceof PhysicalNamingHolder) {
                PhysicalNaming naming = ((PhysicalNamingHolder) d).getPhysicalNaming();
                return naming != null ? naming : DEFAULT;
            }
            d = d.getParent();
        }
        return DEFAULT;
    }
}
