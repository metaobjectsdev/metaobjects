using System;
using System.Linq;
using System.Text.RegularExpressions;

namespace MetaObjects.Codegen.TemplateCodegen;

/// <summary>
/// Expands the cross-port output-pattern grammar (SP-1 §3.3): <c>{name}</c>,
/// <c>{Name}</c> (PascalCase), <c>{package}</c> (<c>::</c> → <c>/</c>). An empty
/// <c>{package}</c> collapses its trailing/leading slash so <c>{package}/{name}</c>
/// with no package yields just <c>{name}</c>. Unknown placeholders throw.
/// Byte-equivalent to the TS <c>output-pattern.ts</c> and the JVM/Python ports.
/// </summary>
public static class OutputPattern
{
    private static readonly Regex Token = new(@"\{(\w+)\}", RegexOptions.Compiled);

    public static string Expand(string pattern, string? name, string? package)
    {
        var pkgEmpty = false;
        string Repl(Match m)
        {
            var token = m.Groups[1].Value;
            switch (token)
            {
                case "package":
                    var p = (package ?? "").Replace("::", "/");
                    if (p.Length == 0) pkgEmpty = true;
                    return p;
                case "name":
                    if (name is null)
                        throw new ArgumentException(
                            $"output pattern '{pattern}' uses {{name}} but no entity name is in scope");
                    return name;
                case "Name":
                    if (name is null)
                        throw new ArgumentException(
                            $"output pattern '{pattern}' uses {{Name}} but no entity name is in scope");
                    return Pascal(name);
                default:
                    throw new ArgumentException(
                        $"unknown placeholder {{{token}}} in output pattern '{pattern}'");
            }
        }

        var outStr = Token.Replace(pattern, Repl);
        if (pkgEmpty)
        {
            outStr = Regex.Replace(outStr, "^/+", "");
            outStr = Regex.Replace(outStr, "/{2,}", "/");
        }
        return outStr;
    }

    private static string Pascal(string s) =>
        string.Concat(Regex.Split(s, "[^A-Za-z0-9]+")
            .Where(w => w.Length > 0)
            .Select(w => char.ToUpperInvariant(w[0]) + w[1..]));
}
