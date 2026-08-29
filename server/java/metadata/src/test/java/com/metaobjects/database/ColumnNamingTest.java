package com.metaobjects.database;

import com.metaobjects.field.MetaField;
import com.metaobjects.field.StringField;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

/**
 * The column-naming strategy shared by both JVM ports.
 *
 * <p>It exists because the two disagreed: {@code ObjectManagerDB}'s
 * {@code getColumnRef} resolved {@code literal} while the Kotlin Exposed generator
 * hardcoded {@code camelToSnake} and ignored {@code @column} outright — so one metadata
 * model produced two different column names on one JVM, and neither could be
 * configured. Both now delegate here, and the algorithm matches the TypeScript,
 * C# and Python siblings so a polyglot project sees one rule.</p>
 *
 * <p>The JVM default is {@code literal}, which is what {@code ObjectManagerDB} has
 * always resolved; the Kotlin generator keeps {@code snake_case} as ITS default, since
 * that is what it always emitted. A default that moved would silently re-point live
 * queries at columns that do not exist.</p>
 */
public class ColumnNamingTest extends SharedRegistryTestBase {

    private static MetaField<?> field(String name, String column) {
        StringField f = StringField.create(name, null);
        if (column != null) f.addMetaAttr(com.metaobjects.attr.StringAttribute.create(
                CoreDBMetaDataProvider.COLUMN, column));
        return f;
    }

    @Test
    public void defaultIsLiteral() {
        assertEquals(ColumnNaming.LITERAL, ColumnNaming.DEFAULT);
        assertEquals("createdAt", ColumnNaming.resolve(field("createdAt", null)));
    }

    @Test
    public void strategyAppliesToAFieldWithNoColumnAttr() {
        assertEquals("createdAt", ColumnNaming.resolve(field("createdAt", null), ColumnNaming.LITERAL));
        assertEquals("created_at", ColumnNaming.resolve(field("createdAt", null), ColumnNaming.SNAKE_CASE));
        assertEquals("created-at", ColumnNaming.resolve(field("createdAt", null), ColumnNaming.KEBAB_CASE));
    }

    @Test
    public void anExplicitColumnAttrWinsOverEveryStrategy() {
        // Deliberately NOT the snake_case of the field name, so "the strategy ran" and
        // "@column won" stay distinguishable.
        MetaField<?> f = field("callPurpose", "purpose_code");
        for (String s : new String[]{ColumnNaming.LITERAL, ColumnNaming.SNAKE_CASE, ColumnNaming.KEBAB_CASE}) {
            assertEquals("purpose_code", ColumnNaming.resolve(f, s));
        }
    }

    @Test
    public void snakeCaseMatchesTheCrossPortAlgorithm() {
        assertEquals("display_name", ColumnNaming.apply("displayName", ColumnNaming.SNAKE_CASE));
        assertEquals("id", ColumnNaming.apply("id", ColumnNaming.SNAKE_CASE));
        assertEquals("user_id", ColumnNaming.apply("userId", ColumnNaming.SNAKE_CASE));
        // Acronym boundary: one split, not one per letter.
        assertEquals("url_path", ColumnNaming.apply("URLPath", ColumnNaming.SNAKE_CASE));
    }

    @Test
    public void anUnknownStrategyIsRefusedNotSilentlyDefaulted() {
        // A typo would otherwise bind a whole schema to the wrong columns and succeed.
        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                () -> ColumnNaming.apply("createdAt", "PascalCase"));
        org.junit.Assert.assertTrue(ex.getMessage(), ex.getMessage().contains("snake_case"));
    }
}
