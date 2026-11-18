// ReverseFinderCodegenTests — ADR-0038 reverse-relationship navigation via explicit
// FK finders (C# port of the TS reference reverse-finders.test.ts).
//
// Loads the SHARED cross-port fixture (fixtures/conformance/reverse-finders-same-pair)
// and asserts the C# entity generator emits, on the referencing entity's query surface
// (the <Entity>Queries static class), a single + batched FK finder per reverse FK —
// NAMED by the FK FIELD so they never collide. The keystone case: GameSession holds
// THREE FKs to Scene (currentSceneId / lastOpeningNarrativeSceneId /
// transitioningFromSceneId) → THREE distinct finder pairs.
//
// Finder shape (idiomatic C#):
//   Task<List<E>> Find<EPlural>By<FkSegment>(AppDbContext db, <PkType> value)
//        → db.<DbSet>.AsNoTracking().Where(e => e.<FkProp> == value).ToListAsync()
//   Task<List<E>> Find<EPlural>By<FkSegment>In(AppDbContext db, IReadOnlyCollection<...> values)
//        → ... .Where(e => values.Contains(e.<FkProp>)).ToListAsync()
// where <FkSegment> = PascalCase(FkField) with a single trailing "Id" dropped.
//
// Both finders are framework-free, single-query LINQ — NOT lazy ORM collections.

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class ReverseFinderCodegenTests
{
    // Walk upward from the test assembly to the repo root (contains a fixtures/ dir).
    private static string LocateRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "fixtures")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return dir!.FullName;
    }

    private static string FixtureDir =>
        Path.Combine(LocateRepoRoot(), "fixtures", "conformance", "reverse-finders-same-pair", "input");

    private static MetaRoot LoadFixture()
    {
        var load = MetaDataLoader.FromDirectory(FixtureDir);
        Assert.Empty(load.Errors);
        return load.Root;
    }

    private static GenContext Context(MetaRoot root) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Game.Generated", ColumnNamingStrategy = ColumnNamingStrategy.Literal },
    };

    private static string Queries(MetaRoot root, string entity) =>
        new EntityGenerator().Generate(Context(root))
            .Single(f => f.Path == $"{entity}Queries.g.cs").Content;

    // ---- Descriptor: GameSession derives its 4 reverse FKs (3 to Scene, 1 to Player) ----
    [Fact]
    public void Descriptor_derives_all_reverse_fks()
    {
        var gameSession = LoadFixture().FindObject("GameSession")!;
        var fks = ReverseFinderBuilder.For(gameSession);

        Assert.Equal(
            new[] { "currentSceneId", "lastOpeningNarrativeSceneId", "transitioningFromSceneId", "playerId" },
            fks.Select(f => f.FkField).ToArray());
        Assert.Equal("Scene", fks[0].TargetEntity);
        Assert.Equal("Scene", fks[1].TargetEntity);
        Assert.Equal("Scene", fks[2].TargetEntity);
        Assert.Equal("Player", fks[3].TargetEntity);
    }

    // ---- The KEYSTONE: 3 FKs to the SAME target → 3 DISTINCT finder pairs, no collision ----
    [Fact]
    public void SamePair_three_fks_to_scene_yield_three_distinct_finders()
    {
        var queries = Queries(LoadFixture(), "GameSession");

        // Single-value finders — one per Scene FK, disambiguated by the FK field segment.
        Assert.Contains("Task<List<GameSession>> FindGameSessionsByCurrentScene(", queries);
        Assert.Contains("Task<List<GameSession>> FindGameSessionsByLastOpeningNarrativeScene(", queries);
        Assert.Contains("Task<List<GameSession>> FindGameSessionsByTransitioningFromScene(", queries);

        // Batched finders — the same three, distinct.
        Assert.Contains("Task<List<GameSession>> FindGameSessionsByCurrentSceneIn(", queries);
        Assert.Contains("Task<List<GameSession>> FindGameSessionsByLastOpeningNarrativeSceneIn(", queries);
        Assert.Contains("Task<List<GameSession>> FindGameSessionsByTransitioningFromSceneIn(", queries);

        // No collision: each of the six finder names appears exactly once.
        foreach (var name in new[]
        {
            "FindGameSessionsByCurrentScene(", "FindGameSessionsByLastOpeningNarrativeScene(",
            "FindGameSessionsByTransitioningFromScene(", "FindGameSessionsByCurrentSceneIn(",
            "FindGameSessionsByLastOpeningNarrativeSceneIn(", "FindGameSessionsByTransitioningFromSceneIn(",
        })
            Assert.Equal(1, CountOccurrences(queries, name));
    }

    // ---- Single + batched SQL shape (indexed eq / IN; framework-free single query) ----
    [Fact]
    public void Finder_shapes_are_single_indexed_and_batched_in()
    {
        var queries = Queries(LoadFixture(), "GameSession");

        // Single: one indexed WHERE <fk> = value over the entity's DbSet.
        Assert.Contains(
            "await db.GameSessions.AsNoTracking().Where(e => e.CurrentSceneId == currentSceneId).ToListAsync();",
            queries);

        // Batched: one WHERE <fk> IN (values) — the anti-N+1 selectin shape, empty-guarded.
        // currentSceneId is an OPTIONAL FK column (not @required / PK) → long? element type,
        // matching the FK property the entity class declares so Contains type-checks.
        Assert.Contains("FindGameSessionsByCurrentSceneIn(AppDbContext db, IReadOnlyCollection<long?> currentSceneIds)", queries);
        Assert.Contains("if (currentSceneIds.Count == 0) return new List<GameSession>();", queries);
        Assert.Contains(
            "return await db.GameSessions.AsNoTracking().Where(e => currentSceneIds.Contains(e.CurrentSceneId)).ToListAsync();",
            queries);
    }

    // ---- FK value type = the target entity's PK type, nullability = the FK property ----
    // (Scene PK is field.long; Player PK is field.string. The GameSession FK columns are
    // optional — not @required, not PK — so a value-type key gets `?`; a reference-type
    // key [string] is already nullable.)
    [Fact]
    public void Finder_fk_value_type_matches_target_pk()
    {
        var queries = Queries(LoadFixture(), "GameSession");

        // Scene PK is field.long, the FK column is optional → long? finder argument.
        Assert.Contains("FindGameSessionsByCurrentScene(AppDbContext db, long? currentSceneId)", queries);
        // Player PK is field.string → string-typed argument (playerId, trailing "Id" dropped → ByPlayer).
        Assert.Contains("FindGameSessionsByPlayer(AppDbContext db, string playerId)", queries);
        Assert.Contains("FindGameSessionsByPlayerIn(AppDbContext db, IReadOnlyCollection<string> playerIds)", queries);
    }

    // ---- No <Entity>Queries file for an entity with no reverse FK (Scene / Player) ----
    [Fact]
    public void No_queries_file_for_entity_without_fks()
    {
        var files = new EntityGenerator().Generate(Context(LoadFixture())).Select(f => f.Path).ToList();
        Assert.DoesNotContain("SceneQueries.g.cs", files);
        Assert.DoesNotContain("PlayerQueries.g.cs", files);
        Assert.Contains("GameSessionQueries.g.cs", files);
    }

    // ---- No lazy reverse collection: GameSession's entity class declares NO ICollection<...> ----
    // (M:N junction navigation is separate and uses @through — this fixture has none.)
    [Fact]
    public void No_lazy_reverse_collection_on_scene_or_player()
    {
        var files = new EntityGenerator().Generate(Context(LoadFixture())).ToList();
        var scene = files.Single(f => f.Path == "Scene.g.cs").Content;
        var player = files.Single(f => f.Path == "Player.g.cs").Content;
        // No lazy reverse collection of the referencing entity hangs off the referenced entity.
        Assert.DoesNotContain("ICollection<GameSession>", scene);
        Assert.DoesNotContain("ICollection<GameSession>", player);
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0, i = 0;
        while ((i = haystack.IndexOf(needle, i, StringComparison.Ordinal)) >= 0) { count++; i += needle.Length; }
        return count;
    }
}
