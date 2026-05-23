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
 * Verifies that {@code @previousName} is a registered optional attribute on objects
 * and fields, and that it round-trips correctly through the canonical JSON loader.
 *
 * <p>FR-003 Plan 3 — Task A1: rename hint for the schema-migration engine.
 * Declaring {@code "@previousName": "old"} on an object or field tells the migrator
 * to emit a RENAME statement instead of a drop-and-add pair.</p>
 */
public class PreviousNameAttrTest extends SharedRegistryTestBase {

    private MetaDataLoader load() {
        return createTestLoader("previousName-test", Arrays.asList(
            URIHelper.toURI("model:resource:meta.rename.json")
        ));
    }

    @Test
    public void object_and_field_load_previousName_without_constraint_violation() {
        // Must not throw — attr is registered + allowed on object.pojo and field.string
        MetaDataLoader loader = load();

        MetaObject program = loader.getMetaObjectByName("myapp::commerce::Program");
        assertNotNull("Program object should be found", program);

        assertTrue("Program should have @previousName attr",
            program.hasMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME));
        assertEquals("Program @previousName should be 'offering'",
            "offering",
            program.getMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME).getValueAsString());

        MetaField title = program.getMetaField("title");
        assertNotNull("title field should be found", title);

        assertTrue("title should have @previousName attr",
            title.hasMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME));
        assertEquals("title @previousName should be 'name'",
            "name",
            title.getMetaAttr(CoreDBMetaDataProvider.PREVIOUS_NAME).getValueAsString());
    }
}
