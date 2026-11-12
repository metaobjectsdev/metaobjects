package com.metaobjects.loader;

import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.After;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * {@code @collectionName} is shared vocabulary marked {@code implementedIn: ["csharp"]}
 * (the DbSet property it names is generated there). Java registers and
 * type-checks it, so a model that carries it loads strictly here. The never-released
 * {@code @dbSetName} it replaced is not vocabulary; an attribute the registry does not carry still
 * fails, and a wrong value type fails.
 */
public class PortScopedAttrTest {

    @After
    public void reset() {
        ObjectClassRegistry.resetGlobal();
    }

    private static String model(String attr) {
        return "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [\n"
            + "  { \"object.entity\": { \"name\": \"Diagnosis\", " + attr + " \"children\": [\n"
            + "    { \"source.rdb\": { \"@table\": \"diagnoses\" } },\n"
            + "    { \"field.long\": { \"name\": \"id\" } },\n"
            + "    { \"identity.primary\": { \"@fields\": \"id\" } }\n"
            + "  ] } }\n] } }";
    }

    private static boolean loads(String attr) {
        MetaDataLoader loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "port-scoped");
        loader.init();
        try {
            loader.load(List.of(new InMemoryStringSource(model(attr), "port-scoped/meta.json")));
            return loader.getErrors() == null || loader.getErrors().isEmpty();
        } catch (RuntimeException e) {
            return false;
        }
    }

    @Test
    public void aCollectionNameLoadsStrictly() {
        assertTrue(loads("\"@collectionName\": \"Diagnoses\","));
    }

    @Test
    public void itIsTypeChecked() {
        assertFalse(loads("\"@collectionName\": [\"Diagnoses\"],"));
    }

    @Test
    public void theNeverReleasedDbSetNameIsNotVocabulary() {
        assertFalse(loads("\"@dbSetName\": \"Diagnoses\","));
    }

    @Test
    public void anAttributeTheRegistryDoesNotCarryStillFails() {
        assertFalse(loads("\"@collectionNameX\": \"Diagnoses\","));
    }
}
