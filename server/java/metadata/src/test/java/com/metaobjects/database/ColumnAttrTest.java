package com.metaobjects.database;

import com.metaobjects.field.MetaField;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.util.Arrays;

import static org.junit.Assert.*;

/**
 * Verifies that {@code @column} is the registered optional attribute on fields
 * for the physical column name (source-v2 Tier-1 alignment with the TS reference
 * and the shared conformance corpus).
 *
 * <p>Prior to the source-v2 rename, this attr was {@code @dbColumn}. The DB-
 * prefixed form is intentionally not registered: {@code @column} is paradigm-
 * neutral and pairs with {@code source.rdb @table}.</p>
 */
public class ColumnAttrTest extends SharedRegistryTestBase {

    private MetaDataLoader load() {
        return createTestLoader("column-attr-test", Arrays.asList(
            URIHelper.toURI("model:resource:meta.column.json")
        ));
    }

    @Test
    public void field_loads_column_attr_and_round_trips() {
        MetaDataLoader loader = load();

        MetaObject person = loader.getMetaObjectByName("myapp::commerce::Person");
        assertNotNull("Person object should be found", person);

        MetaField firstName = person.getMetaField("firstName");
        assertNotNull("firstName field should be found", firstName);

        assertTrue("firstName should have @column attr",
            firstName.hasMetaAttr(CoreDBMetaDataProvider.COLUMN));
        assertEquals("firstName @column should be 'first_name'",
            "first_name",
            firstName.getMetaAttr(CoreDBMetaDataProvider.COLUMN).getValueAsString());
    }

    @Test
    public void column_constant_is_paradigm_neutral_literal() {
        // Tier-1 cross-language vocabulary: must be the literal "column" (matches
        // the TS reference and the shared conformance corpus). Do NOT regress to
        // "dbColumn".
        assertEquals("column", CoreDBMetaDataProvider.COLUMN);
    }
}
