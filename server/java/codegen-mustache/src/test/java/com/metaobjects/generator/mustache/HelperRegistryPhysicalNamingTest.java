package com.metaobjects.generator.mustache;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.metaobjects.config.NeutralConfig;
import com.metaobjects.field.MetaField;
import com.metaobjects.loader.FileSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * ADR-0058 — the {@code dbTableName} and {@code dbColumnName} template helpers name what the
 * shared physical-naming corpus ({@code fixtures/naming-conformance/physical-names/}) says every
 * port's schema has, under each {@code naming} rule, so a Mustache template never spells a table
 * or column the database does not have.
 */
public class HelperRegistryPhysicalNamingTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static Path corpusDir() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.getParent();
        if (dir == null) throw new IllegalStateException("could not locate the repository fixtures/ directory");
        return dir.resolve("fixtures/naming-conformance/physical-names");
    }

    private static MetaDataLoader load(String name, JsonNode naming) {
        ObjectNode config = JSON.createObjectNode().put("schema_version", 1);
        if (naming != null && !naming.isNull()) config.set("naming", naming);
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL,
            "mustache_naming_" + name.replaceAll("[^a-zA-Z0-9]+", "_"));
        loader.init();
        loader.load(List.of(new FileSource(corpusDir().resolve("meta.naming.json"))));
        if (!loader.getErrors().isEmpty()) fail(name + ": expected a clean load, got: " + loader.getErrors());
        loader.getRoot().setPhysicalNaming(NeutralConfig.parse(config.toString(), name).getPhysicalNaming());
        return loader;
    }

    private static MetaObject object(MetaDataLoader loader, String shortName) {
        for (MetaObject obj : loader.getMetaObjects()) {
            if (shortName.equals(obj.getShortName())) return obj;
        }
        throw new AssertionError("object '" + shortName + "' not found in meta.naming.json");
    }

    @Test
    public void tableAndColumnHelpersFollowEveryCorpusNamingRule() throws IOException {
        HelperRegistry helpers = new HelperRegistry();
        JsonNode corpus = JSON.readTree(corpusDir().resolve("cases.json").toFile());
        int checked = 0;
        for (JsonNode c : corpus.get("cases")) {
            String name = c.get("name").asText();
            MetaDataLoader loader = load(name, c.get("naming"));
            for (Iterator<Map.Entry<String, JsonNode>> it = c.get("tables").fields(); it.hasNext(); ) {
                Map.Entry<String, JsonNode> e = it.next();
                assertEquals(name + ": dbTableName of " + e.getKey(), e.getValue().asText(),
                    helpers.get("dbTableName").apply(object(loader, e.getKey())));
                checked++;
            }
            for (Iterator<Map.Entry<String, JsonNode>> it = c.get("columns").fields(); it.hasNext(); ) {
                Map.Entry<String, JsonNode> e = it.next();
                String[] parts = e.getKey().split("\\.", 2);
                MetaField<?> field = object(loader, parts[0]).getMetaField(parts[1]);
                assertEquals(name + ": dbColumnName of " + e.getKey(), e.getValue().asText(),
                    helpers.get("dbColumnName").apply(field));
                checked++;
            }
        }
        assertTrue("the corpus named no tables or columns", checked > 0);
    }

    @Test
    public void tableHelperCasesAMultiWordEntityByTheTableRule() {
        HelperRegistry helpers = new HelperRegistry();
        assertEquals("order_items",
            helpers.get("dbTableName").apply(object(load("snake", JSON.createObjectNode()), "OrderItem")));
        assertEquals("OrderItems",
            helpers.get("dbTableName").apply(object(
                load("literal", JSON.createObjectNode().put("tables", "literal")), "OrderItem")));
    }
}
