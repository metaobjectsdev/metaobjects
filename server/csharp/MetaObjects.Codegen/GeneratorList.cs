// The project's generator list with the settings that belong to the whole run (ADR-0034
// Amendment 9: a generator's inputs live in the list, not on a command line that scripts
// carry and a plain `dotnet meta gen` forgets). codegen/Generators.cs declares it:
//
//   public static IReadOnlyList<IGenerator> All { get; } = new GeneratorList
//   {
//       ColumnNaming = ColumnNamingStrategy.SnakeCase,
//       Entries =
//       [
//           new MetaObjects.Codegen.Generators.EntityGenerator(),
//       ],
//   };
//
// It IS an IReadOnlyList<IGenerator>, so codegen/Program.cs stays the two-line entry
// `return CodegenCli.Run(args, Generators.All);` and a plain collection keeps working.

using System.Collections;

namespace MetaObjects.Codegen;

/// <summary>
/// A generator list that also declares run-level settings. <see cref="CodegenCli.Run"/> reads
/// them from the list it is given, so <c>gen</c> and <c>verify --codegen</c> agree without a
/// flag on either command line.
/// </summary>
public sealed class GeneratorList : IReadOnlyList<IGenerator>
{
    /// <summary>The generators, in the order they run.</summary>
    public required IReadOnlyList<IGenerator> Entries { get; init; }

    /// <summary>
    /// How a field with no <c>@column</c> becomes a physical column name, for every generator
    /// in the run. It must match the database the generated code queries. <c>null</c> leaves it
    /// to <c>--column-naming</c>, else <see cref="ColumnNamingStrategy.Literal"/>. A
    /// <c>--column-naming</c> that names a different strategy is refused rather than
    /// silently winning or losing.
    /// </summary>
    public ColumnNamingStrategy? ColumnNaming { get; init; }

    /// <inheritdoc/>
    public IGenerator this[int index] => Entries[index];

    /// <inheritdoc/>
    public int Count => Entries.Count;

    /// <inheritdoc/>
    public IEnumerator<IGenerator> GetEnumerator() => Entries.GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}
