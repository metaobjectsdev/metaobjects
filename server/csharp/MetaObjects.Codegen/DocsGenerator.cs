// The docs surface of the generator model.
//
// `dotnet meta gen` writes code; `dotnet meta docs` writes the api reference. Both are run
// from generators, but a docs generator must never be run by `gen`: it writes pages under the
// docs directory, not code under the generated-code directory, and `gen`'s hash manifest and
// overwrite policy are about code. A generator that takes part in the docs run says so by
// implementing IDocsGenerator; `gen` and `verify --codegen` skip it, and `gen` says so when its
// `--generators` selection named it.
//
// One list serves both commands. An owned `codegen/Program.cs` lists a docs generator beside the
// code generators, and each command runs the half that is its own.

namespace MetaObjects.Codegen;

/// <summary>A generator run by <c>dotnet meta docs</c>, not by <c>dotnet meta gen</c>. The paths
/// it emits are relative to the docs output directory.</summary>
public interface IDocsGenerator : IGenerator
{
}

/// <summary>
/// The facts of a docs run that the docs generator needs and a code run has no use for. They
/// ride on <see cref="GenContext.Docs"/> rather than on the generator's constructor so that an
/// owned copy of a docs generator, built by its owner with <c>new</c>, is handed them the same
/// way the packaged one is.
/// </summary>
/// <param name="Project">The label the agent page carries in its header.</param>
/// <param name="ModelBaseUrl">When set, the base URL the model pages' back-links federate to.</param>
/// <param name="ApiSubDir">Where under the docs output directory the api reference lands.</param>
public sealed record DocsRunFacts(string Project, string? ModelBaseUrl = null, string ApiSubDir = DocsRunFacts.DefaultApiSubDir)
{
    /// <summary>The api-surface subdirectory of the cross-port docs contract.</summary>
    public const string DefaultApiSubDir = "api/csharp";
}
