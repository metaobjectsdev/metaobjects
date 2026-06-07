// AgentContextAssembler — the pure agent-context assembler.
//
// Port of server/typescript/packages/sdk/src/agent-context/assemble.ts (and the
// Java AgentContextAssembler / Python metaobjects.agent_context.assemble). Given the
// content tree and a resolved Stack, produce the (path, contents) files the consumer
// project receives — BYTE-IDENTICAL to the TS/Java/Python references.
//
// BYTE-IDENTITY (the .NET footguns):
//   - Read bytes and decode UTF-8 WITHOUT a BOM, with NO newline translation — the
//     source files are LF; keep them LF. We read raw bytes + Encoding.UTF8.GetString
//     so nothing rewrites newlines or strips/adds a trailing newline.
//   - Sort output by Path with StringComparer.Ordinal — matches the JS/Java/Python
//     codepoint ordering, NOT a culture-aware comparison.
//   - Every file but the two always-on documents is a VERBATIM byte-copy; only the
//     two always-on template substitutions are computed.

using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MetaObjects.AgentContext;

/// <summary>The pure agent-context assembler — byte-identical to the TS/Java/Python references.</summary>
public static partial class AgentContextAssembler
{
    /// <summary><c>{{key}}</c> template-variable pattern (word chars only, matching the TS regex).</summary>
    [GeneratedRegex(@"\{\{(\w+)\}\}")]
    private static partial Regex TemplateVar();

    /// <summary>
    /// Assemble the consumer files for a resolved stack. Pure given the content tree.
    /// Output is sorted by path ascending (ordinal) — the stable order the conformance
    /// gate and the TS/Java/Python references all produce.
    /// </summary>
    /// <param name="contentRoot">The repo-root <c>agent-context/</c> content tree.</param>
    /// <param name="stack">The resolved consumer stack.</param>
    /// <returns>The (Path, Contents) files, sorted by Path ascending (ordinal).</returns>
    public static IReadOnlyList<AssembledFile> Assemble(string contentRoot, Stack stack)
    {
        var output = new List<AssembledFile>();

        // 1. Always-on (AGENTS.md + CLAUDE.md, identical contents).
        var tpl = ReadText(Path.Combine(contentRoot, "templates", "always-on.md.mustache"));
        var (line, codegenCommand) = StackLine(contentRoot, stack);
        var alwaysOn = ApplyTemplate(tpl, new Dictionary<string, string>
        {
            ["stackLine"] = line,
            ["codegenCommand"] = codegenCommand,
        });
        output.Add(new AssembledFile(".metaobjects/AGENTS.md", alwaysOn));
        output.Add(new AssembledFile(".metaobjects/CLAUDE.md", alwaysOn));

        // 2. Skills: body + only the references whose token is in the stack.
        foreach (var skill in Stack.SkillNames)
        {
            var skillDir = Path.Combine(contentRoot, "skills", skill);
            var body = ReadText(Path.Combine(skillDir, "SKILL.md"));
            output.Add(new AssembledFile($".claude/skills/{skill}/SKILL.md", body));

            var refDir = Path.Combine(skillDir, "references");
            if (Directory.Exists(refDir))
            {
                // Tokens (filename-without-".md") in the stack, sorted ascending (ordinal).
                var tokens = Directory.EnumerateFiles(refDir)
                    .Select(Path.GetFileName)
                    .Where(n => n is not null && n.EndsWith(".md", StringComparison.Ordinal))
                    .Select(n => n![..^".md".Length])
                    .Where(stack.Tokens.Contains)
                    .OrderBy(t => t, StringComparer.Ordinal)
                    .ToArray();
                foreach (var token in tokens)
                {
                    output.Add(new AssembledFile(
                        $".claude/skills/{skill}/references/{token}.md",
                        ReadText(Path.Combine(refDir, $"{token}.md"))));
                }
            }
        }

        // Stable order: by path (ordinal codepoint ordering, matching TS/Java/Python).
        output.Sort((a, b) => string.CompareOrdinal(a.Path, b.Path));
        return output;
    }

    /// <summary>Read a file as UTF-8 with NO BOM and NO newline translation (byte-faithful).</summary>
    private static string ReadText(string path) => Encoding.UTF8.GetString(File.ReadAllBytes(path));

    /// <summary>Load <c>servers/&lt;server&gt;.meta.json</c>, or <c>null</c> if absent.</summary>
    private static JsonElement? ReadServerMeta(string contentRoot, string server)
    {
        var p = Path.Combine(contentRoot, "servers", $"{server}.meta.json");
        if (!File.Exists(p)) return null;
        using var doc = JsonDocument.Parse(ReadText(p));
        return doc.RootElement.Clone();
    }

    /// <summary>
    /// Compute (stackLine, codegenCommand) for the always-on template. <c>codegenCommand</c>
    /// is the FIRST server's <c>codegenCommand</c> (or <c>"meta gen"</c> if there is no
    /// primary server, or its meta file is absent).
    /// </summary>
    private static (string Line, string CodegenCommand) StackLine(string contentRoot, Stack stack)
    {
        var primary = stack.Servers.Count > 0 ? stack.Servers[0] : null;
        var meta = primary is not null ? ReadServerMeta(contentRoot, primary) : null;
        var serverPart = stack.Servers.Count > 0
            ? string.Join(", ", stack.Servers) + " server"
            : "no server";
        var clientPart = stack.Clients.Count > 0
            ? string.Join(", ", stack.Clients) + " client"
            : "no client";
        var line = $"Stack: {serverPart}, {clientPart}; migrations are TS.";
        var codegenCommand = meta is { } m
            ? m.GetProperty("codegenCommand").GetString()!
            : "meta gen";
        return (line, codegenCommand);
    }

    /// <summary>Replace every <c>{{key}}</c>; throw on an unknown key (matches TS/Java/Python).</summary>
    private static string ApplyTemplate(string tpl, IReadOnlyDictionary<string, string> variables) =>
        TemplateVar().Replace(tpl, match =>
        {
            var key = match.Groups[1].Value;
            if (!variables.TryGetValue(key, out var value))
                throw new ArgumentException($"agent-context: unknown template variable {{{{{key}}}}}");
            return value;
        });
}
