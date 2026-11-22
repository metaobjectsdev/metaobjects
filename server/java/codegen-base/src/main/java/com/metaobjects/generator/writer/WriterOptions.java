package com.metaobjects.generator.writer;

/**
 * What a writer is configured with (spec/code-writer.md, "Options"). A dialect supplies the
 * defaults for its language; a shared {@code core} case states all three.
 *
 * @param indent one level of indentation
 * @param width the last column a line may reach before its last list breaks
 * @param trailingComma whether a broken list puts a comma after its last item too
 */
public record WriterOptions(String indent, int width, boolean trailingComma) {

  /** Four spaces, 120 columns, no trailing comma: what Java allows in an argument list. */
  public static final WriterOptions JAVA = new WriterOptions("    ", 120, false);

  /**
   * Two spaces: the indentation unit the older direct writers ({@code FileDirectWriter} and the
   * PlantUML writer under it) default to.
   */
  public static final WriterOptions DIRECT = JAVA.withIndent("  ");

  public WriterOptions withIndent(String indent) {
    return new WriterOptions(indent, width, trailingComma);
  }

  public WriterOptions withWidth(int width) {
    return new WriterOptions(indent, width, trailingComma);
  }

  public WriterOptions withTrailingComma(boolean trailingComma) {
    return new WriterOptions(indent, width, trailingComma);
  }
}
