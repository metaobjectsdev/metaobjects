// FR-023 — the pieces of the consume side the shared corpus does not enumerate: the config's
// `dependencies` / `scope.include` / `migrate.scope` shape, the lock's shape, and the package-naming rule.
using MetaObjects;
using MetaObjects.Config;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public sealed class DependencyUnitTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("mo-dep-unit-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_root, true); } catch (IOException) { /* temp dir */ }
    }

    private void WriteConfig(string json)
    {
        Directory.CreateDirectory(Path.Combine(_root, ".metaobjects"));
        File.WriteAllText(Path.Combine(_root, ".metaobjects", "config.json"), json);
    }

    private void WriteLock(string json)
    {
        Directory.CreateDirectory(Path.Combine(_root, ".metaobjects"));
        File.WriteAllText(Path.Combine(_root, ".metaobjects", DependencyFiles.LockFile), json);
    }

    // ---- explicitlyIncludes ------------------------------------------------------------------

    [Theory]
    [InlineData("acme::common::**", "acme::common", true)]
    [InlineData("acme::common::Address", "acme::common", true)]
    [InlineData("acme::**", "acme::common", false)]
    [InlineData("**", "acme::common", false)]
    [InlineData("acme::*::Address", "acme::common", false)]
    [InlineData("acme::common::**", "acme::other", false)]
    [InlineData("acme::common::**", "", false)]
    public void ExplicitlyIncludes_requires_the_package_to_be_named_literally(string pattern, string pkg, bool expected) =>
        Assert.Equal(expected, DependencyResolver.ExplicitlyIncludes([pattern], pkg));

    [Fact]
    public void ExplicitlyIncludes_names_nothing_for_an_absent_or_empty_list()
    {
        Assert.False(DependencyResolver.ExplicitlyIncludes(null, "acme::common"));
        Assert.False(DependencyResolver.ExplicitlyIncludes([], "acme::common"));
    }

    // ---- the config's dependency shape -------------------------------------------------------

    private void AssertConfigRefused(string dependenciesJson)
    {
        WriteConfig($$"""{ "schema_version": 1, "dependencies": {{dependenciesJson}} }""");
        var ex = Assert.Throws<MetaModelException>(() => NeutralConfig.Read(_root));
        Assert.Equal(ErrorCode.ERR_BAD_ATTR_VALUE, ex.Code);
    }

    [Fact]
    public void A_valid_dependency_is_read_with_its_transport()
    {
        WriteConfig("""
        { "schema_version": 1, "dependencies": [
          { "name": "a", "path": "../a/metaobjects" },
          { "name": "b.c-d", "npm": "@acme/common", "dir": "metaobjects" } ] }
        """);
        var cfg = NeutralConfig.Read(_root)!;
        Assert.Equal([new DependencySpec("a", "path", "../a/metaobjects", null),
                      new DependencySpec("b.c-d", "npm", "@acme/common", "metaobjects")], cfg.Dependencies);
    }

    [Theory]
    [InlineData("""[{ "name": "Bad", "path": "x" }]""")]                                        // uppercase name
    [InlineData("""[{ "name": "a" }]""")]                                                        // no transport
    [InlineData("""[{ "name": "a", "path": "x", "npm": "y" }]""")]                               // two transports
    [InlineData("""[{ "name": "a", "path": "x", "dir": "d" }]""")]                               // dir beside path
    [InlineData("""[{ "name": "a", "path": "x", "mode": "snapshot" }]""")]                       // removed key
    [InlineData("""[{ "name": "a", "path": "" }]""")]                                            // empty location
    [InlineData("""[{ "name": "a", "path": "x" }, { "name": "a", "python": "y" }]""")]           // duplicate name
    [InlineData("""{ "name": "a", "path": "x" }""")]                                             // not an array
    public void A_malformed_dependency_declaration_is_refused(string dependenciesJson) =>
        AssertConfigRefused(dependenciesJson);

    [Fact]
    public void Scope_and_migrate_scope_lists_are_read_and_other_keys_of_those_blocks_are_ignored()
    {
        WriteConfig("""
        { "schema_version": 1, "scope": { "include": ["app::**"], "exclude": ["app::Old"] },
          "migrate": { "scope": ["app::**"], "somethingTypeScriptOwns": 1 } }
        """);
        var cfg = NeutralConfig.Read(_root)!;
        Assert.Equal(["app::**"], cfg.ScopeInclude);
        Assert.Equal(["app::**"], cfg.MigrateScope);
    }

    [Fact]
    public void Absent_scope_lists_read_as_empty_and_null()
    {
        WriteConfig("""{ "schema_version": 1, "scope": null }""");
        var cfg = NeutralConfig.Read(_root)!;
        Assert.Empty(cfg.ScopeInclude);
        Assert.Null(cfg.MigrateScope);
    }

    // ---- the lock ---------------------------------------------------------------------------

    private const string Hash = "sha256-10fbf886e22faceca32c56e5e647c3ff1c82f503e638cba3bd3aa9390f7c409d";

    private static string Lock(string entryExtras = "", string resolvedFrom = """{ "path": "../a" }""",
        string packages = """["acme::common"]""") => $$"""
        { "schema_version": 1, "dependencies": { "a": {
          "version": "1.0.0", "metamodelVersion": "1.0", "artifact": "a.metaobjects.json",
          "integrity": "{{Hash}}", "packages": {{packages}}, "nodes": ["acme::common::X"],
          "resolvedFrom": {{resolvedFrom}} {{entryExtras}} } } }
        """;

    [Fact]
    public void A_well_formed_lock_is_read()
    {
        WriteLock(Lock());
        var entries = DependencyResolver.ReadLock(_root)!;
        Assert.Equal(["acme::common"], entries["a"].Packages);
        Assert.Equal(Hash, entries["a"].Integrity);
    }

    [Fact]
    public void No_lock_file_reads_as_null() => Assert.Null(DependencyResolver.ReadLock(_root));

    [Theory]
    [InlineData(""", "mode": "snapshot" """, """{ "path": "../a" }""", """["acme::common"]""")]       // removed key
    [InlineData("", """{ "path": "../a", "npm": "x" }""", """["acme::common"]""")]                      // two transports
    [InlineData("", """{ "path": "../a", "dir": "d" }""", """["acme::common"]""")]                      // dir beside path
    [InlineData("", """{ "path": "../a" }""", """["b::x", "a::y"]""")]                                  // unsorted packages
    public void A_malformed_lock_is_stale_never_trusted(string extras, string resolvedFrom, string packages)
    {
        WriteLock(Lock(extras, resolvedFrom, packages));
        var ex = Assert.Throws<MetaModelException>(() => DependencyResolver.ReadLock(_root));
        Assert.Equal(ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE, ex.Code);
    }

    [Fact]
    public void Unparseable_lock_json_is_stale()
    {
        WriteLock("{ not json");
        var ex = Assert.Throws<MetaModelException>(() => DependencyResolver.ReadLock(_root));
        Assert.Equal(ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE, ex.Code);
    }

    [Fact]
    public void Every_stale_refusal_names_the_command_that_fixes_it()
    {
        WriteConfig("""{ "schema_version": 1, "dependencies": [{ "name": "a", "path": "x" }] }""");
        var ex = Assert.Throws<MetaModelException>(() => MetadataLocation.Resolve(null, _root));
        Assert.Equal(ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE, ex.Code);
        Assert.EndsWith("; run `meta deps sync`", ex.Message);
    }
}
