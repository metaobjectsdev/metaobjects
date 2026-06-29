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

    // FR-017 TPH polymorphic-CRUD corpus — a discriminator base (Auth) + concrete
    // subtypes (Bridge/Copay/PriorAuth) sharing one `auths` table, under tph/.
    public static readonly string TphDir = Path.Combine(Corpus, "tph");
    public static readonly string TphScenariosDir = Path.Combine(TphDir, "scenarios");
    public static readonly string TphSeedFile = Path.Combine(TphDir, "seed.json");
    public static readonly string TphMetaJson = Path.Combine(TphDir, "meta.json");

    // #98 jsonb open-bag corpus — a single Document entity with one
    // `field.string @dbColumnType:jsonb` open-JSON column, under jsonb/. The
    // contract: a posted JSON OBJECT round-trips as an OBJECT (not a stringified
    // `"{\"k\":\"v\"}"`).
    public static readonly string JsonbDir = Path.Combine(Corpus, "jsonb");
    public static readonly string JsonbScenariosDir = Path.Combine(JsonbDir, "scenarios");
    public static readonly string JsonbSeedFile = Path.Combine(JsonbDir, "seed.json");
    public static readonly string JsonbMetaJson = Path.Combine(JsonbDir, "meta.json");
}
