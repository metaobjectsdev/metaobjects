package com.metaobjects.generator.spring;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.identity.ReferenceIdentity;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.References;
import com.metaobjects.loader.uri.URIHelper;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.relationship.M2MFields;
import com.metaobjects.relationship.MetaRelationship;
import com.metaobjects.relationship.RelationshipReferences;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Cross-port conformance (Java/Spring) for ADR-0059 Decision 7: codegen binds the target a
 * reference names, never a same-short-named object in another package and never the package
 * of the entity that inherits the attribute. Loads
 * {@code fixtures/codegen-conformance/cross-package-binding/input/} and checks every entry of
 * {@code expected-bindings.json}, then the generated controller and repository text.
 */
public class CrossPackageBindingConformanceTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static Path fixtureDir() {
        Path repoRoot = Path.of(System.getProperty("user.dir")).resolve("../../..").normalize();
        Path dir = repoRoot.resolve("fixtures/codegen-conformance/cross-package-binding");
        assertTrue("fixture must exist at " + dir, Files.isDirectory(dir));
        return dir;
    }

    private static MetaDataLoader load() throws IOException {
        List<URI> uris = new ArrayList<>();
        try (Stream<Path> files = Files.list(fixtureDir().resolve("input"))) {
            for (Path p : files.filter(f -> f.toString().endsWith(".json")).sorted().collect(Collectors.toList())) {
                uris.add(URIHelper.toURI("model:file:" + p.toAbsolutePath().toString().replace('\\', '/')));
            }
        }
        assertEquals(4, uris.size());
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "cross-package-binding");
        loader.setSourceURIs(uris);
        loader.init();
        return loader;
    }

    private static JsonNode expected() throws IOException {
        return new ObjectMapper().readTree(Files.readString(fixtureDir().resolve("expected-bindings.json")));
    }

    private static MetaObject objectOf(MetaDataLoader loader, String key) {
        MetaObject o = loader.getMetaObjectByName(key);
        assertNotNull("object " + key + " must load", o);
        return o;
    }

    private static String tableOf(MetaObject o) {
        return o.findPrimaryWritableSource().orElseThrow().getTableName();
    }

    private static String[] splitMember(String key) {
        int dot = key.lastIndexOf('.');
        return new String[] { key.substring(0, dot), key.substring(dot + 1) };
    }

    @Test
    public void everyIdentityReferenceIsBoundToTheExpectedObject() throws Exception {
        MetaDataLoader loader = load();
        JsonNode refs = expected().get("references");
        Iterator<String> keys = refs.fieldNames();
        int checked = 0;
        while (keys.hasNext()) {
            String key = keys.next();
            String[] m = splitMember(key);
            MetaObject holder = objectOf(loader, m[0]);
            ReferenceIdentity ref = null;
            for (MetaIdentity id : holder.getIdentities()) {
                if (id instanceof ReferenceIdentity && m[1].equals(id.getShortName())) ref = (ReferenceIdentity) id;
            }
            assertNotNull("identity.reference " + key, ref);
            MetaObject bound = References.refTarget(ref, MetaIdentity.ATTR_REFERENCES);
            assertNotNull("unbound " + key, bound);
            assertEquals("binding of " + key, refs.get(key).asText(), bound.getName());
            checked++;
        }
        assertEquals(6, checked);
    }

    @Test
    public void everyRelationshipResolvesToTheExpectedTargetTablesAndJoinFields() throws Exception {
        MetaDataLoader loader = load();
        JsonNode relations = expected().get("relations");
        Iterator<String> keys = relations.fieldNames();
        int checked = 0;
        while (keys.hasNext()) {
            String key = keys.next();
            JsonNode want = relations.get(key);
            String[] m = splitMember(key);
            MetaObject owner = objectOf(loader, m[0]);
            MetaRelationship rel = null;
            for (MetaRelationship r : owner.getRelationships()) {
                if (m[1].equals(r.getShortName())) rel = r;
            }
            assertNotNull("relationship " + key, rel);

            MetaObject target = References.refTarget(rel, MetaRelationship.ATTR_OBJECT_REF);
            assertNotNull("unbound target of " + key, target);
            assertEquals("target of " + key, want.get("target").asText(), target.getName());
            assertEquals("target table of " + key, want.get("targetTable").asText(), tableOf(target));

            if ("many".equals(want.get("cardinality").asText())) {
                MetaObject junction = References.refTarget(rel, MetaRelationship.ATTR_THROUGH);
                assertNotNull("unbound junction of " + key, junction);
                assertEquals("junction of " + key, want.get("junction").asText(), junction.getName());
                assertEquals("junction table of " + key, want.get("junctionTable").asText(), tableOf(junction));
                M2MFields fields = M2MFields.derive(rel, owner, loader.getRoot());
                assertEquals("source join field of " + key, want.get("sourceJoinField").asText(), fields.getSourceField());
                assertEquals("target join field of " + key, want.get("targetJoinField").asText(), fields.getTargetField());

                SpringM2mSupport.M2mNav nav = SpringM2mSupport.resolve(owner, loader).stream()
                    .filter(n -> n.relationName().equals(m[1])).findFirst().orElse(null);
                assertNotNull("codegen M:N navigation for " + key, nav);
                assertEquals(want.get("sourceJoinField").asText(), nav.sourceField());
                assertEquals(want.get("targetJoinField").asText(), nav.targetField());
            } else {
                ReferenceIdentity fk = RelationshipReferences.resolveRelationshipReference(
                    owner, rel.getShortName(), target, rel.getSourceRefField());
                assertNotNull("fk reference of " + key, fk);
                assertEquals("fk field of " + key, want.get("fkField").asText(), fk.getFields().get(0));
            }
            checked++;
        }
        assertEquals(4, checked);
    }

    @Test
    public void inheritedRootReferencesBindTheRootObjectNotTheInheritingPackages() throws Exception {
        MetaDataLoader loader = load();
        MetaObject order = objectOf(loader, "acme::Order");
        MetaObject customer = loader.getMetaObjectByName("Customer");
        MetaObject label = loader.getMetaObjectByName("Label");
        MetaRelationship customerRel = null;
        MetaRelationship labelsRel = null;
        for (MetaRelationship r : order.getRelationships()) {
            if ("customer".equals(r.getShortName())) customerRel = r;
            if ("labels".equals(r.getShortName())) labelsRel = r;
        }
        assertTrue(References.refTarget(customerRel, MetaRelationship.ATTR_OBJECT_REF) == customer);
        assertTrue(References.refTarget(labelsRel, MetaRelationship.ATTR_OBJECT_REF) == label);
        assertTrue(References.lookupCanonical(loader.getRoot(),
            customerRel.getMetaAttr(MetaRelationship.ATTR_OBJECT_REF).getValueAsString()) == customer);
    }

    private Map<String, String> generateAll(MetaDataLoader loader) throws IOException {
        Path out = tmp.newFolder().toPath();
        for (MultiFileDirectGeneratorBase<?> gen : List.of(
                new SpringDtoGenerator(), new SpringRepositoryGenerator(), new SpringControllerGenerator())) {
            Map<String, String> args = new HashMap<>();
            args.put("outputDir", out.toString());
            gen.setArgs(args);
            gen.execute(loader);
        }
        Map<String, String> files = new HashMap<>();
        try (Stream<Path> walk = Files.walk(out)) {
            for (Path p : walk.filter(f -> f.toString().endsWith(".java")).collect(Collectors.toList())) {
                files.put(out.relativize(p).toString().replace('\\', '/'), Files.readString(p));
            }
        }
        return files;
    }

    @Test
    public void generatedControllerAndRepositoryUseTheBoundTargets() throws Exception {
        Map<String, String> files = generateAll(load());

        String postController = files.get("a/PostController.java");
        String postRepo = files.get("a/PostRepository.java");
        assertNotNull(postController);
        assertNotNull(postRepo);
        assertTrue("Post.tags must traverse to b::Tag; saw:\n" + postController,
            postController.contains("ResponseEntity<List<b.TagDto>> findTags(@PathVariable Long id)"));
        assertTrue("Post.tags finder must return b::Tag rows; saw:\n" + postRepo,
            postRepo.contains("List<b.TagDto> findTags(Long sourceId);"));
        assertFalse("Post must not bind a::Tag; saw:\n" + postController,
            postController.replace("b.TagDto", "").contains("TagDto"));

        String orderController = files.get("acme/OrderController.java");
        String orderRepo = files.get("acme/OrderRepository.java");
        assertNotNull(orderController);
        assertNotNull(orderRepo);
        assertTrue("Order.labels must traverse via the root OrderLabel junction; saw:\n" + orderController,
            orderController.contains("findLabels(@PathVariable Long id)"));
        assertTrue("saw:\n" + orderRepo, orderRepo.contains("findLabels(Long sourceId);"));

        for (Map.Entry<String, String> f : files.entrySet()) {
            for (String wrong : List.of("a_tags", "acme_labels", "acme_customers")) {
                assertFalse(f.getKey() + " must not mention " + wrong, f.getValue().contains(wrong));
            }
        }
    }
}
