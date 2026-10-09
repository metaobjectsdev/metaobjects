// The renderer hook of the requirement-test generator (ADR-0057, Table I of the plan).
//
// These types stay in the package when a project ejects the generator: an owned copy of
// `RequirementTestsGenerator` and a project's own `IRequirementTestRenderer` both use them from
// here, like the walk, the claim resolver and the identity function in MetaObjects.Core.Requirement.
// The default rendering is NOT here: it is in Generators/RequirementTestsGenerator.cs, so one eject
// takes the generator and its renderer together.

using MetaObjects.Core.Requirement;

namespace MetaObjects.Codegen;

/// <summary>One resolved <c>implementedBy</c> reference: as authored, and the concern it resolved to.</summary>
/// <param name="Ref">The reference exactly as authored.</param>
/// <param name="Concern"><c>&lt;type&gt;.&lt;subType&gt;</c> of the node it names.</param>
public sealed record RequirementTestClaim(string Ref, string Concern);

/// <summary>
/// Everything a <see cref="IRequirementTestRenderer"/> is given about one test: its identity (the same
/// record in every language port), and the prose and claims the default rendering is built from. The
/// library supplies DATA; a renderer supplies SYNTAX.
/// </summary>
/// <param name="Identity">The test's identity: package, path, unit, id, witness key, status, skip reason (or null) and digest.</param>
/// <param name="Statement">What the capability is, or the empty string.</param>
/// <param name="Counterexample">What breaking it looks like, or the empty string.</param>
/// <param name="Targets">The claims this test covers, as authored plus the concern each resolved to.</param>
/// <param name="Disposition">What was decided about outstanding work, or null (undecided).</param>
/// <param name="TrackedBy">Issue references for outstanding work; empty when none.</param>
public sealed record RequirementTestArgs(
    RequirementTestIdentity Identity,
    string Statement,
    string Counterexample,
    IReadOnlyList<RequirementTestClaim> Targets,
    string? Disposition,
    IReadOnlyList<string> TrackedBy);

/// <summary>
/// What an <see cref="IRequirementTestRenderer"/> returns for one test: the C# source of that test and
/// the namespaces it needs.
/// </summary>
/// <param name="Usings">
/// Namespaces to import, each without <c>using</c> and the semicolon (<c>System.Linq</c>). Empty when
/// the source needs none beyond the <c>Xunit</c> the generated file always imports.
/// </param>
/// <param name="Source">
/// The whole member that replaces the default one: any comments, attributes and the method. The
/// generator indents every line and places it in the test class, where <c>witnesses</c> is the field
/// holding the project's witness class, typed as that package's generated witness interface. The
/// interface keeps a member for every non-skipped test whatever a renderer writes, so a renderer that
/// wants the project's witness calls <c>witnesses.&lt;WitnessKey&gt;()</c>.
/// </param>
public sealed record RenderedTest(IReadOnlyList<string> Usings, string Source);

/// <summary>
/// Replaces the default text of individual tests. Return <c>null</c> to keep the default rendering of
/// that one test.
/// </summary>
public interface IRequirementTestRenderer
{
    RenderedTest? Render(RequirementTestArgs args);
}
