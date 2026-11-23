// `dotnet meta verify` — the overlay AUTHORING lint.
//
// A root-level declaration redeclared in a second file merges into the first whether or not the
// second carries `overlay: true`. Leaving the flag off is what turns a renamed or removed target
// into a silent second object instead of a loud ERR_OVERLAY_NO_TARGET, so every unflagged
// redeclaration after the first is reported. Warnings only: nothing here reaches an exit code.
//
// It reads the RAW FILES, never the merged model: the merged tree has already lost which file
// contributed which declaration.
//
// Mirrors the TS reference (server/typescript/packages/cli/src/lib/overlay-lint.ts and
// `declaredTopLevelKeys` in the TS loader). The code, the message text and the fixtures are
// shared: fixtures/model-lint-conformance/.

using MetaObjects.Loader;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Shared.Structural;

namespace MetaObjects.Cli;

/// <summary>The advisory overlay lint <c>dotnet meta verify</c> runs on every invocation.</summary>
public static class OverlayLint
{
    /// <summary>A root-level declaration redeclared in a second file without <c>overlay: true</c>.</summary>
    public const string WARN_OVERLAY_IMPLICIT = "WARN_OVERLAY_IMPLICIT";

    /// <summary>Opt-out environment variable, beside <c>--no-overlay-lint</c> (Node <c>meta</c> parity).</summary>
    public const string EnvOptOut = "META_NO_OVERLAY_LINT";

    private const string KeyName = "name";
    private const string KeyPackage = "package";
    private const string KeyChildren = "children";
    private const string KeyOverlay = "overlay";
    private const char TypeSubTypeSeparator = '.';

    /// <summary>One root-level declaration as the raw document states it.</summary>
    /// <param name="Type">The wrapper key's TYPE segment (<c>object</c> for <c>object.entity</c>).</param>
    /// <param name="Key">The resolution key the declaration would carry once parsed.</param>
    /// <param name="Overlay">Whether the body carries <c>overlay: true</c>.</param>
    public sealed record DeclaredTopLevelKey(string Type, string Key, bool Overlay);

    /// <summary>
    /// Structurally scan one document and report every declaration under <c>metadata.root.children</c>.
    /// A declaration with no non-empty string <c>name</c> is skipped; a malformed root shape returns an
    /// empty list; a syntax error throws, as the parser's would.
    /// </summary>
    public static List<DeclaredTopLevelKey> DeclaredTopLevelKeys(string content, MetaDataFormat format)
    {
        var declared = new List<DeclaredTopLevelKey>();
        var normalized = content.Length > 0 && content[0] == '\uFEFF' ? content[1..] : content;
        var parsed = format == MetaDataFormat.Yaml ? RawDocument.ParseYaml(normalized) : RawDocument.ParseJson(normalized);
        if (parsed is not List<KeyValuePair<string, object?>> document) return declared;
        // JSON fuses the subtype onto the root key; sigil-free YAML may write the bare type.
        var rootBody = RawDocument.Get(document, $"{TYPE_METADATA}{TypeSubTypeSeparator}{SUBTYPE_ROOT}") ?? RawDocument.Get(document, TYPE_METADATA);
        if (rootBody is not List<KeyValuePair<string, object?>> root) return declared;
        var rootPkg = RawDocument.Get(root, KeyPackage) as string ?? "";
        if (RawDocument.Get(root, KeyChildren) is not List<object?> children) return declared;

        foreach (var child in children)
        {
            if (child is not List<KeyValuePair<string, object?>> wrapper) continue;
            foreach (var (wrapperKey, bodyValue) in wrapper)
            {
                if (bodyValue is not List<KeyValuePair<string, object?>> body) continue;
                if (RawDocument.Get(body, KeyName) is not string { Length: > 0 } name) continue;
                var pkg = RawDocument.ResolvePackage(rootPkg, RawDocument.Get(body, KeyPackage) as string);
                var dot = wrapperKey.IndexOf(TypeSubTypeSeparator);
                declared.Add(new DeclaredTopLevelKey(
                    dot < 0 ? wrapperKey : wrapperKey[..dot],
                    pkg != "" ? $"{pkg}{PACKAGE_SEPARATOR}{name}" : name,
                    RawDocument.IsTrue(RawDocument.Get(body, KeyOverlay))));
            }
        }
        return declared;
    }

    /// <summary>
    /// Report every unflagged cross-file redeclaration after the first. <paramref name="sources"/> is
    /// the whole collection in LOAD ORDER, dependency artifacts first (they are the bases a project's own
    /// declarations amend), and each source's <see cref="IMetaDataSource.Id"/> is the name a finding
    /// prints. Declarations group by (type, resolution key), as the parser's merge lookup does.
    /// Unreadable or unparsable sources are skipped: the loader reports those itself.
    /// </summary>
    public static List<LintFinding> Lint(IEnumerable<IMetaDataSource> sources)
    {
        // Insertion-ordered, so findings come out in load order.
        var groups = new List<(string Type, string Key, List<(string File, bool Overlay)> Declarations)>();
        var index = new Dictionary<(string, string), int>();
        foreach (var source in sources)
        {
            List<DeclaredTopLevelKey> declared;
            try
            {
                declared = DeclaredTopLevelKeys(source.Read(), source.Format);
            }
            catch (Exception)
            {
                continue; // an advisory scan never breaks verify
            }
            foreach (var decl in declared)
            {
                if (!index.TryGetValue((decl.Type, decl.Key), out var i))
                {
                    index[(decl.Type, decl.Key)] = i = groups.Count;
                    groups.Add((decl.Type, decl.Key, []));
                }
                groups[i].Declarations.Add((source.Id, decl.Overlay));
            }
        }

        var findings = new List<LintFinding>();
        foreach (var (_, fqn, declarations) in groups)
        {
            if (declarations.Count < 2) continue;
            var baseSeen = false;
            foreach (var (file, overlay) in declarations)
            {
                if (overlay) continue;
                if (!baseSeen)
                {
                    baseSeen = true;
                    continue;
                }
                findings.Add(new LintFinding(
                    WARN_OVERLAY_IMPLICIT, "",
                    $"{fqn} is redeclared in {file} without overlay: true — add the flag so a removed or renamed " +
                    "target fails loudly (ERR_OVERLAY_NO_TARGET) instead of silently becoming a new object"));
            }
        }
        return findings;
    }
}
