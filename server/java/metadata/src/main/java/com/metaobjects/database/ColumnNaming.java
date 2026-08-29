package com.metaobjects.database;

import com.metaobjects.field.MetaField;

/**
 * Physical column naming: how a metadata field becomes a database column name.
 *
 * <p>The strategy is CONFIG, not metadata (ADR-0023 does not apply). The same model has
 * to be able to drive a snake_case Postgres schema and a literal-column one — which is
 * exactly why it lives beside the persistence layer rather than in the metadata, and why
 * the byte-gated registry prose for {@code @column} describes the default as coming
 * <em>"via columnNamingStrategy"</em>.</p>
 *
 * <p>Cross-port siblings sharing this vocabulary and this algorithm:</p>
 * <ul>
 *   <li>TypeScript — {@code metadata/src/naming.ts} ({@code applyColumnNamingStrategy})</li>
 *   <li>C# — {@code MetaObjects.Codegen.ColumnNamingStrategy}</li>
 *   <li>Python — {@code metaobjects.naming}</li>
 * </ul>
 *
 * <p><b>Why this class exists.</b> The two JVM ports disagreed. {@code ObjectManagerDB}'s
 * {@code getColumnRef} resolved {@code @column} or the field name verbatim
 * ({@link #LITERAL}); the Kotlin Exposed generator hardcoded a camel-to-snake conversion
 * and ignored {@code @column} altogether. So one metadata model produced two different
 * column names on one JVM, and neither was configurable. Both now delegate here.</p>
 *
 * <p><b>Defaults do not move.</b> {@link #DEFAULT} is {@link #LITERAL} — what
 * {@code ObjectManagerDB} has always resolved — while the Kotlin generator keeps
 * {@code snake_case} as its own default, since that is what it always emitted. A default
 * that moved would silently re-point live queries at columns that do not exist.</p>
 */
public final class ColumnNaming {

    private ColumnNaming() {}

    /** The field name verbatim. */
    public static final String LITERAL = "literal";
    /** camelCase / PascalCase to snake_case (the Postgres convention). */
    public static final String SNAKE_CASE = "snake_case";
    /** camelCase / PascalCase to kebab-case. */
    public static final String KEBAB_CASE = "kebab-case";

    /** The JVM runtime default. See the class javadoc on why it is not snake_case. */
    public static final String DEFAULT = LITERAL;

    /**
     * Apply a strategy to a bare name.
     *
     * @throws IllegalArgumentException on an unknown strategy — never a silent fallback
     *     to the default, because a typo would otherwise bind a whole schema to the
     *     wrong columns and report success.
     */
    public static String apply(String name, String strategy) {
        if (LITERAL.equals(strategy)) return name;
        if (SNAKE_CASE.equals(strategy)) return toSnakeCase(name);
        if (KEBAB_CASE.equals(strategy)) return toSnakeCase(name).replace('_', '-');
        throw new IllegalArgumentException(
                "unknown column-naming strategy '" + strategy + "'; expected one of: "
                        + LITERAL + ", " + SNAKE_CASE + ", " + KEBAB_CASE);
    }

    /** THE physical column name for a field, under the {@link #DEFAULT} strategy. */
    public static String resolve(MetaField<?> field) {
        return resolve(field, DEFAULT);
    }

    /**
     * THE physical column name for a field: its explicit {@code @column} when present,
     * else {@code field.getName()} through the project's strategy.
     *
     * <p>ADR-0039: the attribute is read RESOLVING — {@code @column} may be inherited
     * through {@code extends}.</p>
     */
    public static String resolve(MetaField<?> field, String strategy) {
        if (field == null) return "";
        String explicit = null;
        if (field.hasMetaAttr(CoreDBMetaDataProvider.COLUMN, true)) {
            try {
                explicit = field.getMetaAttr(CoreDBMetaDataProvider.COLUMN, true).getValueAsString();
            } catch (RuntimeException ignored) {
                // A malformed attr falls through to the strategy rather than failing the
                // whole query/generation — the loader is the gate on attribute validity.
            }
        }
        if (explicit != null && !explicit.isEmpty()) return explicit;
        return apply(field.getName(), strategy);
    }

    /**
     * {@code displayName} to {@code display_name}, {@code URLPath} to {@code url_path}.
     *
     * <p>Byte-for-byte the algorithm the other ports use: insert {@code _} before an
     * uppercase letter preceded by a lowercase letter or digit, OR before an uppercase
     * letter that both follows another uppercase and precedes a lowercase — so an
     * acronym splits once ({@code URLPath} to {@code url_path}, never
     * {@code u_r_l_path}). A port-local approximation would put the two halves of one
     * schema out of step.</p>
     */
    public static String toSnakeCase(String name) {
        if (name == null || name.isEmpty()) return name;
        StringBuilder sb = new StringBuilder(name.length() + 4);
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (i > 0 && Character.isUpperCase(c)) {
                char prev = name.charAt(i - 1);
                Character next = (i + 1 < name.length()) ? name.charAt(i + 1) : null;
                if (Character.isLowerCase(prev) || Character.isDigit(prev)
                        || (Character.isUpperCase(prev) && next != null && Character.isLowerCase(next))) {
                    sb.append('_');
                }
            }
            sb.append(Character.toLowerCase(c));
        }
        return sb.toString();
    }
}
