package com.metaobjects.generator.writer;

/**
 * An error the code writer throws (ADR-0063; contract: {@code spec/code-writer.md}). The
 * {@link #code()} is one of the codes every port's writer shares, and the message starts with it.
 */
public class WriterException extends RuntimeException {

  /** {@code close()} with no block open. */
  public static final String UNBALANCED_CLOSE = "ERR_WRITER_UNBALANCED_CLOSE";
  /** The file was finished with a block still open; the message quotes the line that opened it. */
  public static final String UNCLOSED_BLOCK = "ERR_WRITER_UNCLOSED_BLOCK";
  /** {@code line()} was handed text containing a line break. */
  public static final String NEWLINE_IN_LINE = "ERR_WRITER_NEWLINE_IN_LINE";
  /** One local name imported from two different places. */
  public static final String IMPORT_CONFLICT = "ERR_WRITER_IMPORT_CONFLICT";
  /** A piece the writer does not know how to print. */
  public static final String UNKNOWN_PIECE = "ERR_WRITER_UNKNOWN_PIECE";

  private final String code;

  public WriterException(String code, String message) {
    super(code + ": " + message);
    this.code = code;
  }

  public String code() {
    return code;
  }
}
