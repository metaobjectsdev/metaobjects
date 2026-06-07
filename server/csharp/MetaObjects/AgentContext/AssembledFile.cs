// AssembledFile — a (path, contents) pair the assembler emits, path relative to
// the consumer project root.

namespace MetaObjects.AgentContext;

/// <summary>A file the assembler emits, <c>Path</c> relative to the consumer project root.</summary>
/// <param name="Path">Consumer-relative output path (forward-slash separated).</param>
/// <param name="Contents">The exact file contents (byte-faithful UTF-8 string).</param>
public sealed record AssembledFile(string Path, string Contents);
