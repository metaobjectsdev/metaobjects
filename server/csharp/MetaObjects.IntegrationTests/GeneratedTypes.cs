// rc.19 R65: a generated type's namespace is its metadata package, so a harness can no longer
// assume every generated type is in the namespace it configured — only the package-less artifacts
// (the context) are. A harness finds a generated type by its simple name instead: the type of that
// name in the configured namespace when there is one, else the one type of that name anywhere in
// the generated assembly (two would be ambiguous, and the lookup says so).

using System.Reflection;

namespace MetaObjects.IntegrationTests;

internal static class GeneratedTypes
{
    /// <summary>The generated type named <paramref name="qualified"/>'s last segment, preferring
    /// <paramref name="qualified"/> itself; null when the assembly declares none.</summary>
    public static Type? Find(Assembly assembly, string qualified)
    {
        if (assembly.GetType(qualified) is { } exact) return exact;
        var name = qualified[(qualified.LastIndexOf('.') + 1)..];
        // A nested type (`Ticket+TicketSolo`): find the outer type, then its member.
        if (name.IndexOf('+') is var plus and > 0)
            return Find(assembly, name[..plus])?.GetNestedType(name[(plus + 1)..], BindingFlags.Public | BindingFlags.NonPublic);
        var matches = assembly.GetTypes().Where(t => t.Name == name && !t.IsNested).ToList();
        return matches.Count switch
        {
            0 => null,
            1 => matches[0],
            _ => throw new InvalidOperationException(
                $"{matches.Count} generated types are named {name}: {string.Join(", ", matches.Select(t => t.FullName))}"),
        };
    }
}
