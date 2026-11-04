// `csharp.providers` — loads project-supplied IMetaDataTypeProvider classes for the dev tools.
//
// This is dev-tool PLUGIN loading (`dotnet meta`, an ejected codegen/ runner), the C# counterpart
// of Python's `module:symbol` config providers. It is NOT runtime type binding: ADR-0001 forbids
// reflection for binding metadata to native types in GENERATED code, and nothing here touches that.

using System.Reflection;
using System.Runtime.Loader;

namespace MetaObjects.Config;

/// <summary>One <c>csharp.providers</c> entry: an assembly path (absolute) and a full type name.</summary>
public sealed record ProviderSpec(string AssemblyPath, string TypeName, string ConfigPath);

public static class ProviderLoader
{
    /// <summary>The providers a metadata load composes: the core library set, then the project's own.</summary>
    public static IReadOnlyList<IMetaDataTypeProvider> Compose(IReadOnlyList<IMetaDataTypeProvider>? extra)
        => extra is { Count: > 0 } ? [.. CoreTypes.LibraryProviders, .. extra] : CoreTypes.LibraryProviders;

    /// <summary>Instantiate every spec. Throws <see cref="MetaModelException"/> (ERR_BAD_ATTR_VALUE) naming the config key.</summary>
    public static IReadOnlyList<IMetaDataTypeProvider> Load(IReadOnlyList<ProviderSpec> specs)
    {
        var result = new List<IMetaDataTypeProvider>(specs.Count);
        foreach (var spec in specs) result.Add(LoadOne(spec));
        return result;
    }

    private static MetaModelException Refuse(ProviderSpec s, string why) =>
        new($"{s.ConfigPath}: \"csharp.providers\" entry (assembly \"{s.AssemblyPath}\", type \"{s.TypeName}\"): {why}",
            ErrorCode.ERR_BAD_ATTR_VALUE);

    private static IMetaDataTypeProvider LoadOne(ProviderSpec spec)
    {
        if (!File.Exists(spec.AssemblyPath))
            throw Refuse(spec, $"the assembly file does not exist at {spec.AssemblyPath}. Build the vocabulary project first " +
                               "(for example `dotnet build <project>`), then re-run.");

        var assembly = LoadAssembly(spec);
        var type = assembly.GetType(spec.TypeName, throwOnError: false);
        if (type is null)
            throw Refuse(spec, $"type \"{spec.TypeName}\" was not found in the assembly (use the full, namespace-qualified name).");
        if (!typeof(IMetaDataTypeProvider).IsAssignableFrom(type) || type.IsAbstract || type.IsInterface)
            throw Refuse(spec, $"type \"{spec.TypeName}\" is not a concrete class implementing IMetaDataTypeProvider.");
        if (type.GetConstructor(Type.EmptyTypes) is null)
            throw Refuse(spec, $"type \"{spec.TypeName}\" has no public parameterless constructor.");
        try
        {
            return (IMetaDataTypeProvider)Activator.CreateInstance(type)!;
        }
        catch (TargetInvocationException ex)
        {
            throw Refuse(spec, $"its constructor threw {ex.InnerException?.GetType().Name}: {ex.InnerException?.Message}");
        }
    }

    private static readonly HashSet<string> HookedPaths = new(StringComparer.Ordinal);
    private static readonly object Gate = new();

    private static Assembly LoadAssembly(ProviderSpec spec)
    {
        var name = AssemblyName.GetAssemblyName(spec.AssemblyPath);
        // Reuse an assembly of the same simple name already in the process (the codegen project may
        // reference the vocabulary project directly), so type identity is not split.
        var loaded = AppDomain.CurrentDomain.GetAssemblies()
            .FirstOrDefault(a => string.Equals(a.GetName().Name, name.Name, StringComparison.Ordinal));
        if (loaded is not null) return loaded;

        var resolver = new AssemblyDependencyResolver(spec.AssemblyPath);
        var dir = Path.GetDirectoryName(spec.AssemblyPath)!;
        lock (Gate)
        {
            if (HookedPaths.Add(spec.AssemblyPath))
            {
                AssemblyLoadContext.Default.Resolving += (ctx, requested) =>
                {
                    // MetaObjects itself is already bound in the default context; the Default context
                    // only raises Resolving for assemblies it could not find, so this never shadows it.
                    var path = resolver.ResolveAssemblyToPath(requested);
                    if (path is null)
                    {
                        var sibling = Path.Combine(dir, requested.Name + ".dll");
                        if (File.Exists(sibling)) path = sibling;
                    }
                    return path is null ? null : ctx.LoadFromAssemblyPath(path);
                };
            }
        }
        return AssemblyLoadContext.Default.LoadFromAssemblyPath(spec.AssemblyPath);
    }
}
