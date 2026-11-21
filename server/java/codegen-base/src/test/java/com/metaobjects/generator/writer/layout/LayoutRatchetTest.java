package com.metaobjects.generator.writer.layout;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import com.metaobjects.generator.writer.layout.LayoutAnalyzer.Finding;
import com.metaobjects.generator.writer.layout.LayoutAnalyzer.Kind;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.junit.Test;

/**
 * The layout ratchet (ADR-0063): generator source never types layout; the writer does.
 *
 * <p>Three parts: the analyzer's own cases (layout it must catch, and writer-based code it must
 * pass), the scope rule (which files are generator source, by rule and not by list) and the
 * ratchet over the real modules: every file with hand-typed layout is on the allowlist with a
 * reason, every allowlisted file still needs its entry, and the allowlist only shrinks.
 */
public class LayoutRatchetTest {

  private static List<Kind> kinds(String body) {
    return LayoutAnalyzer.analyze("Fixture.java", "class Fixture { void f() { " + body + " } }").stream()
        .map(Finding::kind)
        .sorted()
        .toList();
  }

  private static List<Kind> sorted(Kind... k) {
    return Stream.of(k).sorted().toList();
  }

  // ── 1. the analyzer ──────────────────────────────────────────────────────────────────

  @Test
  public void catches_a_newline_escape() {
    assertEquals(sorted(Kind.NEWLINE_LITERAL), kinds("String s = \"a\\nb\";"));
    assertEquals(sorted(Kind.NEWLINE_LITERAL), kinds("String s = \"a\\r\";"));
    assertEquals(sorted(Kind.NEWLINE_LITERAL), kinds("sb.append('\\n');"));
  }

  @Test
  public void catches_a_text_block_a_percent_n_and_a_line_separator() {
    assertEquals(sorted(Kind.NEWLINE_LITERAL), kinds("String s = \"\"\"\n  a\n  \"\"\";"));
    assertEquals(sorted(Kind.NEWLINE_LITERAL), kinds("String s = String.format(\"%s%n\", x);"));
    assertEquals(sorted(Kind.NEWLINE_LITERAL), kinds("String s = System.lineSeparator();"));
  }

  @Test
  public void catches_a_string_that_starts_with_an_indentation_run() {
    assertEquals(sorted(Kind.INDENT_LITERAL), kinds("rows.add(\"  \" + name);"));
    assertEquals(sorted(Kind.INDENT_LITERAL), kinds("rows.add(\"\\tx\");"));
    assertEquals(sorted(Kind.INDENT_LITERAL), kinds("rows.add(\"    name: String;\");"));
  }

  @Test
  public void catches_a_join_on_a_line_break() {
    assertEquals(sorted(Kind.NEWLINE_JOIN, Kind.NEWLINE_LITERAL), kinds("String.join(\"\\n\", rows);"));
    assertEquals(sorted(Kind.NEWLINE_JOIN, Kind.NEWLINE_LITERAL), kinds("rows.stream().collect(Collectors.joining(\",\\n\"));"));
    assertEquals(sorted(Kind.NEWLINE_JOIN, Kind.NEWLINE_LITERAL), kinds("var j = new StringJoiner(\"\\n\");"));
  }

  @Test
  public void catches_an_indentation_repeat() {
    assertEquals(sorted(Kind.INDENT_REPEAT, Kind.INDENT_LITERAL), kinds("String pad = \"  \".repeat(depth);"));
    assertEquals(sorted(Kind.INDENT_REPEAT), kinds("String pad = \" \".repeat(depth * 2);"));
  }

  @Test
  public void a_newline_hidden_behind_a_constant_is_caught_where_it_is_used() {
    String source = "class F { static final String NL = \"\\n\"; String f() { return String.join(NL, rows); } }";
    List<Finding> found = LayoutAnalyzer.analyze("F.java", source);
    assertEquals(
        List.of(Kind.NEWLINE_LITERAL, Kind.NEWLINE_JOIN), found.stream().map(Finding::kind).toList());
  }

  @Test
  public void a_constant_built_from_other_constants_is_followed() {
    String source =
        "class F { static final String NL = \"\\n\"; static final String SEP = \",\" + NL;"
            + " String f() { return String.join(SEP, rows); } }";
    List<Kind> found = LayoutAnalyzer.analyze("F.java", source).stream().map(Finding::kind).toList();
    assertEquals(List.of(Kind.NEWLINE_LITERAL, Kind.NEWLINE_JOIN), found);
  }

  @Test
  public void an_indentation_unit_hidden_behind_a_constant_is_caught_at_the_repeat() {
    String source = "class F { static final String UNIT = \" \"; String f() { return UNIT.repeat(4); } }";
    assertEquals(List.of(Kind.INDENT_REPEAT), LayoutAnalyzer.analyze("F.java", source).stream().map(Finding::kind).toList());
  }

  @Test
  public void either_branch_of_a_conditional_separator_counts() {
    assertEquals(sorted(Kind.NEWLINE_JOIN, Kind.NEWLINE_LITERAL), kinds("String.join(compact ? \", \" : \",\\n\", rows);"));
  }

  @Test
  public void findings_carry_the_line_and_column_of_the_node() {
    Finding f = LayoutAnalyzer.analyze("F.java", "class F {\n  String s = \"a\\nb\";\n}").get(0);
    assertEquals(2, f.line());
    assertEquals(14, f.column());
  }

  @Test
  public void passes_a_generator_written_on_the_writer() {
    String source =
        """
        import com.metaobjects.generator.writer.JavaWriter;

        class Gen {
          // Comments may say anything, including "\\n" and
          //     indented text: a comment is never a node.
          /*
           *   a block comment, indented
           */
          String render(Entity entity) {
            JavaWriter w = new JavaWriter();
            String list = w.use("java.util.List");
            try (var b = w.block("class " + entity.name() + " {")) {
              w.line("private final ", list, "<String> names;");
              w.blank();
              w.text(\"\"\"
                  void check() {
                    return;
                  }
                  \"\"\");
            }
            return w.toString();
          }
        }
        """;
    assertEquals(List.of(), LayoutAnalyzer.analyze("Gen.java", source));
  }

  @Test
  public void a_line_break_used_as_a_search_pattern_or_comparison_is_not_output() {
    assertEquals(List.of(), kinds("String[] p = description.split(\"\\n\");"));
    assertEquals(List.of(), kinds("if (body.contains(\"\\n\")) flag();"));
    assertEquals(List.of(), kinds("String s = body.replace(\"\\r\\n\", \" \").replaceAll(\"\\n\", \" \");"));
    assertEquals(List.of(), kinds("int at = body.indexOf(\"  \");"));
    assertEquals(List.of(), kinds("if (c == '\\n') flag();"));
    assertEquals(List.of(), kinds("switch (c) { case \"\\n\" -> flag(); default -> {} }"));
    assertEquals(List.of(), kinds("switch (ch) { case '\\n': flag(); break; default: break; }"));
    assertEquals(List.of(), kinds("log.debug(\"  Template Path: {}\", path);"));
  }

  @Test
  public void a_replacement_that_writes_a_line_break_is_still_output() {
    assertEquals(sorted(Kind.NEWLINE_LITERAL), kinds("String s = body.replace(\";\", \";\\n\");"));
  }

  @Test
  public void single_spaces_joins_on_a_space_and_text_after_a_concatenation_are_not_layout() {
    assertEquals(List.of(), kinds("String a = String.join(\", \", names); String b = left + \"  \" + right; String c = \" \" + x;"));
  }

  @Test
  public void a_variable_shadowing_a_layout_constant_is_not_resolved_to_it() {
    String source = "class F { String f(String SEP) { return String.join(SEP, rows); } static final String SEP = \",\\n\"; }";
    // The declaration is a finding; the join, whose SEP is the parameter, is not.
    assertEquals(List.of(Kind.NEWLINE_LITERAL), LayoutAnalyzer.analyze("F.java", source).stream().map(Finding::kind).toList());
  }

  // ── 2. the scope rule ────────────────────────────────────────────────────────────────

  @Test
  public void scope_is_decided_by_rule() {
    String[][] cases = {
      {"codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringControllerGenerator.java", "true"},
      {"codegen-base/src/main/java/com/metaobjects/generator/direct/object/javacode/JavaCodeWriter.java", "true"},
      {"codegen-plantuml/src/main/java/com/metaobjects/generator/direct/plantuml/PlantUMLWriter.java", "true"},
      {"codegen-base/src/main/java/com/metaobjects/generator/writer/CodeWriter.java", "false"},
      {"codegen-base/src/main/java/com/metaobjects/generator/writer/JavaWriter.java", "false"},
      {"codegen-spring/src/test/java/com/metaobjects/generator/spring/Foo.java", "false"},
      {"codegen-spring/src/main/java/com/metaobjects/generator/spring/package-info.java", "false"},
      {"codegen-spring/src/main/resources/templates/x.java", "false"},
      {"metadata/src/main/java/com/metaobjects/Foo.java", "false"},
      {"codegen-spring/README.md", "false"},
    };
    for (String[] c : cases) assertEquals(c[0], Boolean.parseBoolean(c[1]), LayoutAnalyzer.isGeneratorSource(c[0]));
  }

  // ── 3. the ratchet over the real modules ─────────────────────────────────────────────────

  /** {@code server/java/}: the tests run with the module as the working directory. */
  private static final Path JAVA = Path.of(System.getProperty("user.dir")).resolve("..").normalize();

  private static final Path ALLOWLIST = Path.of(System.getProperty("user.dir"), "src/test/resources/layout-ratchet/allowlist.json");

  /** The allowlist: {@code unconverted} and {@code exempt}, each a map from file to its written reason. */
  record Allowlist(Map<String, String> unconverted, Map<String, String> exempt) {
    Map<String, String> entries() {
      Map<String, String> all = new TreeMap<>(unconverted);
      all.putAll(exempt);
      return all;
    }
  }

  private static Allowlist readAllowlist(String json) {
    Map<String, Object> raw = new Gson().fromJson(json, new TypeToken<Map<String, Object>>() {}.getType());
    return new Allowlist(strings(raw.get("unconverted")), strings(raw.get("exempt")));
  }

  @SuppressWarnings("unchecked")
  private static Map<String, String> strings(Object o) {
    return o == null ? new TreeMap<>() : new TreeMap<>((Map<String, String>) o);
  }

  private static final Allowlist allowlist;
  private static final Map<String, List<Finding>> findings = new TreeMap<>();

  static {
    try {
      allowlist = readAllowlist(Files.readString(ALLOWLIST, StandardCharsets.UTF_8));
      for (String module : LayoutAnalyzer.SCANNED_MODULES) {
        Path src = JAVA.resolve(module).resolve("src/main/java");
        try (Stream<Path> files = Files.walk(src)) {
          for (Path f : files.filter(Files::isRegularFile).toList()) {
            String rel = JAVA.relativize(f).toString().replace('\\', '/');
            if (LayoutAnalyzer.isGeneratorSource(rel)) {
              findings.put(rel, LayoutAnalyzer.analyze(rel, Files.readString(f, StandardCharsets.UTF_8)));
            }
          }
        }
      }
      // `-Dlayout.dump=<file>` lists every file that types layout, to write or prune allowlist entries.
      String dump = System.getProperty("layout.dump");
      if (dump != null) {
        List<String> rows = new ArrayList<>();
        findings.forEach((f, found) -> { if (!found.isEmpty()) rows.add(f + "\t" + found.size() + "\t" + found.stream().map(x -> x.kind().toString()).distinct().sorted().collect(Collectors.joining(","))); });
        Files.write(Path.of(dump), rows);
      }
    } catch (IOException e) {
      throw new IllegalStateException(e);
    }
  }

  @Test
  public void it_reads_every_scanned_module() {
    for (String m : LayoutAnalyzer.SCANNED_MODULES) {
      assertTrue(m, findings.keySet().stream().anyMatch(f -> f.startsWith(m + "/")));
    }
  }

  @Test
  public void no_generator_source_types_layout_unless_its_file_is_allowlisted() {
    Map<String, String> entries = allowlist.entries();
    List<String> offenders = new ArrayList<>();
    findings.forEach(
        (file, found) -> {
          if (!found.isEmpty() && !entries.containsKey(file)) {
            offenders.add(file + "\n" + found.stream().map(f -> "  " + f).collect(Collectors.joining("\n")));
          }
        });
    assertEquals(
        "Write these lines through JavaWriter (generator/writer/) instead of typing line breaks or"
            + " indentation. A file is never added to the allowlist: it only shrinks.",
        List.of(),
        offenders);
  }

  @Test
  public void every_allowlisted_file_still_needs_its_entry() {
    List<String> stale = new ArrayList<>();
    for (String file : allowlist.entries().keySet()) {
      if (findings.getOrDefault(file, List.of()).isEmpty()) stale.add(file);
    }
    assertEquals("these files no longer type layout (or no longer exist): remove their allowlist entries", List.of(), stale);
  }

  @Test
  public void every_allowlisted_path_is_generator_source_that_exists() {
    for (String file : allowlist.entries().keySet()) {
      assertTrue(file + " is not in the ratchet's scope", LayoutAnalyzer.isGeneratorSource(file));
      assertTrue(file + " does not exist", Files.exists(JAVA.resolve(file)));
    }
  }

  @Test
  public void every_entry_carries_a_written_reason() {
    allowlist.entries().forEach((file, reason) -> assertTrue(file + " needs a reason", reason.length() > 40));
  }

  @Test
  public void a_file_is_either_unconverted_or_exempt_never_both_and_each_list_is_sorted() {
    for (String f : allowlist.unconverted().keySet()) assertFalse(f, allowlist.exempt().containsKey(f));
    for (Map<String, String> list : List.of(allowlist.unconverted(), allowlist.exempt())) {
      assertEquals(new ArrayList<>(new TreeMap<>(list).keySet()), new ArrayList<>(list.keySet()));
    }
  }

  /** The allowlist may only shrink. Compared with the copy at the merge base of every integration branch this checkout knows. */
  @Test
  public void the_allowlist_only_shrinks() throws Exception {
    List<Allowlist> bases = mergeBaseAllowlists();
    assumeTrue("git or the integration refs are unavailable (an export or a shallow clone)", bases != null);
    for (Allowlist base : bases) {
      assertEquals(
          "the allowlist grew since the merge base; convert the file to the writer instead",
          List.of(),
          growth(base, allowlist));
    }
  }

  @Test
  public void growth_is_an_added_entry_or_an_unconverted_file_relabelled_exempt_and_removal_is_not() {
    Allowlist before =
        new Allowlist(new TreeMap<>(Map.of("A.java", "r", "B.java", "r")), new TreeMap<>(Map.of("C.java", "r")));
    assertEquals(List.of(), growth(before, new Allowlist(new TreeMap<>(Map.of("A.java", "r")), new TreeMap<>())));
    assertEquals(
        List.of("added D.java"),
        growth(before, new Allowlist(new TreeMap<>(Map.of("A.java", "r", "D.java", "r")), new TreeMap<>(Map.of("C.java", "r")))));
    assertEquals(
        List.of("relabelled B.java as exempt"),
        growth(before, new Allowlist(new TreeMap<>(Map.of("A.java", "r")), new TreeMap<>(Map.of("B.java", "r", "C.java", "r")))));
  }

  /** How {@code now} grew relative to {@code before}: entries that are new, and unconverted files relabelled exempt. */
  private static List<String> growth(Allowlist before, Allowlist now) {
    List<String> out = new ArrayList<>();
    Map<String, String> had = before.entries();
    for (String f : now.entries().keySet()) if (!had.containsKey(f)) out.add("added " + f);
    for (String f : now.exempt().keySet()) if (before.unconverted().containsKey(f)) out.add("relabelled " + f + " as exempt");
    return out;
  }

  private static String git(String... args) {
    try {
      List<String> cmd = new ArrayList<>(List.of("git", "-C", JAVA.toString()));
      cmd.addAll(List.of(args));
      Process p = new ProcessBuilder(cmd).redirectError(ProcessBuilder.Redirect.DISCARD).start();
      String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
      return p.waitFor() == 0 ? out : null;
    } catch (IOException | InterruptedException e) {
      return null;
    }
  }

  /** The allowlist as it stood at the merge base of HEAD with each integration branch; null when git or those refs are unavailable. */
  private static List<Allowlist> mergeBaseAllowlists() {
    String refs = git("for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/main", "refs/remotes/origin/release/");
    if (refs == null || refs.isEmpty()) return null;
    String top = git("rev-parse", "--show-toplevel");
    if (top == null) return null;
    String rel = Path.of(top).relativize(ALLOWLIST).toString().replace('\\', '/');
    List<Allowlist> out = new ArrayList<>();
    boolean reachable = false;
    for (String ref : refs.split("\\s+")) {
      String base = git("merge-base", "HEAD", ref);
      if (base == null) continue;
      reachable = true;
      String text = git("show", base + ":" + rel);
      if (text != null) out.add(readAllowlist(text));
    }
    return reachable ? out : null;
  }
}
