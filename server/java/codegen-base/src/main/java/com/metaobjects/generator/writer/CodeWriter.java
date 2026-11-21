package com.metaobjects.generator.writer;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Pattern;

/**
 * The language-neutral code writer (ADR-0063; contract: {@code spec/code-writer.md}).
 *
 * <p>A generator says WHAT a line contains; the writer decides WHERE it sits. It builds the file
 * in memory and returns a string, so nothing here touches the disk and no formatter ever runs
 * over the result. It never parses the text it is handed: it lays out the structure the
 * generator gave it, which is lines, blocks, blank-line requests and breakable lists.
 *
 * <p>This package is the only generator source allowed to type layout (line breaks and
 * indentation). The layout ratchet test holds every other generator file to that.
 *
 * <p>The class is built to be extended (ADR-0063, item 7): nothing is final or private, so a
 * dialect or an adopter's subclass overrides the one step it needs to change, such as where a
 * line breaks ({@link #breakAt}) or what a part becomes ({@link #piece}). These methods are not
 * a stability contract and may change between minor versions.
 */
public class CodeWriter {

  private static final String NEWLINE = "\n";
  private static final Pattern ANY_LINE_BREAK = Pattern.compile("\r\n?|\n");

  protected final WriterOptions options;
  protected final List<String> out = new ArrayList<>();
  /** The text of each line that opened a block still open, outermost first. */
  protected final List<String> openers = new ArrayList<>();
  protected final List<String> prefixes = new ArrayList<>(List.of(""));
  protected boolean wantBlank = false;
  /** True at the start of the file and right after a block opens: no blank line goes here. */
  protected boolean atBlockStart = true;

  public CodeWriter(WriterOptions options) {
    this.options = options;
  }

  public WriterOptions options() {
    return options;
  }

  /**
   * One line at the current indent. The parts are concatenated; when the line does not fit the
   * width, the LAST non-empty list in it is printed one item per line. A line whose text is
   * empty is a blank-line request.
   */
  public CodeWriter line(Object... parts) {
    return put(piece(Arrays.asList(parts)));
  }

  /** Ask for one blank line before whatever is written next. Requests never stack. */
  public CodeWriter blank() {
    wantBlank = true;
    return this;
  }

  /** Write the line that opens a block, then indent. */
  public CodeWriter open(Object... parts) {
    return openPiece(piece(Arrays.asList(parts)));
  }

  /** Dedent, then write the line that closes the block. */
  public CodeWriter close(Object... parts) {
    return closePiece(piece(Arrays.asList(parts)));
  }

  /**
   * A block, scoped: {@code try (var b = w.block("class A {")) { ... }} writes the head, indents,
   * and on leaving the {@code try} dedents and writes {@code "}"}. The indent cannot be left
   * unbalanced.
   */
  public Block block(Object head) {
    return block(head, "}");
  }

  /** A block closed by {@code tail} instead of {@code "}"}, such as {@code "});"}. */
  public Block block(Object head, Object tail) {
    open(head);
    return new Block(tail);
  }

  /** The scope {@link #block} returns; closing it writes the block's closing line. */
  public class Block implements AutoCloseable {
    private final Object tail;

    protected Block(Object tail) {
      this.tail = tail;
    }

    @Override
    public void close() {
      CodeWriter.this.close(tail);
    }
  }

  /**
   * A multi-line snippet written as it should read: a Java text block is the natural argument.
   * Its common left margin is removed and it is re-indented to the current level; a blank line in
   * it is a blank-line request. Every line is re-indented, including lines inside a multi-line
   * string literal.
   */
  public CodeWriter text(String snippet) {
    List<String> lines = new ArrayList<>(List.of(ANY_LINE_BREAK.split(snippet, -1)));
    if (lines.size() > 1 && lines.get(0).isBlank()) lines.remove(0);
    if (!lines.isEmpty() && lines.get(lines.size() - 1).isBlank()) lines.remove(lines.size() - 1);
    int margin = Integer.MAX_VALUE;
    for (String l : lines) {
      if (!l.isBlank()) margin = Math.min(margin, l.length() - l.stripLeading().length());
    }
    for (String l : lines) {
      if (l.isBlank()) blank();
      else put(l.substring(margin));
    }
    return this;
  }

  /** The body text: every line joined, with no final newline. Throws if a block is still open. */
  protected String body() {
    if (!openers.isEmpty()) {
      throw new WriterException(
          WriterException.UNCLOSED_BLOCK,
          "unclosed block opened by: " + openers.get(openers.size() - 1));
    }
    return String.join(NEWLINE, out);
  }

  /** The finished file: {@code \n} line endings, no trailing whitespace, one final newline (none when empty). */
  @Override
  public String toString() {
    String body = body();
    return body.isEmpty() ? "" : body + NEWLINE;
  }

  /**
   * Turn one argument of {@code line()} into a writer piece. A dialect overrides this to accept
   * its own fragment types, and calls {@code super} for the rest.
   */
  protected Object piece(Object p) {
    if (p instanceof CharSequence cs) return cs.toString();
    if (p instanceof Group g) {
      List<Object> items = new ArrayList<>(g.items().size());
      for (Object i : g.items()) items.add(piece(i));
      return new Group(g.open(), items, g.close(), g.pad());
    }
    if (p instanceof List<?> l) {
      List<Object> parts = new ArrayList<>(l.size());
      for (Object x : l) parts.add(piece(x));
      return parts;
    }
    if (p instanceof Object[] a) return piece(Arrays.asList(a));
    throw new WriterException(WriterException.UNKNOWN_PIECE, "cannot write " + describe(p));
  }

  /** Whether {@code text} fits on one line at the current indent. */
  protected boolean fits(String text) {
    return widthOf(prefix()) + widthOf(text) <= options.width();
  }

  /**
   * Where a line that does not fit breaks: the text before, the list that breaks, the text
   * after; or null to print the line as it is. The default is the line's LAST non-empty list.
   */
  protected Split breakAt(Object piece) {
    return lastGroup(piece);
  }

  protected CodeWriter openPiece(Object piece) {
    put(piece);
    openers.add(flat(piece).strip());
    atBlockStart = true;
    return this;
  }

  protected CodeWriter closePiece(Object piece) {
    if (openers.isEmpty()) {
      throw new WriterException(
          WriterException.UNBALANCED_CLOSE, "close(\"" + flat(piece) + "\") with no block open");
    }
    openers.remove(openers.size() - 1);
    wantBlank = false;
    return put(piece);
  }

  protected String prefix() {
    int depth = openers.size();
    while (prefixes.size() <= depth) prefixes.add(prefixes.get(prefixes.size() - 1) + options.indent());
    return prefixes.get(depth);
  }

  protected CodeWriter put(Object piece) {
    String raw = flat(piece);
    if (ANY_LINE_BREAK.matcher(raw).find()) {
      throw new WriterException(
          WriterException.NEWLINE_IN_LINE,
          "line text contains a line break; write each line separately or use text(): \"" + raw + "\"");
    }
    String text = raw.stripTrailing();
    if (text.isEmpty()) return blank();
    if (wantBlank && !atBlockStart) out.add("");
    wantBlank = false;
    atBlockStart = false;
    String pre = prefix();
    Split split = fits(text) ? null : breakAt(piece);
    if (split == null) {
      out.add(pre + text);
      return this;
    }
    openPiece(split.before() + split.group().open());
    List<Object> items = split.group().items();
    for (int n = 0; n < items.size(); n++) {
      boolean comma = n < items.size() - 1 || options.trailingComma();
      put(List.of(items.get(n), comma ? "," : ""));
    }
    return closePiece(split.group().close() + split.after());
  }

  /** The text before a list that breaks, the list, and the text after it. */
  public record Split(String before, Group group, String after) {}

  /** A list with no padding inside its brackets: {@code [a, b]}, {@code f(a, b)}, {@code <A, B>}. */
  public static Group list(String open, List<?> items, String close) {
    return new Group(open, items, close, false);
  }

  /** A list with a space inside its brackets: {@code { a, b }}. */
  public static Group padded(String open, List<?> items, String close) {
    return new Group(open, items, close, true);
  }

  /** A piece printed on one line. */
  public static String flat(Object p) {
    if (p instanceof String s) return s;
    if (p instanceof Group g) {
      if (g.items().isEmpty()) return g.open() + g.close();
      StringBuilder inner = new StringBuilder();
      for (int i = 0; i < g.items().size(); i++) {
        if (i > 0) inner.append(", ");
        inner.append(flat(g.items().get(i)));
      }
      return g.pad() ? g.open() + " " + inner + " " + g.close() : g.open() + inner + g.close();
    }
    if (p instanceof List<?> l) {
      StringBuilder s = new StringBuilder();
      for (Object x : l) s.append(flat(x));
      return s.toString();
    }
    return String.valueOf(p);
  }

  /** Split a piece around its LAST non-empty list: the text before, the list, the text after. */
  protected static Split lastGroup(Object p) {
    if (p instanceof Group g) return g.items().isEmpty() ? null : new Split("", g, "");
    if (p instanceof List<?> l) {
      for (int i = l.size() - 1; i >= 0; i--) {
        Split hit = lastGroup(l.get(i));
        if (hit != null) {
          return new Split(
              flat(l.subList(0, i)) + hit.before(), hit.group(), hit.after() + flat(l.subList(i + 1, l.size())));
        }
      }
    }
    return null;
  }

  /** Width in Unicode code points, so an emoji counts as one although it is two UTF-16 units. */
  protected static int widthOf(String s) {
    return s.codePointCount(0, s.length());
  }

  protected static String describe(Object p) {
    if (p == null) return "null";
    return "an object (" + p.getClass().getName() + ")";
  }
}
