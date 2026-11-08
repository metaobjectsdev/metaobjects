package com.metaobjects.database;

import com.metaobjects.MetaDataException;
import com.metaobjects.config.NeutralConfig;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * ADR-0058 Amendment 1 — the naming strategies are a registry an application extends. The
 * built-ins are registered strategies by name; an application registers its own (which may
 * wrap a built-in in one line); {@code .metaobjects/config.json} selects either by name, and a
 * name nothing registers is refused when the config is read.
 */
public class NamingStrategiesTest {

    @Test
    public void everyBuiltInIsARegisteredStrategy() {
        assertEquals(List.of("snake_case", "literal", "kebab-case", "pascal"), NamingStrategies.BUILT_IN_COLUMNS);
        assertEquals(List.of("snake_case", "literal"), NamingStrategies.BUILT_IN_TABLES);
        assertEquals("RequestURL", ColumnNaming.apply("requestURL", ColumnNaming.PASCAL));
        assertEquals("Npi", ColumnNaming.toPascalColumn("npi"));
        assertEquals("request_url", NamingStrategies.column("snake_case").apply("requestURL"));
        assertEquals("OrderItem", NamingStrategies.table("literal").apply("OrderItem"));
    }

    @Test
    public void anApplicationStrategyWrapsABuiltIn() {
        NamingStrategies.registerColumns("java-test-acronyms",
            n -> n.equals("npi") ? "NPI" : NamingStrategies.column(ColumnNaming.PASCAL).apply(n));
        NamingStrategies.registerTables("java-test-prefixed",
            n -> "t_" + NamingStrategies.table(PhysicalNaming.TABLE_SNAKE_CASE).apply(n));

        assertEquals("NPI", ColumnNaming.apply("npi", "java-test-acronyms"));
        assertEquals("CreatedAt", ColumnNaming.apply("createdAt", "java-test-acronyms"));
        assertEquals("t_order_item", PhysicalNaming.applyTableRule("OrderItem", "java-test-prefixed"));
        assertTrue(NamingStrategies.registeredColumns().contains("java-test-acronyms"));
        assertFalse(NamingStrategies.registeredTables().contains("java-test-acronyms"));
    }

    @Test
    public void aBuiltInCannotBeReplaced() {
        assertThrows(IllegalArgumentException.class, () -> NamingStrategies.registerColumns("snake_case", n -> n));
        assertThrows(IllegalArgumentException.class, () -> NamingStrategies.registerTables("literal", n -> n));
    }

    @Test
    public void anUnknownNameFailsLoudNamingTheStrategyAndThePort() {
        MetaDataException ex = assertThrows(MetaDataException.class, () -> NamingStrategies.column("no-such-rule"));
        assertTrue(ex.getMessage(), ex.getMessage().contains("\"naming.columns\" names \"no-such-rule\""));
        assertTrue(ex.getMessage(), ex.getMessage().contains("Java port"));
        assertTrue(ex.getMessage(), ex.getMessage().contains("built in: snake_case, literal, kebab-case, pascal"));
        assertThrows(MetaDataException.class, () -> NamingStrategies.table("pascal"));
    }

    @Test
    public void theConfigReaderSelectsAnApplicationStrategyByName() {
        NamingStrategies.registerColumns("java-test-config", n -> n.toUpperCase(java.util.Locale.ROOT));
        PhysicalNaming naming = NeutralConfig.parse(
            "{ \"schema_version\": 1, \"naming\": { \"columns\": \"java-test-config\" } }", "test").getPhysicalNaming();
        assertEquals("java-test-config", naming.columns());
        assertEquals(PhysicalNaming.TABLE_SNAKE_CASE, naming.tables());
    }
}
