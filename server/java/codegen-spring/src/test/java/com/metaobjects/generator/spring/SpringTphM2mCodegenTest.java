package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * FW-8 — M:N traversal routes inside a TPH hierarchy. Before this fix, {@code execute()}
 * skipped every TPH subtype and {@code emitTph()} never consulted {@link SpringM2mSupport}
 * at all, so BOTH a base-declared and a subtype-declared M:N relationship vanished from the
 * generated TPH controller/repository. Neither is a compile error — a route that is never
 * mounted is an absence — which is why the codegen-compile gate (which excludes the
 * controller generator entirely) stayed green while the endpoint 404'd.
 *
 * <p>Model: {@code Auth} (base, {@code @discriminator: type}) declares a hetero M:N
 * {@code tags -> Tag} through {@code AuthTag} — resolved by the base AND, inherited, by
 * every concrete subtype. {@code BridgeAuth} ALSO declares its own directed self-join M:N
 * {@code linkedAuths -> BridgeAuth} through {@code AuthLink} — resolved by Bridge only.
 * {@code CopayAuth} declares no M:N of its own.</p>
 */
public class SpringTphM2mCodegenTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    static final String FIXTURE = """
        {
          "metadata.root": { "package": "acme::auth", "children": [
            { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
                { "source.rdb":   { "@table": "auths" } },
                { "field.long":   { "name": "id" } },
                { "field.enum":   { "name": "type", "@values": ["Bridge", "Copay"] } },
                { "field.string": { "name": "reference", "@required": true, "@maxLength": 80 } },
                { "relationship.association": { "name": "tags", "@cardinality": "many",
                    "@objectRef": "Tag", "@through": "AuthTag" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
                { "field.int": { "name": "quantity", "@required": true } },
                { "relationship.association": { "name": "linkedAuths", "@cardinality": "many",
                    "@objectRef": "BridgeAuth", "@through": "AuthLink", "@sourceRefField": "fromAuthId" } }
            ] } },
            { "object.entity": { "name": "CopayAuth", "extends": "Auth", "@discriminatorValue": "Copay", "children": [
                { "field.decimal": { "name": "copayAmount", "@precision": 10, "@scale": 2 } }
            ] } },
            { "object.entity": { "name": "Tag", "children": [
                { "source.rdb":   { "@table": "tags" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "name", "@required": true, "@maxLength": 80 } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "AuthTag", "children": [
                { "source.rdb":         { "@table": "auth_tags" } },
                { "field.long":         { "name": "authId", "@required": true } },
                { "field.long":         { "name": "tagId",  "@required": true } },
                { "identity.primary":   { "@fields": ["authId", "tagId"] } },
                { "identity.reference": { "name": "fkAuth", "@fields": "authId", "@references": "Auth" } },
                { "identity.reference": { "name": "fkTag",  "@fields": "tagId",  "@references": "Tag" } }
            ] } },
            { "object.entity": { "name": "AuthLink", "children": [
                { "source.rdb":         { "@table": "auth_links" } },
                { "field.long":         { "name": "fromAuthId", "@required": true } },
                { "field.long":         { "name": "toAuthId",   "@required": true } },
                { "identity.primary":   { "@fields": ["fromAuthId", "toAuthId"] } },
                { "identity.reference": { "name": "fkFrom", "@fields": "fromAuthId", "@references": "BridgeAuth" } },
                { "identity.reference": { "name": "fkTo",   "@fields": "toAuthId",   "@references": "BridgeAuth" } }
            ] } }
          ] }
        }
        """;

    private MetaDataLoader loadFixture() throws Exception {
        Path workspace = tempFolder.newFolder().toPath();
        return SpringTestFixtures.loadFixture(workspace, "tph-m2m", FIXTURE);
    }

    private String generate(Object generator, MetaDataLoader loader, String relPath) throws Exception {
        Path outDir = tempFolder.newFolder().toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        ((com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>) generator).setArgs(args);
        ((com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>) generator).execute(loader);
        Path f = outDir.resolve(relPath);
        assertTrue("expected generated file " + f, Files.exists(f));
        return Files.readString(f);
    }

    // --- repository ----------------------------------------------------

    @Test
    public void repositoryEmitsWholeTableFinderForBaseDeclaredRelation() throws Exception {
        String src = generate(new SpringRepositoryGenerator(), loadFixture(), "acme/auth/AuthRepository.java");
        assertTrue("expected whole-table findTags; saw:\n" + src,
            src.contains("List<TagDto> findTags(Long sourceId);"));
    }

    @Test
    public void repositoryEmitsSubtypeScopedFinderForInheritedRelation() throws Exception {
        String src = generate(new SpringRepositoryGenerator(), loadFixture(), "acme/auth/AuthRepository.java");
        assertTrue("expected Bridge-scoped findTagsForBridge; saw:\n" + src,
            src.contains("List<TagDto> findTagsForBridge(Long sourceId);"));
        assertTrue("expected Copay-scoped findTagsForCopay; saw:\n" + src,
            src.contains("List<TagDto> findTagsForCopay(Long sourceId);"));
    }

    @Test
    public void repositoryEmitsSubtypeScopedFinderForSubtypeOwnRelation() throws Exception {
        String src = generate(new SpringRepositoryGenerator(), loadFixture(), "acme/auth/AuthRepository.java");
        assertTrue("expected Bridge-scoped findLinkedAuthsForBridge; saw:\n" + src,
            src.contains("List<BridgeAuthDto> findLinkedAuthsForBridge(Long sourceId);"));
        // linkedAuths is declared on BridgeAuth only — Copay never resolves it.
        assertFalse("Copay must not get a linkedAuths finder; saw:\n" + src,
            src.contains("findLinkedAuthsForCopay"));
    }

    // --- controller ------------------------------------------------------

    @Test
    public void controllerMountsBaseLevelTraversalWithNoDiscriminatorScope() throws Exception {
        String src = generate(new SpringControllerGenerator(), loadFixture(), "acme/auth/AuthController.java");
        assertTrue("expected @GetMapping(\"/{id}/tags\"); saw:\n" + src,
            src.contains("@GetMapping(\"/{id}/tags\")"));
        assertTrue("expected findTags delegate; saw:\n" + src,
            src.contains("public ResponseEntity<List<TagDto>> findTags(@PathVariable Long id)"));
        assertTrue("expected delegation to repository.findTags(id); saw:\n" + src,
            src.contains("repository.findTags(id)"));
    }

    @Test
    public void controllerMountsInheritedRelationUnderEachSubtypeSegment() throws Exception {
        String src = generate(new SpringControllerGenerator(), loadFixture(), "acme/auth/AuthController.java");
        assertTrue("expected /bridge/{id}/tags; saw:\n" + src,
            src.contains("@GetMapping(\"/bridge/{id}/tags\")"));
        assertTrue("expected findTagsForBridge delegate; saw:\n" + src,
            src.contains("public ResponseEntity<List<TagDto>> findTagsForBridge(@PathVariable Long id)"));
        assertTrue("expected repository.findTagsForBridge(id); saw:\n" + src,
            src.contains("repository.findTagsForBridge(id)"));

        assertTrue("expected /copay/{id}/tags; saw:\n" + src,
            src.contains("@GetMapping(\"/copay/{id}/tags\")"));
        assertTrue("expected findTagsForCopay delegate; saw:\n" + src,
            src.contains("public ResponseEntity<List<TagDto>> findTagsForCopay(@PathVariable Long id)"));
    }

    @Test
    public void controllerMountsSubtypeOwnRelationOnlyUnderItsOwnSegment() throws Exception {
        String src = generate(new SpringControllerGenerator(), loadFixture(), "acme/auth/AuthController.java");
        assertTrue("expected /bridge/{id}/linkedAuths; saw:\n" + src,
            src.contains("@GetMapping(\"/bridge/{id}/linkedAuths\")"));
        assertTrue("expected findLinkedAuthsForBridge delegate; saw:\n" + src,
            src.contains("public ResponseEntity<List<BridgeAuthDto>> findLinkedAuthsForBridge(@PathVariable Long id)"));
        // Copay resolves no linkedAuths relationship — no mount, no finder reference.
        assertFalse("Copay must not mount /copay/{id}/linkedAuths; saw:\n" + src,
            src.contains("/copay/{id}/linkedAuths"));
        assertFalse("Copay must not reference a linkedAuths finder; saw:\n" + src,
            src.contains("findLinkedAuthsForCopay"));
    }

    @Test
    public void polymorphicAndPerSubtypeCrudMountsAreStillEmitted() throws Exception {
        String src = generate(new SpringControllerGenerator(), loadFixture(), "acme/auth/AuthController.java");
        assertTrue(src.contains("@GetMapping\n    public ResponseEntity<?> list("));
        assertTrue(src.contains("@GetMapping(\"/bridge\")"));
        assertTrue(src.contains("@GetMapping(\"/copay\")"));
    }
}
