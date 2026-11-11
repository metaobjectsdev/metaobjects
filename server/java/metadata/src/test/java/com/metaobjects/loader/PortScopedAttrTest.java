package com.metaobjects.loader;

import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.After;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * {@code @dbSetName} (the C# EF DbSet property name) is in the shared registry with
 * {@code ports: ["csharp"]}. Java registers and type-checks it, so a model that carries it loads
 * strictly here, and Java does nothing with it. An attribute the registry does not carry still
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
    public void aCsharpOnlyAttributeLoadsStrictly() {
        assertTrue(loads("\"@dbSetName\": \"Diagnosis\","));
    }

    @Test
    public void itIsTypeChecked() {
        assertFalse(loads("\"@dbSetName\": [\"Diagnosis\"],"));
    }

    @Test
    public void anAttributeTheRegistryDoesNotCarryStillFails() {
        assertFalse(loads("\"@dbSetNameX\": \"Diagnosis\","));
    }
}
