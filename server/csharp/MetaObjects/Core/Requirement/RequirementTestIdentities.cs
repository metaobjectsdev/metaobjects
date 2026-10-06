// RequirementTestIdentities — which tests a requirement ledger yields, what each is called,
// whether it is skipped, and a fingerprint of the claim it tests (ADR-0057).
//
// Everything here is what every language port agrees on and the shared
// fixtures/requirement-test-identity-conformance/ corpus pins; how a test is WRITTEN is the
// generator's business and differs per port.
//
// Ported 1:1 from `requirementTestIdentities` and its helpers in the TypeScript reference,
// server/typescript/packages/codegen-ts/src/requirement-walk.ts (the Java port is
// com.metaobjects.requirement.RequirementTestIdentities). It lives here, in the core library
// beside the walk and the claim resolver, rather than in the generator, because an application
// that owns its generator (`dotnet meta eject requirement-tests`) still uses it from the
// package: an owned copy changes how a test is written and keeps agreeing with every other tool
// about which tests exist.

using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using MetaObjects.Meta;

namespace MetaObjects.Core.Requirement;

/// <summary>
/// The fan-out unit: what one generated test stands for.
/// <see cref="Concern"/> (the default): one test per distinct <c>&lt;type&gt;.&lt;subType&gt;</c> a
/// requirement claims. <see cref="Member"/>: one test per distinct <c>implementedBy</c> reference
/// that resolves, spelt exactly as authored.
/// </summary>
public enum RequirementTestGrain
{
    Concern,
    Member,
}

/// <summary>The spelling a grain has outside code, and the refusal of anything that is not one.</summary>
public static class RequirementTestGrains
{
    /// <summary>
    /// Refuse anything that is not a grain. A grain that arrives as text (an option file, a
    /// config) would otherwise be picked by accident, and not even one grain: each place that
    /// branches on it would fall to its own default.
    /// </summary>
    /// <exception cref="ArgumentException">for any value other than <c>concern</c> or <c>member</c>.</exception>
    public static RequirementTestGrain Parse(string? value) => value switch
    {
        "concern" => RequirementTestGrain.Concern,
        "member" => RequirementTestGrain.Member,
        _ => throw new ArgumentException(Refusal(value is null ? "null" : $"\"{value}\"")),
    };

    /// <summary>
    /// Refuse an enum value that names no grain: <c>(RequirementTestGrain)5</c> is a legal
    /// C# value, and the branch that tests for <see cref="RequirementTestGrain.Member"/> would
    /// run it as a hybrid of the two.
    /// </summary>
    /// <exception cref="ArgumentException">when <paramref name="grain"/> is not a defined member.</exception>
    public static void Require(RequirementTestGrain grain)
    {
        if (!Enum.IsDefined(grain))
            throw new ArgumentException(Refusal(((int)grain).ToString(CultureInfo.InvariantCulture)));
    }

    private static string Refusal(string shown) =>
        $"unknown requirement-test grain {shown}: expected \"concern\" or \"member\".";
}

/// <summary>
/// What a filter receives; never the node. <see cref="Level"/> is <c>null</c> on a requirement that
/// declares none (an unlevelled architectural requirement), which is not a number: a requirement
/// declared at level 0 or -1 has that level. <see cref="Package"/> is the EFFECTIVE package.
/// </summary>
public sealed record RequirementView(
    string SubType,
    int? Level,
    string? Status,
    string Path,
    string Package,
    IReadOnlyList<string> ImplementedByTypes);

/// <summary>A predicate over the requirement view: which requirements get a test. It REPLACES the default.</summary>
public interface IRequirementTestFilter
{
    bool Include(RequirementView view);
}

/// <summary>One generated test. The same record in every language port.</summary>
/// <param name="Package">The requirement's effective package.</param>
/// <param name="Path">The requirement's dotted path, without the package.</param>
/// <param name="Unit"><c>&lt;type&gt;.&lt;subType&gt;</c> under the concern grain, the reference as authored under the member grain, and <c>*</c> for a requirement that resolves no target.</param>
/// <param name="Id"><c>&lt;qualified address&gt; [&lt;unit&gt;]</c>, unique per test.</param>
/// <param name="WitnessKey">An identifier-safe spelling of <paramref name="Id"/>.</param>
/// <param name="Status">The requirement's status.</param>
/// <param name="Skip">Why the test is skipped, or <c>null</c> when the requirement claims the capability works right now.</param>
/// <param name="Digest">The requirement digest, the same for each test of one requirement.</param>
public sealed record RequirementTestIdentity(
    string Package,
    string Path,
    string Unit,
    string Id,
    string WitnessKey,
    string? Status,
    string? Skip,
    string Digest);

/// <summary>A resolved <c>implementedBy</c> reference: as authored, the node it names, and its concern.</summary>
public sealed record ResolvedClaim(string Ref, MetaData Node, string Concern);

/// <summary>One requirement, projected for a filter, with the targets its references resolved to.</summary>
public sealed record WalkedRequirement(MetaRequirement Node, RequirementView View, IReadOnlyList<ResolvedClaim> Targets);

/// <summary>One fan-out unit of a requirement: the unit's name and the targets it stands for.</summary>
public sealed record RequirementTestUnit(string Unit, IReadOnlyList<ResolvedClaim> Targets);

/// <summary>One test: the requirement it belongs to, its unit with that unit's targets, and its identity.</summary>
public sealed record RequirementTestPlan(WalkedRequirement Requirement, RequirementTestUnit Unit, RequirementTestIdentity Identity);

/// <summary>
/// What a grain and a filter select: how many requirements the model holds, the tests in id order, and the
/// paths of the requirements the filter excluded.
/// </summary>
public sealed record RequirementTestSelection(
    int RequirementCount,
    IReadOnlyList<RequirementTestPlan> Tests,
    IReadOnlyList<string> ExcludedPaths);

/// <summary>The identity function: walk, units, identity, digest, witness key.</summary>
public static class RequirementTestIdentities
{
    /// <summary>The unit a test stands for when the requirement resolves no target.</summary>
    public const string NoUnit = "*";

    private const string DigestVersion = "requirement-digest/v1";

    /// <summary><c>&lt;type&gt;.&lt;subType&gt;</c>: the key a renderer or a filter reasons about.</summary>
    public static string ConcernOf(MetaData node) => $"{node.Type}.{node.SubType}";

    /// <summary>
    /// RECOMMENDATION, not a rule: functional requirements at or below the link floor.
    /// Architectural requirements are excluded by default because <c>verify</c>'s universality
    /// check already proves them structurally. It is overridable.
    /// </summary>
    public static bool DefaultFilter(RequirementView view) =>
        view.SubType == RequirementConstants.REQUIREMENT_SUBTYPE_FUNCTIONAL
        && (view.Level ?? 0) >= RequirementConstants.REQUIREMENT_LINK_FLOOR_LEVEL;

    // -- the walk ---------------------------------------------------------------------------

    /// <summary>
    /// Every requirement in walk order with its view and resolved targets. An
    /// <c>implementedBy</c> reference that does not resolve is skipped rather than reported: its
    /// severity depends on <c>@status</c> and belongs to <c>verify</c>, and codegen must not
    /// fail a build over a diagnostic another command owns.
    /// </summary>
    public static IReadOnlyList<WalkedRequirement> Walk(MetaData root)
    {
        var output = new List<WalkedRequirement>();
        foreach (var addressed in RequirementCheck.CollectAddressed(root))
        {
            var node = addressed.Node;
            // One effective package, shared with the gate.
            var package = RequirementCheck.EffectivePackage(node);
            var targets = new List<ResolvedClaim>();
            foreach (var reference in node.ImplementedBy)
            {
                var target = RequirementClaims.ResolveClaim(root, reference, package);
                if (target is not null) targets.Add(new ResolvedClaim(reference, target, ConcernOf(target)));
            }
            var concerns = targets.Select(t => t.Concern).Distinct(StringComparer.Ordinal).ToList();
            output.Add(new WalkedRequirement(
                node,
                new RequirementView(node.SubType, node.Level, node.Status, addressed.Path, package, concerns),
                targets));
        }
        return output;
    }

    /// <summary>
    /// A requirement's targets grouped by fan-out unit under <paramref name="grain"/>, one entry
    /// per test, in first-seen order. Under the member grain a reference authored twice is one
    /// test and the bare and qualified spellings of one node are two: the unit is the reference
    /// as written. In both grains a requirement resolving NO target still yields exactly one
    /// entry, with unit <see cref="NoUnit"/>: the link floor forbids <c>implementedBy</c> below L4,
    /// so every L1 to L3 requirement resolves nothing, and an application that chooses to cover
    /// one would otherwise get silence.
    /// </summary>
    public static IReadOnlyList<RequirementTestUnit> Units(WalkedRequirement walked, RequirementTestGrain grain)
    {
        RequirementTestGrains.Require(grain);
        var order = new List<string>();
        var byUnit = new Dictionary<string, List<ResolvedClaim>>(StringComparer.Ordinal);
        foreach (var target in walked.Targets)
        {
            var key = grain == RequirementTestGrain.Member ? target.Ref : target.Concern;
            if (!byUnit.TryGetValue(key, out var group))
            {
                byUnit[key] = group = [];
                order.Add(key);
                group.Add(target);
            }
            else if (grain == RequirementTestGrain.Concern)
            {
                group.Add(target);
            }
        }
        if (order.Count == 0) return [new RequirementTestUnit(NoUnit, [])];
        return order.Select(key => new RequirementTestUnit(key, byUnit[key])).ToList();
    }

    /// <summary>The qualified address: <c>&lt;package&gt;::&lt;path&gt;</c>, or the bare path when the package is empty.</summary>
    public static string AddressOf(string package, string path) =>
        package.Length == 0 ? path : package + PACKAGE_SEPARATOR + path;

    /// <summary>The identity of the one test <paramref name="unit"/> stands for (a unit of <see cref="Units"/>).</summary>
    public static RequirementTestIdentity IdentityOf(WalkedRequirement walked, string unit)
    {
        var view = walked.View;
        var address = AddressOf(view.Package, view.Path);
        // Derived from the loader's status list rather than naming the two skipped statuses:
        // a status that does not claim the capability works right now is skipped by
        // construction, so a status added later cannot be left failing by omission.
        var skips = view.Status is not null
            && !RequirementConstants.REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES.Contains(view.Status);
        return new RequirementTestIdentity(
            view.Package,
            view.Path,
            unit,
            $"{address} [{unit}]",
            WitnessKeyOf(address, unit),
            view.Status,
            skips ? view.Status : null,
            Digest(walked.Node));
    }

    /// <summary>
    /// Every test the generator would emit, sorted by id (UTF-16 code units, never a culture
    /// collation: this order is pinned by a corpus every port runs).
    /// </summary>
    /// <param name="grain"><c>null</c> means <see cref="RequirementTestGrain.Concern"/>.</param>
    /// <param name="filter"><c>null</c> means <see cref="DefaultFilter"/>; a filter REPLACES the default.</param>
    public static IReadOnlyList<RequirementTestIdentity> Identities(
        MetaData root, RequirementTestGrain? grain = null, IRequirementTestFilter? filter = null) =>
        Select(root, grain, filter).Tests.Select(t => t.Identity).ToList();

    /// <summary>
    /// The one selection both <see cref="Identities"/> (which the corpus pins) and a generator use: every test
    /// the grain and the filter yield, each with its requirement and the targets of its unit, sorted by id, and
    /// the paths of the requirements the filter excluded. A generator that selected for itself could disagree
    /// with the function the corpus pins.
    /// </summary>
    /// <param name="grain"><c>null</c> means <see cref="RequirementTestGrain.Concern"/>.</param>
    /// <param name="filter"><c>null</c> means <see cref="DefaultFilter"/>; a filter REPLACES the default.</param>
    public static RequirementTestSelection Select(
        MetaData root, RequirementTestGrain? grain = null, IRequirementTestFilter? filter = null)
    {
        // Checked here as well as per requirement, so a bad grain is refused even over a ledger
        // the filter empties: the answer must not depend on what the model holds.
        var g = grain ?? RequirementTestGrain.Concern;
        RequirementTestGrains.Require(g);
        var walked = Walk(root);
        var tests = new List<RequirementTestPlan>();
        var excluded = new List<string>();
        foreach (var requirement in walked)
        {
            var keep = filter is null ? DefaultFilter(requirement.View) : filter.Include(requirement.View);
            if (!keep)
            {
                // The PATH, not the qualified address: diagnostics name paths, in every port.
                excluded.Add(requirement.View.Path);
                continue;
            }
            foreach (var unit in Units(requirement, g))
                tests.Add(new RequirementTestPlan(requirement, unit, IdentityOf(requirement, unit.Unit)));
        }
        // A stable sort: two tests with one id (a collision the caller refuses) keep their walk order.
        var sorted = tests.OrderBy(t => t.Identity.Id, StringComparer.Ordinal).ToList();
        return new RequirementTestSelection(walked.Count, sorted, excluded);
    }

    // -- witness key ------------------------------------------------------------------------

    // ASCII [A-Za-z0-9] and nothing else: `_` is outside the class, so `Orders__Recorded` mangles
    // to `Orders_Recorded`. char.IsLetterOrDigit and Regex's \w both keep accented letters (and
    // \w keeps the underscore), and are wrong here.
    private static readonly Regex NotAsciiAlphanumeric = new("[^A-Za-z0-9]+", RegexOptions.CultureInvariant);

    /// <summary>
    /// Every maximal run of characters outside ASCII <c>[A-Za-z0-9]</c> becomes one <c>_</c>. Public so a
    /// generator derives a file name from a package by the one rule the witness keys follow.
    /// </summary>
    public static string Mangle(string s) => NotAsciiAlphanumeric.Replace(s, "_");

    /// <summary>
    /// An identifier-safe key for one test: <c>req_&lt;address&gt;</c>, then <c>__&lt;unit&gt;</c> unless the
    /// requirement resolves no target. Mangling is lossy (<c>Orders.Recorded</c> and
    /// <c>Orders_Recorded</c> give one key), which is what <see cref="WitnessKeyCollisions"/> reports.
    /// </summary>
    public static string WitnessKeyOf(string qualifiedAddress, string unit)
    {
        var baseKey = "req_" + Mangle(qualifiedAddress);
        return unit == NoUnit ? baseKey : baseKey + "__" + Mangle(unit);
    }

    /// <summary>Pairs of ids that share a witness key, each pair and the list sorted.</summary>
    public static IReadOnlyList<(string First, string Second)> WitnessKeyCollisions(IEnumerable<RequirementTestIdentity> tests)
    {
        var byKey = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var test in tests)
        {
            if (!byKey.TryGetValue(test.WitnessKey, out var ids)) byKey[test.WitnessKey] = ids = [];
            ids.Add(test.Id);
        }
        var pairs = new List<(string First, string Second)>();
        foreach (var ids in byKey.Values)
        {
            var sorted = ids.Order(StringComparer.Ordinal).ToList();
            for (var i = 0; i < sorted.Count; i++)
                for (var j = i + 1; j < sorted.Count; j++) pairs.Add((sorted[i], sorted[j]));
        }
        pairs.Sort((a, b) =>
        {
            var c = string.CompareOrdinal(a.First, b.First);
            return c != 0 ? c : string.CompareOrdinal(a.Second, b.Second);
        });
        return pairs;
    }

    // -- digest -----------------------------------------------------------------------------

    /// <summary><c>&lt;name&gt; &lt;byte length&gt;\n&lt;value&gt;\n</c>: length-prefixed, so no value can be confused with the field after it.</summary>
    private static string DigestField(string name, string value) =>
        string.Create(CultureInfo.InvariantCulture, $"{name} {Encoding.UTF8.GetByteCount(value)}\n{value}\n");

    /// <summary><c>\r\n</c> and a lone <c>\r</c> become <c>\n</c>; an absent value is empty.</summary>
    private static string Prose(string? value) =>
        value is null ? "" : value.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');

    /// <summary>
    /// <c>requirement-digest/v1</c>: lowercase hex SHA-256 of the requirement's subtype, level,
    /// status, statement, counterexample and <c>implementedBy</c> list. It answers "did the claim
    /// change", not "did the entry move": the name, the package, the title, the notes, the
    /// disposition, the tracking references and nested requirements are left out. Every value is the
    /// EFFECTIVE one (resolving accessors, ADR-0039), so a requirement inheriting its statement
    /// through <c>extends</c> hashes what it effectively says. The level is the decimal integer as
    /// authored (<see cref="MetaRequirement.RawLevel"/>, which does not saturate).
    /// </summary>
    public static string Digest(MetaRequirement node)
    {
        var refs = node.ImplementedBy;
        var text = new StringBuilder(DigestVersion).Append('\n')
            .Append(DigestField("subType", node.SubType))
            .Append(DigestField("level", node.RawLevel?.ToString(CultureInfo.InvariantCulture) ?? ""))
            .Append(DigestField("status", node.Status ?? ""))
            .Append(DigestField("statement", Prose(node.Attr(RequirementConstants.REQUIREMENT_ATTR_STATEMENT) as string)))
            .Append(DigestField("counterexample", Prose(node.Attr(RequirementConstants.REQUIREMENT_ATTR_COUNTEREXAMPLE) as string)))
            .Append(string.Create(CultureInfo.InvariantCulture, $"implementedBy {refs.Count}\n"));
        foreach (var reference in refs) text.Append(DigestField("ref", reference));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text.ToString()))).ToLowerInvariant();
    }
}
