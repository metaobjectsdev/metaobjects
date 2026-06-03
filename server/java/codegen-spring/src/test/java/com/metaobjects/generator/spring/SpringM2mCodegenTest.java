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

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * FR-018 Unit 12 — string-assertion coverage for the Java M:N codegen surface:
 * the controller's {@code GET /{id}/<relationName>} sub-resource and the
 * repository's M:N finder method. Mirrors the cross-port REST contract from
 * {@code fixtures/api-contract-conformance/m2m/}: hetero ({@code Post}—tags→
 * {@code Tag} via {@code PostTag}), directed self-join ({@code Person}—following→
 * {@code Person} via {@code Follow}, {@code @sourceRefField}), and symmetric
 * self-join ({@code Person}—friends→ {@code Person} via {@code Friendship},
 * {@code @symmetric}).
 */
public class SpringM2mCodegenTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    /** The 6-entity model from the shared m2m api-contract corpus, inlined. */
    private static final String M2M_FIXTURE = """
        {
          "metadata.root": { "package": "acme::social", "children": [
            { "object.entity": { "name": "Post", "children": [
                { "source.rdb":   { "@table": "posts" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "title", "@required": true, "@maxLength": 200 } },
                { "relationship.association": { "name": "tags", "@cardinality": "many",
                    "@objectRef": "Tag", "@through": "PostTag" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "Tag", "children": [
                { "source.rdb":   { "@table": "tags" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "name", "@required": true, "@maxLength": 80 } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "PostTag", "children": [
                { "source.rdb":         { "@table": "post_tags" } },
                { "field.long":         { "name": "postId", "@required": true } },
                { "field.long":         { "name": "tagId",  "@required": true } },
                { "identity.primary":   { "@fields": ["postId", "tagId"] } },
                { "identity.reference": { "name": "fkPost", "@fields": "postId", "@references": "Post" } },
                { "identity.reference": { "name": "fkTag",  "@fields": "tagId",  "@references": "Tag" } }
            ] } },
            { "object.entity": { "name": "Person", "children": [
                { "source.rdb":   { "@table": "people" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "name", "@required": true, "@maxLength": 80 } },
                { "relationship.association": { "name": "following", "@cardinality": "many",
                    "@objectRef": "Person", "@through": "Follow", "@sourceRefField": "followerId" } },
                { "relationship.association": { "name": "friends", "@cardinality": "many",
                    "@objectRef": "Person", "@through": "Friendship", "@symmetric": true } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "Follow", "children": [
                { "source.rdb":         { "@table": "follows" } },
                { "field.long":         { "name": "followerId", "@required": true } },
                { "field.long":         { "name": "followeeId", "@required": true } },
                { "identity.primary":   { "@fields": ["followerId", "followeeId"] } },
                { "identity.reference": { "name": "fkFollower", "@fields": "followerId", "@references": "Person" } },
                { "identity.reference": { "name": "fkFollowee", "@fields": "followeeId", "@references": "Person" } }
            ] } },
            { "object.entity": { "name": "Friendship", "children": [
                { "source.rdb":         { "@table": "friendships" } },
                { "field.long":         { "name": "personAId", "@required": true } },
                { "field.long":         { "name": "personBId", "@required": true } },
                { "identity.primary":   { "@fields": ["personAId", "personBId"] } },
                { "identity.reference": { "name": "fkPersonA", "@fields": "personAId", "@references": "Person" } },
                { "identity.reference": { "name": "fkPersonB", "@fields": "personBId", "@references": "Person" } }
            ] } }
          ] }
        }
        """;

    private MetaDataLoader loadM2m() throws Exception {
        Path workspace = tempFolder.newFolder().toPath();
        return SpringTestFixtures.loadFixture(workspace, "m2m", M2M_FIXTURE);
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

    @Test
    public void heteroControllerEmitsTraversalEndpoint() throws Exception {
        String src = generate(new SpringControllerGenerator(), loadM2m(), "acme/social/PostController.java");
        // Sub-resource route: GET /{id}/tags returning the related Tag DTO rows.
        assertTrue("expected @GetMapping(\"/{id}/tags\"); saw:\n" + src,
            src.contains("@GetMapping(\"/{id}/tags\")"));
        assertTrue("expected findTags traversal method; saw:\n" + src,
            src.contains("public ResponseEntity<List<TagDto>> findTags(@PathVariable Long id)"));
        assertTrue("expected delegation to repository.findTags(id); saw:\n" + src,
            src.contains("repository.findTags(id)"));
    }

    @Test
    public void heteroRepositoryEmitsFinder() throws Exception {
        String src = generate(new SpringRepositoryGenerator(), loadM2m(), "acme/social/PostRepository.java");
        assertTrue("expected M:N finder List<TagDto> findTags(Long sourceId); saw:\n" + src,
            src.contains("List<TagDto> findTags(Long sourceId);"));
    }

    @Test
    public void selfJoinControllerEmitsBothDirectedAndSymmetricEndpoints() throws Exception {
        String src = generate(new SpringControllerGenerator(), loadM2m(), "acme/social/PersonController.java");
        // Directed self-join: /people/:id/following ... route uses the relation name.
        assertTrue("expected /{id}/following endpoint; saw:\n" + src,
            src.contains("@GetMapping(\"/{id}/following\")"));
        assertTrue("expected findFollowing; saw:\n" + src,
            src.contains("public ResponseEntity<List<PersonDto>> findFollowing(@PathVariable Long id)"));
        // Symmetric self-join: /people/:id/friends.
        assertTrue("expected /{id}/friends endpoint; saw:\n" + src,
            src.contains("@GetMapping(\"/{id}/friends\")"));
        assertTrue("expected findFriends; saw:\n" + src,
            src.contains("public ResponseEntity<List<PersonDto>> findFriends(@PathVariable Long id)"));
    }

    @Test
    public void selfJoinRepositoryEmitsBothFinders() throws Exception {
        String src = generate(new SpringRepositoryGenerator(), loadM2m(), "acme/social/PersonRepository.java");
        assertTrue("expected findFollowing finder; saw:\n" + src,
            src.contains("List<PersonDto> findFollowing(Long sourceId);"));
        assertTrue("expected findFriends finder; saw:\n" + src,
            src.contains("List<PersonDto> findFriends(Long sourceId);"));
        // Symmetric edge is marked in the javadoc so the consumer knows to union on read.
        assertTrue("expected symmetric marker in javadoc; saw:\n" + src,
            src.contains("symmetric — union on read"));
    }

    @Test
    public void junctionEntityEmitsNoTraversalEndpoint() throws Exception {
        // The junction (PostTag) is itself a writable table entity, so a CRUD controller
        // is emitted — but it declares no M:N relationship, so no traversal sub-resource.
        String src = generate(new SpringControllerGenerator(), loadM2m(), "acme/social/PostTagController.java");
        assertFalse("junction controller must not emit a traversal endpoint; saw:\n" + src,
            src.contains("/{id}/"));
    }

    @Test
    public void m2mFinderNameCapitalizesRelation() {
        assertEquals("findTags", SpringRepositoryGenerator.m2mFinderName("tags"));
        assertEquals("findFollowing", SpringRepositoryGenerator.m2mFinderName("following"));
    }
}
