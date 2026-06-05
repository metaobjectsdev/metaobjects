package com.metaobjects.agentcontext;

/**
 * A file the assembler emits, {@code path} relative to the consumer project root.
 *
 * @param path     consumer-relative output path (forward-slash separated).
 * @param contents the file contents (UTF-8 string; byte-identical to the reference).
 */
public record AssembledFile(String path, String contents) {
}
