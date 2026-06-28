package com.metaobjects.generator.template;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataLoaderTestBase;
import com.metaobjects.object.MetaObject;
import org.junit.Test;

import java.nio.file.Files;
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

    /**
     * The data dict is a byte-gated cross-port contract: object {@code abstract}
     * and field {@code @required}/{@code @maxLength} must be read OWN-ONLY (matching
     * the TS oracle's {@code ownAttr}), never walking the super-chain. A concrete
     * entity that {@code extends} an abstract base must NOT inherit the base's
     * abstract flag (else it is silently dropped from model output), and a field
     * that {@code extends} a base field must NOT reflect the base's inherited attrs.
     */
    @Test public void abstractAndFieldAttrsAreOwnOnly() throws Exception {
        String json = "{\n"
            + "  \"metadata.root\": {\n"
            + "    \"package\": \"inh\",\n"
            + "    \"children\": [\n"
            + "      { \"object.entity\": { \"name\": \"Base\", \"abstract\": true, \"children\": [\n"
            + "        { \"field.string\": { \"name\": \"code\", \"@required\": true, \"@maxLength\": 50 } }\n"
            + "      ] } },\n"
            + "      { \"field.string\": { \"name\": \"CodeBase\", \"abstract\": true, \"@required\": true, \"@maxLength\": 50 } },\n"
            + "      { \"object.entity\": { \"name\": \"Widget\", \"extends\": \"inh::Base\", \"children\": [\n"
            + "        { \"source.rdb\": { \"@table\": \"widgets\" } },\n"
            + "        { \"field.long\": { \"name\": \"id\" } },\n"
            + "        { \"field.string\": { \"name\": \"label\", \"extends\": \"inh::CodeBase\" } },\n"
            + "        { \"identity.primary\": { \"name\": \"primary\", \"@fields\": [\"id\"], \"@generation\": \"increment\" } }\n"
            + "      ] } }\n"
            + "    ]\n"
            + "  }\n"
            + "}\n";
        Path file = Files.createTempFile("meta.inh.", ".json");
        Files.writeString(file, json);
        try {
            MetaDataLoader loader = initLoader(List.of(file.toUri()));

            // Abstract base is excluded; concrete subclass is included in model output.
            Map<String, Object> model = TemplateData.model(loader.getMetaObjects());
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> pkgs = (List<Map<String, Object>>) model.get("packages");
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> ents = (List<Map<String, Object>>) pkgs.get(0).get("entities");
            assertEquals(List.of("Widget"), ents.stream().map(e -> e.get("name")).toList());
            assertTrue(TemplateData.isConcrete(obj(loader, "Widget")));
            assertFalse(TemplateData.isConcrete(obj(loader, "Base")));

            // A field that extends a base field carrying @required/@maxLength must NOT
            // reflect those inherited attrs (own-only, matching TS ownAttr).
            Map<String, Object> widget = TemplateData.entity(obj(loader, "Widget"));
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> fields = (List<Map<String, Object>>) widget.get("fields");
            Map<String, Object> label = fields.stream().filter(f -> f.get("name").equals("label")).findFirst().orElseThrow();
            assertEquals(Boolean.FALSE, label.get("required"));
            assertFalse(label.containsKey("maxLength"));
        } finally {
            Files.deleteIfExists(file);
        }
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
