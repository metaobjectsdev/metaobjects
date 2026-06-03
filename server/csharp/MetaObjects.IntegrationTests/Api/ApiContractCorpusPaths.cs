// ApiContractCorpusPaths — locate the api-contract-conformance corpus directory
// relative to the test assembly. Mirrors the Java runner's findCorpusRoot()
// walk so the fixture path resolves identically across ports.

namespace MetaObjects.IntegrationTests.Api;

internal static class ApiContractCorpusPaths
{
    // Test assemblies run from bin/Debug/net8.0; the corpus lives 6 levels up
    // at the repo root. AppContext.BaseDirectory points at the bin dir.
    public static readonly string Repo = Path.GetFullPath(
        Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", ".."));

    public static readonly string Corpus = Path.Combine(Repo, "fixtures", "api-contract-conformance");
    public static readonly string ScenariosDir = Path.Combine(Corpus, "scenarios");
    public static readonly string SeedFile = Path.Combine(Corpus, "seed.json");

    // The corpus Author model — fed to the C# generators in the SP-F generated-server
    // lane (GeneratedAuthorServerFactory) to produce + host the real routes/AppDbContext.
    public static readonly string MetaJson = Path.Combine(Corpus, "meta.json");

    // FR-018 M:N traversal corpus — a separate 6-entity model (Post/Tag/PostTag +
    // Person/Follow/Friendship) with its own seed + scenarios under m2m/.
    public static readonly string M2mDir = Path.Combine(Corpus, "m2m");
    public static readonly string M2mScenariosDir = Path.Combine(M2mDir, "scenarios");
    public static readonly string M2mSeedFile = Path.Combine(M2mDir, "seed.json");
    public static readonly string M2mMetaJson = Path.Combine(M2mDir, "meta.json");
}
