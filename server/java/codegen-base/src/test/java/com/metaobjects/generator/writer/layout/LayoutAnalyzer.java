package com.metaobjects.generator.writer.layout;

import com.sun.source.tree.BinaryTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ConditionalExpressionTree;
import com.sun.source.tree.ConstantCaseLabelTree;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.ParenthesizedTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.TypeCastTree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import java.io.IOException;
import java.net.URI;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.ToolProvider;

/**
 * The layout ratchet's analyzer (ADR-0063): finds layout a generator typed by hand.
 *
 * <p>Generators say what a line contains and the writer decides where it sits, so generator
 * source should never spell a line break or an indentation run. This reads a file with javac's
 * own parser (the Compiler Tree API, parse only) and walks the syntax tree. Working on the tree,
 * not the text, is what makes the rules exact: a comment is never a node, a string's value is the
 * parser's cooked value (so {@code "\n"}, {@code "\u000a"} and a text block are the same
 * finding), and a {@code final} constant is followed to its declaration so
 * {@code String NL = "\n"; xs.join(NL, ...)} is a finding at the join as well as at the
 * declaration.
 *
 * <p>Four rules:
 *
 * <ul>
 *   <li>{@code newline-literal}: a string or char literal, text block, {@code %n} format
 *       directive or {@code lineSeparator()} call that writes a line break.
 *   <li>{@code indent-literal}: a string that starts a line of output (it is not the right-hand
 *       part of a {@code +}) and begins with an indentation run: two or more spaces, or a tab.
 *   <li>{@code newline-join}: {@code String.join(sep, ...)}, {@code Collectors.joining(sep)} or
 *       {@code new StringJoiner(sep)} whose separator contains a line break, resolved through
 *       same-file constants.
 *   <li>{@code indent-repeat}: {@code s.repeat(n)} where {@code s} resolves to whitespace.
 * </ul>
 *
 * <p>Places a literal is not output, and so is not layout, are ruled out by position: a search or
 * comparison (the first argument of split, indexOf, lastIndexOf, contains, startsWith, endsWith,
 * replace, replaceAll, replaceFirst, matches, equals, equalsIgnoreCase, contentEquals, or an
 * operand of {@code ==} or {@code !=}, or a {@code case} label), a log message (the first argument
 * of trace, debug, info, warn or error), and a writer snippet (the
 * argument of a {@code .text(...)} call, the writer's entry for fixed code written as it should
 * read: it removes the margin and re-indents).
 */
public final class LayoutAnalyzer {

  public enum Kind {
    NEWLINE_LITERAL("newline-literal"),
    INDENT_LITERAL("indent-literal"),
    NEWLINE_JOIN("newline-join"),
    INDENT_REPEAT("indent-repeat");

    private final String label;

    Kind(String label) {
      this.label = label;
    }

    @Override
    public String toString() {
      return label;
    }
  }

  /** One piece of hand-typed layout: its rule, 1-based position and shortened source text. */
  public record Finding(Kind kind, int line, int column, String excerpt) {
    @Override
    public String toString() {
      return line + ":" + column + " " + kind + " " + excerpt;
    }
  }

  private static final Pattern LINE_BREAK = Pattern.compile("[\r\n]|%n");
  private static final Pattern INDENT_RUN = Pattern.compile("^(?: {2,}|\t)");
  private static final Pattern WHITESPACE = Pattern.compile("^[ \t\r\n]+$");
  private static final Set<String> SEARCH_METHODS =
      Set.of(
          "split", "indexOf", "lastIndexOf", "contains", "startsWith", "endsWith", "replace",
          "replaceAll", "replaceFirst", "matches", "equals", "equalsIgnoreCase", "contentEquals");
  /** A logger call's message is a diagnostic for the person running the build, not generated output. */
  private static final Set<String> LOG_METHODS = Set.of("trace", "debug", "info", "warn", "error");
  private static final String SNIPPET_METHOD = "text";
  private static final Set<String> JOIN_METHODS = Set.of("join", "joining");
  private static final String REPEAT_METHOD = "repeat";
  private static final String LINE_SEPARATOR = "lineSeparator";
  private static final String STRING_JOINER = "StringJoiner";
  private static final int MAX_RESOLVE_DEPTH = 8;

  private LayoutAnalyzer() {}

  /** What a string expression is known to contain. {@code complete} is false when part of it is unknown. */
  private record Resolved(String text, boolean complete) {}

  public static List<Finding> analyze(String fileName, String source) {
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    JavaFileObject file =
        new SimpleJavaFileObject(URI.create("string:///" + fileName), JavaFileObject.Kind.SOURCE) {
          @Override
          public CharSequence getCharContent(boolean ignoreEncodingErrors) {
            return source;
          }
        };
    JavacTask task = (JavacTask) compiler.getTask(null, null, null, List.of("-proc:none"), null, List.of(file));
    Iterable<? extends CompilationUnitTree> units;
    try {
      units = task.parse();
    } catch (IOException e) {
      throw new IllegalStateException("cannot parse " + fileName, e);
    }
    SourcePositions positions = Trees.instance(task).getSourcePositions();
    List<Finding> findings = new ArrayList<>();
    for (CompilationUnitTree unit : units) {
      Map<String, ExpressionTree> consts = collectConsts(unit);
      new Scan(unit, positions, consts, source, findings).scan(unit, null);
    }
    findings.sort(
        java.util.Comparator.comparingInt(Finding::line).thenComparingInt(Finding::column).thenComparing(Finding::kind));
    return findings;
  }

  private static final class Scan extends TreePathScanner<Void, Void> {
    private final CompilationUnitTree unit;
    private final SourcePositions positions;
    private final Map<String, ExpressionTree> consts;
    private final String source;
    private final List<Finding> findings;

    Scan(
        CompilationUnitTree unit,
        SourcePositions positions,
        Map<String, ExpressionTree> consts,
        String source,
        List<Finding> findings) {
      this.unit = unit;
      this.positions = positions;
      this.consts = consts;
      this.source = source;
      this.findings = findings;
    }

    private void report(Kind kind, Tree node) {
      long start = positions.getStartPosition(unit, node);
      long end = positions.getEndPosition(unit, node);
      long line = unit.getLineMap().getLineNumber(start);
      long column = unit.getLineMap().getColumnNumber(start);
      String raw = source.substring((int) start, (int) Math.max(start, Math.min(end, source.length()))).replaceAll("\\s+", " ");
      findings.add(new Finding(kind, (int) line, (int) column, raw.length() > 60 ? raw.substring(0, 57) + "..." : raw));
    }

    @Override
    public Void visitLiteral(LiteralTree node, Void unused) {
      Object value = node.getValue();
      boolean string = value instanceof String;
      boolean ch = value instanceof Character;
      if ((string || ch) && !isSearchPattern(getCurrentPath()) && !isSnippet(getCurrentPath())) {
        String v = String.valueOf(value);
        if (LINE_BREAK.matcher(v).find()) report(Kind.NEWLINE_LITERAL, node);
        else if (string && startsALine(getCurrentPath()) && INDENT_RUN.matcher(v).find()) report(Kind.INDENT_LITERAL, node);
      }
      return super.visitLiteral(node, unused);
    }

    @Override
    public Void visitMethodInvocation(MethodInvocationTree call, Void unused) {
      String method = calledName(call.getMethodSelect());
      if (method != null) {
        if (JOIN_METHODS.contains(method) && !call.getArguments().isEmpty()) {
          Resolved sep = resolve(call.getArguments().get(0), 0);
          if (sep != null && LINE_BREAK.matcher(sep.text()).find()) report(Kind.NEWLINE_JOIN, call);
        } else if (method.equals(REPEAT_METHOD) && call.getMethodSelect() instanceof MemberSelectTree ms) {
          Resolved unit = resolve(ms.getExpression(), 0);
          if (unit != null && unit.complete() && WHITESPACE.matcher(unit.text()).find()) report(Kind.INDENT_REPEAT, call);
        } else if (method.equals(LINE_SEPARATOR) && call.getArguments().isEmpty()) {
          report(Kind.NEWLINE_LITERAL, call);
        }
      }
      return super.visitMethodInvocation(call, unused);
    }

    @Override
    public Void visitNewClass(NewClassTree node, Void unused) {
      if (node.getIdentifier() instanceof IdentifierTree id
          && id.getName().contentEquals(STRING_JOINER)
          && !node.getArguments().isEmpty()) {
        Resolved sep = resolve(node.getArguments().get(0), 0);
        if (sep != null && LINE_BREAK.matcher(sep.text()).find()) report(Kind.NEWLINE_JOIN, node);
      }
      return super.visitNewClass(node, unused);
    }

    private Resolved resolve(ExpressionTree expr, int depth) {
      if (depth > MAX_RESOLVE_DEPTH) return null;
      if (expr instanceof LiteralTree lit && lit.getValue() instanceof String s) return new Resolved(s, true);
      if (expr instanceof LiteralTree lit && lit.getValue() instanceof Character c) return new Resolved(String.valueOf(c), true);
      if (expr instanceof ParenthesizedTree p) return resolve(p.getExpression(), depth + 1);
      if (expr instanceof TypeCastTree c) return resolve(c.getExpression(), depth + 1);
      if (expr instanceof BinaryTree b && b.getKind() == Tree.Kind.PLUS) {
        Resolved l = resolve(b.getLeftOperand(), depth + 1);
        Resolved r = resolve(b.getRightOperand(), depth + 1);
        if (l == null && r == null) return null;
        return new Resolved(
            (l == null ? "" : l.text()) + (r == null ? "" : r.text()),
            l != null && l.complete() && r != null && r.complete());
      }
      if (expr instanceof ConditionalExpressionTree c) {
        // Either branch may be written; for "does it contain a line break" both count.
        Resolved a = resolve(c.getTrueExpression(), depth + 1);
        Resolved b = resolve(c.getFalseExpression(), depth + 1);
        if (a == null && b == null) return null;
        return new Resolved((a == null ? "" : a.text()) + (b == null ? "" : b.text()), false);
      }
      if (expr instanceof IdentifierTree id) {
        ExpressionTree init = consts.get(id.getName().toString());
        return init == null ? null : resolve(init, depth + 1);
      }
      if (expr instanceof MemberSelectTree ms) {
        // `Type.NAME` or `this.NAME`: the member name is looked up among the file's constants.
        ExpressionTree init = consts.get(ms.getIdentifier().toString());
        return init == null ? null : resolve(init, depth + 1);
      }
      return null;
    }
  }

  /**
   * Every {@code final} variable with an initializer whose name is declared exactly once in the
   * file. A name declared more than once is left out: it is shadowed somewhere.
   */
  private static Map<String, ExpressionTree> collectConsts(CompilationUnitTree unit) {
    Map<String, ExpressionTree> seen = new HashMap<>();
    Set<String> shadowed = new java.util.HashSet<>();
    new TreePathScanner<Void, Void>() {
      @Override
      public Void visitVariable(VariableTree v, Void unused) {
        String name = v.getName().toString();
        boolean isFinal = v.getModifiers().getFlags().contains(javax.lang.model.element.Modifier.FINAL);
        if (seen.containsKey(name) || shadowed.contains(name) || v.getInitializer() == null || !isFinal) {
          shadowed.add(name);
          seen.remove(name);
        } else {
          seen.put(name, v.getInitializer());
        }
        return super.visitVariable(v, unused);
      }
    }.scan(unit, null);
    return seen;
  }

  /** The method name a call invokes: {@code x.join(...)} is "join", {@code join(...)} is "join". */
  private static String calledName(ExpressionTree select) {
    if (select instanceof MemberSelectTree ms) return ms.getIdentifier().toString();
    if (select instanceof IdentifierTree id) return id.getName().toString();
    return null;
  }

  /** A string that is the right-hand part of a {@code +} follows other text, so it does not start a line. */
  private static boolean startsALine(TreePath path) {
    Tree parent = path.getParentPath().getLeaf();
    return !(parent instanceof BinaryTree b && b.getKind() == Tree.Kind.PLUS && b.getRightOperand() == path.getLeaf());
  }

  private static boolean isSearchPattern(TreePath path) {
    Tree leaf = path.getLeaf();
    Tree parent = path.getParentPath().getLeaf();
    if (parent instanceof ParenthesizedTree) return isSearchPattern(path.getParentPath());
    if (parent instanceof BinaryTree b && (b.getKind() == Tree.Kind.EQUAL_TO || b.getKind() == Tree.Kind.NOT_EQUAL_TO)) {
      return true;
    }
    if (parent instanceof ConstantCaseLabelTree) return true;
    return isArgument(path, SEARCH_METHODS::contains, 0) || isArgument(path, LOG_METHODS::contains, 0);
  }

  private static boolean isSnippet(TreePath path) {
    return isArgument(path, SNIPPET_METHOD::equals, 0);
  }

  private static boolean isArgument(TreePath path, java.util.function.Predicate<String> method, int index) {
    Tree leaf = path.getLeaf();
    Tree parent = path.getParentPath().getLeaf();
    if (!(parent instanceof MethodInvocationTree call) || !(call.getMethodSelect() instanceof MemberSelectTree ms)) return false;
    return method.test(ms.getIdentifier().toString()) && call.getArguments().size() > index && call.getArguments().get(index) == leaf;
  }

  // ── which files the ratchet reads ──────────────────────────────────────────────────────

  /** The modules whose {@code src/main/java} holds generator source, relative to {@code server/java/}. */
  public static final List<String> SCANNED_MODULES =
      List.of("codegen-base", "codegen-spring", "codegen-plantuml", "codegen-mustache");

  /** The writer itself: the one package that lays text out, so the one allowed to type layout. */
  private static final String WRITER_DIR = "codegen-base/src/main/java/com/metaobjects/generator/writer/";

  /**
   * Whether a file (relative to {@code server/java/}) is generator source the ratchet reads.
   * Excluded by rule, never by listing: anything outside a scanned module's {@code src/main/java},
   * tests, {@code package-info.java} and the writer.
   */
  public static boolean isGeneratorSource(String rel) {
    String path = rel.replace('\\', '/');
    if (SCANNED_MODULES.stream().noneMatch(m -> path.startsWith(m + "/src/main/java/"))) return false;
    if (!path.endsWith(".java") || path.endsWith("/package-info.java")) return false;
    return !path.startsWith(WRITER_DIR);
  }
}
