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
 * ADR-0038 — reverse-relationship navigation via explicit FK finders on the Spring
 * repository interface. Loads the shared {@code reverse-finders-same-pair} model
 * (inlined): {@code GameSession} holds THREE FKs to {@code Scene}
 * ({@code currentSceneId} / {@code lastOpeningNarrativeSceneId} /
 * {@code transitioningFromSceneId}) plus one string-PK FK to {@code Player}
 * ({@code playerId}).
 *
 * <p>Asserts the three same-pair Scene FKs yield THREE DISTINCT finder pairs
 * ({@code findByCurrentScene} / {@code findByLastOpeningNarrativeScene} /
 * {@code findByTransitioningFromScene}) — never colliding — each with a single
 * (WHERE fk = ?) + batched (WHERE fk IN (…)) shape, and that the value type tracks
 * the FK column's own type (Long for Scene, String for Player). NOT a lazy
 * {@code @OneToMany} collection.
 */
public class SpringReverseFinderCodegenTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    /** The shared reverse-finders-same-pair model, inlined (3 FKs to Scene + 1 to Player). */
    private static final String FIXTURE = """
        {
          "metadata.root": { "package": "game", "children": [
            { "object.entity": { "name": "Scene", "children": [
                { "source.rdb":   { "@table": "scenes" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "title" } },
                { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "Player", "children": [
                { "source.rdb":   { "@table": "players" } },
                { "field.string": { "name": "id" } },
                { "field.string": { "name": "name" } },
                { "identity.primary": { "name": "id", "@fields": "id", "@generation": "assigned" } }
            ] } },
            { "object.entity": { "name": "GameSession", "children": [
                { "source.rdb":   { "@table": "game_sessions" } },
                { "field.long":   { "name": "id" } },
                { "field.long":   { "name": "currentSceneId" } },
                { "field.long":   { "name": "lastOpeningNarrativeSceneId" } },
                { "field.long":   { "name": "transitioningFromSceneId" } },
                { "field.string": { "name": "playerId" } },
                { "relationship.association": { "name": "currentScene", "@cardinality": "one", "@objectRef": "Scene" } },
                { "relationship.association": { "name": "player", "@cardinality": "one", "@objectRef": "Player" } },
                { "identity.primary":   { "name": "id", "@fields": "id", "@generation": "increment" } },
                { "identity.reference": { "name": "fkCurrentScene", "@fields": "currentSceneId", "@references": "Scene" } },
                { "identity.reference": { "name": "fkLastOpeningNarrativeScene", "@fields": "lastOpeningNarrativeSceneId", "@references": "Scene" } },
                { "identity.reference": { "name": "fkTransitioningFromScene", "@fields": "transitioningFromSceneId", "@references": "Scene" } },
                { "identity.reference": { "name": "fkPlayer", "@fields": "playerId", "@references": "Player" } }
            ] } }
          ] }
        }
        """;

    private MetaDataLoader load() throws Exception {
        Path workspace = tempFolder.newFolder().toPath();
        return SpringTestFixtures.loadFixture(workspace, "reverse-finders", FIXTURE);
    }

    private String generateRepo(MetaDataLoader loader, String relPath) throws Exception {
        Path outDir = tempFolder.newFolder().toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        SpringRepositoryGenerator gen = new SpringRepositoryGenerator();
        gen.setArgs(args);
        gen.execute(loader);
        Path f = outDir.resolve(relPath);
        assertTrue("expected generated file " + f, Files.exists(f));
        return Files.readString(f);
    }

    @Test
    public void samePairThreeScenesYieldThreeDistinctFinders() throws Exception {
        String src = generateRepo(load(), "game/GameSessionRepository.java");

        // Single-value finders — three DISTINCT names, never colliding.
        assertTrue("expected findByCurrentScene single finder; saw:\n" + src,
            src.contains("List<GameSessionDto> findByCurrentScene(Long currentSceneId);"));
        assertTrue("expected findByLastOpeningNarrativeScene single finder; saw:\n" + src,
            src.contains("List<GameSessionDto> findByLastOpeningNarrativeScene(Long lastOpeningNarrativeSceneId);"));
        assertTrue("expected findByTransitioningFromScene single finder; saw:\n" + src,
            src.contains("List<GameSessionDto> findByTransitioningFromScene(Long transitioningFromSceneId);"));

        // Each FK column distinct → no two finders share a name.
        assertEquals("findByCurrentScene must appear exactly once",
            2, countOccurrences(src, "findByCurrentScene")); // single + batched stem
    }

    @Test
    public void eachFinderHasSingleAndBatchedShape() throws Exception {
        String src = generateRepo(load(), "game/GameSessionRepository.java");

        // Batched (anti-N+1) variant per FK: WHERE fk IN (…) → List<value> arg.
        assertTrue("expected findByCurrentSceneIn batched finder; saw:\n" + src,
            src.contains("List<GameSessionDto> findByCurrentSceneIn(List<Long> currentSceneIds);"));
        assertTrue("expected findByLastOpeningNarrativeSceneIn batched finder; saw:\n" + src,
            src.contains("List<GameSessionDto> findByLastOpeningNarrativeSceneIn(List<Long> lastOpeningNarrativeSceneIds);"));
        assertTrue("expected findByTransitioningFromSceneIn batched finder; saw:\n" + src,
            src.contains("List<GameSessionDto> findByTransitioningFromSceneIn(List<Long> transitioningFromSceneIds);"));
    }

    @Test
    public void stringPkFkUsesStringValueType() throws Exception {
        String src = generateRepo(load(), "game/GameSessionRepository.java");

        // Player has a String PK → the playerId FK finder takes a String, not a Long.
        assertTrue("expected findByPlayer(String); saw:\n" + src,
            src.contains("List<GameSessionDto> findByPlayer(String playerId);"));
        assertTrue("expected findByPlayerIn(List<String>); saw:\n" + src,
            src.contains("List<GameSessionDto> findByPlayerIn(List<String> playerIds);"));
    }

    @Test
    public void referencedEntitiesEmitNoReverseFinders() throws Exception {
        // Scene + Player hold no FKs (no identity.reference children) → no reverse finders.
        MetaDataLoader loader = load();
        String scene = generateRepo(loader, "game/SceneRepository.java");
        // No reverse-FK finder block (the standard findById is fine — it is not a reverse finder).
        assertFalse("Scene holds no FK → no reverse finder; saw:\n" + scene,
            scene.contains("Reverse nav:"));
        assertFalse("Scene holds no FK → no findByCurrentScene; saw:\n" + scene,
            scene.contains("findByCurrentScene"));
    }

    @Test
    public void notLazyOneToManyCollection() throws Exception {
        String src = generateRepo(load(), "game/GameSessionRepository.java");
        assertFalse("reverse nav must be explicit finders, not a lazy @OneToMany; saw:\n" + src,
            src.contains("@OneToMany"));
    }

    @Test
    public void fkSegmentDerivationDropsTrailingId() {
        assertEquals("CurrentScene", SpringNaming.reverseFinderFkSegment("currentSceneId"));
        assertEquals("Player", SpringNaming.reverseFinderFkSegment("playerId"));
        assertEquals("findByCurrentScene", SpringNaming.reverseFinderName("currentSceneId"));
        assertEquals("findByCurrentSceneIn", SpringNaming.reverseFinderInName("currentSceneId"));
        // A bare "id" is not reduced to the empty string.
        assertEquals("Id", SpringNaming.reverseFinderFkSegment("id"));
    }

    private static int countOccurrences(String haystack, String needle) {
        int n = 0, i = 0;
        while ((i = haystack.indexOf(needle, i)) >= 0) { n++; i += needle.length(); }
        return n;
    }
}
