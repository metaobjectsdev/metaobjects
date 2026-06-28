package com.metaobjects.generator.template;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataLoaderTestBase;
import com.metaobjects.object.MetaObject;
import org.junit.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.*;

public class TemplateDataTest extends MetaDataLoaderTestBase {

    private static Path repoRoot() {
        return Path.of(System.getProperty("user.dir")).resolve("../../..").normalize();
    }

    private MetaDataLoader loadShop() {
        Path meta = repoRoot().resolve("fixtures/template-codegen-conformance/metadata/meta.shop.json");
        return initLoader(List.of(meta.toUri()));
    }

    private MetaObject obj(MetaDataLoader loader, String bareName) {
        return loader.getMetaObjects().stream()
            .filter(o -> TemplateData.bareName(o).equals(bareName))
            .findFirst().orElseThrow();
    }

    @Test public void entityDictHasNeutralFields() {
        MetaDataLoader loader = loadShop();
        Map<String, Object> d = TemplateData.entity(obj(loader, "Product"));
        assertEquals("Product", d.get("name"));      // bare, not the FQN
        assertEquals("shop", d.get("package"));

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> fields = (List<Map<String, Object>>) d.get("fields");
        Map<String, Object> name = fields.stream().filter(f -> f.get("name").equals("name")).findFirst().orElseThrow();
        assertEquals("string", name.get("type"));
        assertEquals(Boolean.TRUE, name.get("required"));
        assertEquals(Boolean.FALSE, name.get("isArray"));
        assertEquals(120, ((Number) name.get("maxLength")).intValue());

        Map<String, Object> status = fields.stream().filter(f -> f.get("name").equals("status")).findFirst().orElseThrow();
        assertEquals("enum", status.get("type"));
        assertEquals(List.of("ACTIVE", "ARCHIVED"), status.get("enumValues"));

        // id has no maxLength/enumValues — those keys must be ABSENT (not null)
        Map<String, Object> id = fields.stream().filter(f -> f.get("name").equals("id")).findFirst().orElseThrow();
        assertFalse(id.containsKey("maxLength"));
        assertFalse(id.containsKey("enumValues"));
    }

    @Test public void orderRelationship() {
        MetaDataLoader loader = loadShop();
        Map<String, Object> d = TemplateData.entity(obj(loader, "Order"));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> rels = (List<Map<String, Object>>) d.get("relationships");
        assertEquals(1, rels.size());
        assertEquals("product", rels.get(0).get("name"));
        assertEquals("one", rels.get(0).get("cardinality"));
        assertEquals("Product", rels.get(0).get("targetRef"));
    }

    @Test public void modelGroupsByPackageConcreteOnly() {
        MetaDataLoader loader = loadShop();
        Map<String, Object> model = TemplateData.model(loader.getMetaObjects());
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> pkgs = (List<Map<String, Object>>) model.get("packages");
        assertEquals(1, pkgs.size());
        assertEquals("shop", pkgs.get(0).get("package"));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> ents = (List<Map<String, Object>>) pkgs.get(0).get("entities");
        assertEquals(2, ents.size());
    }
}
