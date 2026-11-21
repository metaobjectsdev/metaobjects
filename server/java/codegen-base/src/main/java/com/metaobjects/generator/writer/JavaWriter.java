package com.metaobjects.generator.writer;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * The Java dialect of the code writer (ADR-0063; contract: {@code spec/code-writer.md}).
 *
 * <p>Adds what is Java's own: the {@code package} line, imports collected while the body is
 * written and printed first, string quoting and Javadoc comments. A generator names a type once
 * with {@link #use} and writes what comes back, so the imports can never disagree with the body.
 *
 * <p>Like {@link CodeWriter} it is built to be extended: each section of the file
 * ({@link #writeHeader}, {@link #writePackage}, {@link #writeImports}) is its own overridable
 * method, and none of them is a stability contract.
 */
public class JavaWriter extends CodeWriter {

  private static final String JAVA_LANG = "java.lang";

  /** Simple name to the fully qualified name that owns it, so one name cannot come from two types. */
  protected final Map<String, String> locals = new TreeMap<>();
  /** Fully qualified names to import, in code-unit order. */
  protected final TreeSet<String> imports = new TreeSet<>(Comparator.naturalOrder());
  /** Static members to import, as {@code pkg.Type.member}. */
  protected final TreeSet<String> staticImports = new TreeSet<>(Comparator.naturalOrder());
  /** Member name to the type that owns it: one static name cannot come from two types. */
  protected final Map<String, String> staticLocals = new TreeMap<>();
  protected final List<String> headLines = new ArrayList<>();
  protected String packageName;

  public JavaWriter() {
    this(WriterOptions.JAVA);
  }

  public JavaWriter(WriterOptions options) {
    super(options);
  }

  /** A correctly quoted Java string literal. */
  public static String str(String value) {
    StringBuilder sb = new StringBuilder(value.length() + 2).append('"');
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      switch (c) {
        case '"' -> sb.append("\\\"");
        case '\\' -> sb.append("\\\\");
        case '\n' -> sb.append("\\n");
        case '\r' -> sb.append("\\r");
        case '\t' -> sb.append("\\t");
        case '\b' -> sb.append("\\b");
        case '\f' -> sb.append("\\f");
        default -> {
          if (c < 0x20 || c == 0x7f) sb.append(String.format("\\u%04x", (int) c));
          else sb.append(c);
        }
      }
    }
    return sb.append('"').toString();
  }

  /** A call: {@code fn(a, b)}. */
  public static Group call(String fn, Object... args) {
    return list(fn + "(", Arrays.asList(args), ")");
  }

  /** The {@code package} this file is in; types of that package need no import. */
  public JavaWriter packageName(String name) {
    this.packageName = Objects.requireNonNull(name);
    return this;
  }

  /**
   * Reference a type by its fully qualified name; returns the name to write (its simple name).
   * A type in {@code java.lang} or in this file's package imports nothing. A nested type
   * ({@code java.util.Map.Entry}) is imported as written and written by its last segment.
   */
  public String use(String qualifiedName) {
    String local = simpleName(qualifiedName);
    String owner = locals.get(local);
    if (owner != null && !owner.equals(qualifiedName)) {
      throw new WriterException(
          WriterException.IMPORT_CONFLICT, local + " is imported from both " + owner + " and " + qualifiedName);
    }
    locals.put(local, qualifiedName);
    imports.add(qualifiedName);
    return local;
  }

  /**
   * Reference a static member by {@code pkg.Type.member}; returns the name to write (the member).
   */
  public String useStatic(String qualifiedMember) {
    String member = simpleName(qualifiedMember);
    String owner = staticLocals.get(member);
    if (owner != null && !owner.equals(qualifiedMember)) {
      throw new WriterException(
          WriterException.IMPORT_CONFLICT, member + " is imported from both " + owner + " and " + qualifiedMember);
    }
    staticLocals.put(member, qualifiedMember);
    staticImports.add(qualifiedMember);
    return member;
  }

  /** Lines printed at the very top, before the package line: a banner comment. */
  public JavaWriter header(String... lines) {
    headLines.addAll(Arrays.asList(lines));
    return this;
  }

  /** A Javadoc comment: one line when it fits, otherwise a block with one {@code  * } line per entry. */
  public JavaWriter doc(String... lines) {
    if (lines.length == 0) return this;
    List<String> safe = new ArrayList<>(lines.length);
    for (String l : lines) safe.add(l.replace("*/", "*&#47;"));
    String one = "/** " + safe.get(0) + " */";
    if (safe.size() == 1 && fits(one)) {
      line(one);
      return this;
    }
    line("/**");
    for (String l : safe) line(l.isEmpty() ? " *" : " * " + l);
    line(" */");
    return this;
  }

  @Override
  public String toString() {
    CodeWriter head = sectionWriter();
    writeHeader(head);
    head.blank();
    writePackage(head);
    head.blank();
    writeImports(head);
    String top = head.toString();
    String body = super.toString();
    if (top.isEmpty()) return body;
    if (body.isEmpty()) return top;
    return top + "\n" + body;
  }

  /** The writer the header, package and import sections are laid out with: same options, no dialect. */
  protected CodeWriter sectionWriter() {
    return new CodeWriter(options);
  }

  /** The {@link #header} lines, as given. */
  protected void writeHeader(CodeWriter w) {
    for (String l : headLines) w.line(l);
  }

  /** The {@code package} line, when one was set. */
  protected void writePackage(CodeWriter w) {
    if (packageName != null) w.line("package ", packageName, ";");
  }

  /** Static imports, a blank line, then the other imports: each group in code-unit order. */
  protected void writeImports(CodeWriter w) {
    for (String s : staticImports) w.line("import static ", s, ";");
    w.blank();
    for (String t : imports) {
      if (needsImport(t)) w.line("import ", t, ";");
    }
  }

  /** False for a type that is in {@code java.lang} or in the file's own package. */
  protected boolean needsImport(String qualifiedName) {
    int dot = qualifiedName.lastIndexOf('.');
    if (dot < 0) return false;
    String pkg = qualifiedName.substring(0, dot);
    return !pkg.equals(JAVA_LANG) && !pkg.equals(packageName);
  }

  private static String simpleName(String qualified) {
    return qualified.substring(qualified.lastIndexOf('.') + 1);
  }
}
