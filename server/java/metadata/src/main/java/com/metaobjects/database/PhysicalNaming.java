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
    public static final PhysicalNaming DEFAULT = new PhysicalNaming(DEFAULT_COLUMNS, DEFAULT_TABLES);

    private final String columns;
    private final String tables;

    private PhysicalNaming(String columns, String tables) {
        this.columns = columns;
        this.tables = tables;
    }

    /**
     * Validates and builds a {@code PhysicalNaming}. Callers are config readers
     * ({@code NeutralConfig}, a conformance-corpus runner): an unknown value is refused
     * ({@code ERR_BAD_ATTR_VALUE}), never silently defaulted — a typo would otherwise bind a
     * whole schema to the wrong names and report success.
     *
     * @throws MetaDataException on a {@code columns} value outside
     *     {@link ColumnNaming#SNAKE_CASE}/{@link ColumnNaming#LITERAL}/{@link ColumnNaming#KEBAB_CASE},
     *     or a {@code tables} value outside {@link #TABLE_SNAKE_CASE}/{@link #TABLE_LITERAL}
     *     (kebab-case is a column rule only — not a table rule).
     */
    public static PhysicalNaming of(String columns, String tables) {
        if (!ColumnNaming.SNAKE_CASE.equals(columns) && !ColumnNaming.LITERAL.equals(columns)
                && !ColumnNaming.KEBAB_CASE.equals(columns)) {
            throw new MetaDataException(
                "unknown \"naming.columns\" rule \"" + columns + "\" in .metaobjects/config.json; "
                    + "expected one of: " + ColumnNaming.SNAKE_CASE + ", " + ColumnNaming.LITERAL
                    + ", " + ColumnNaming.KEBAB_CASE,
                ErrorCode.ERR_BAD_ATTR_VALUE);
        }
        if (!TABLE_SNAKE_CASE.equals(tables) && !TABLE_LITERAL.equals(tables)) {
            throw new MetaDataException(
                "unknown \"naming.tables\" rule \"" + tables + "\" in .metaobjects/config.json; "
                    + "expected one of: " + TABLE_SNAKE_CASE + ", " + TABLE_LITERAL,
                ErrorCode.ERR_BAD_ATTR_VALUE);
        }
        return new PhysicalNaming(columns, tables);
    }

    /** The {@code naming.columns} rule — snake_case / literal / kebab-case. */
    public String columns() {
        return columns;
    }

    /** The {@code naming.tables} rule — snake_case / literal. */
    public String tables() {
        return tables;
    }

    /** {@code name} cased by a table rule (never pluralized — that is a separate, frozen step). */
    public static String applyTableRule(String name, String rule) {
        if (TABLE_LITERAL.equals(rule)) return name;
        if (TABLE_SNAKE_CASE.equals(rule)) return ColumnNaming.toSnakeCase(name);
        throw new IllegalArgumentException(
            "unknown table-naming rule '" + rule + "'; expected one of: "
                + TABLE_SNAKE_CASE + ", " + TABLE_LITERAL);
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
