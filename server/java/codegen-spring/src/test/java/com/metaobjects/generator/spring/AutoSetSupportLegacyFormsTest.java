package com.metaobjects.generator.spring;

import com.metaobjects.field.MetaField;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.util.List;
import java.util.stream.Collectors;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * The four {@code AutoSetSupport} selectors that shipped through 1.0.13 still compile and
 * answer as they did, so an adopter's own code, or a copy ejected before 1.1.0, keeps
 * building after the upgrade.
 *
 * <p>The call forms below are the 1.0.13 ones: one {@link MetaObject} argument, the same
 * return types. The expected field sets come from the fixture's own {@code @autoSet}
 * declarations, not from the implementation.
 */
@SuppressWarnings("deprecation")
public class AutoSetSupportLegacyFormsTest {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private static final String SUBSCRIBER = """
        { "metadata.root": { "package": "acme::sub", "children": [
          { "object.entity": { "name": "Subscriber", "children": [
            { "source.rdb":      { "@table": "subscribers" } },
            { "field.long":      { "name": "id" } },
            { "field.string":    { "name": "email", "@required": true } },
            { "field.timestamp": { "name": "createdAt", "@autoSet": "onCreate" } },
            { "field.timestamp": { "name": "updatedAt", "@autoSet": "onUpdate" } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
          ]}},
          { "object.entity": { "name": "Note", "children": [
            { "source.rdb":      { "@table": "notes" } },
            { "field.long":      { "name": "id" } },
            { "field.string":    { "name": "body" } },
            { "field.timestamp": { "name": "createdAt" } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
          ]}}
        ]}}
        """;

    private MetaObject entity(String shortName) throws IOException {
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder().toPath(), "sub", SUBSCRIBER);
        for (MetaObject mo : loader.getMetaObjects()) {
            if (mo.getName().endsWith(shortName)) return mo;
        }
        throw new IllegalStateException(shortName + " not in fixture");
    }

    private static List<String> names(List<MetaField> fields) {
        return fields.stream().map(MetaField::getName).collect(Collectors.toList());
    }

    @Test
    public void stampFieldsNamesEveryStampableAutoSetField() throws IOException {
        List<MetaField> fields = AutoSetSupport.stampFields(entity("Subscriber"));
        assertEquals(List.of("createdAt", "updatedAt"), names(fields));
    }

    @Test
    public void onUpdateFieldsNamesOnlyTheOnUpdateField() throws IOException {
        List<MetaField> fields = AutoSetSupport.onUpdateFields(entity("Subscriber"));
        assertEquals(List.of("updatedAt"), names(fields));
    }

    @Test
    public void hasFlagsAreTrueForAnAutoSetEntityAndFalseForAPlainOne() throws IOException {
        assertTrue(AutoSetSupport.hasAutoSetFields(entity("Subscriber")));
        assertTrue(AutoSetSupport.hasOnUpdateFields(entity("Subscriber")));
        assertFalse(AutoSetSupport.hasAutoSetFields(entity("Note")));
        assertFalse(AutoSetSupport.hasOnUpdateFields(entity("Note")));
    }
}
