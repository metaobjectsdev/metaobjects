// Stack — the resolved tech-stack of a consumer project, the input to the
// agent-context assembler.
//
// Cross-port contract (must match the TS / Java / Python references exactly):
//   - Servers — deduped, in SERVER_LANGS order.
//   - Clients — deduped, in CLIENT_FRAMEWORKS order.
//   - Tokens  — Servers ∪ Clients ∪ {"migration"}, the install-selection set
//     used to choose which reference fragments to emit.
//
// Use Stack.Of(...) to build one: it dedupes + canonical-orders the inputs and
// derives the token set. The canonical orderings are the allow-list — unknown
// entries are dropped — so the result is exactly SERVER_LANGS / CLIENT_FRAMEWORKS
// filtered to the requested set (matching the TS/Java/Python makeStack).

namespace MetaObjects.AgentContext;

/// <summary>
/// The resolved tech-stack of a consumer project — input to the agent-context assembler.
/// </summary>
public sealed class Stack
{
    /// <summary>Server languages, in canonical dedupe order.</summary>
    public static readonly IReadOnlyList<string> ServerLangs =
        new[] { "typescript", "java", "kotlin", "csharp", "python" };

    /// <summary>Client frameworks, in canonical dedupe order.</summary>
    public static readonly IReadOnlyList<string> ClientFrameworks =
        new[] { "react", "tanstack", "angular" };

    /// <summary>Always-present token: schema migrations are TS-owned for every port (ADR-0015).</summary>
    public const string MigrationToken = "migration";

    /// <summary>The five skills, in the exact emit order (matches the TS/Java/Python references).</summary>
    public static readonly IReadOnlyList<string> SkillNames = new[]
    {
        "metaobjects-authoring",
        "metaobjects-codegen",
        "metaobjects-runtime-ui",
        "metaobjects-prompts",
        "metaobjects-verify",
    };

    /// <summary>Deduped servers, in <see cref="ServerLangs"/> order.</summary>
    public IReadOnlyList<string> Servers { get; }

    /// <summary>Deduped clients, in <see cref="ClientFrameworks"/> order.</summary>
    public IReadOnlyList<string> Clients { get; }

    /// <summary><c>servers ∪ clients ∪ {"migration"}</c> — the install-selection set.</summary>
    public IReadOnlySet<string> Tokens { get; }

    private Stack(IReadOnlyList<string> servers, IReadOnlyList<string> clients, IReadOnlySet<string> tokens)
    {
        Servers = servers;
        Clients = clients;
        Tokens = tokens;
    }

    /// <summary>
    /// Build a <see cref="Stack"/>: dedupe + canonical-order the inputs, derive tokens.
    /// Unknown entries are dropped (the canonical orderings are the allow-list).
    /// </summary>
    public static Stack Of(IEnumerable<string> servers, IEnumerable<string> clients)
    {
        var serverSet = new HashSet<string>(servers);
        var clientSet = new HashSet<string>(clients);
        var s = ServerLangs.Where(serverSet.Contains).ToArray();
        var c = ClientFrameworks.Where(clientSet.Contains).ToArray();
        var tokens = new HashSet<string>(s);
        foreach (var x in c) tokens.Add(x);
        tokens.Add(MigrationToken);
        return new Stack(s, c, tokens);
    }
}
