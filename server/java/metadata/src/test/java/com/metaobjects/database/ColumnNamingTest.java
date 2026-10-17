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
 * <p>ADR-0058 flipped the JVM default from {@code literal} to {@code snake_case} — what
 * {@code meta migrate} has always created, and what every other port now defaults to. An
 * adopter whose live database really has literal columns declares
 * {@code "naming": { "columns": "literal" }} in {@code .metaobjects/config.json}.</p>
 */
public class ColumnNamingTest extends SharedRegistryTestBase {

    private static MetaField<?> field(String name, String column) {
        StringField f = StringField.create(name, null);
        if (column != null) f.addMetaAttr(com.metaobjects.attr.StringAttribute.create(
                CoreDBMetaDataProvider.COLUMN, column));
        return f;
    }

    @Test
    public void defaultIsSnakeCase() {
        assertEquals(ColumnNaming.SNAKE_CASE, ColumnNaming.DEFAULT);
        assertEquals("created_at", ColumnNaming.resolve(field("createdAt", null)));
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
