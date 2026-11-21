package com.metaobjects.generator.writer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.List;
import org.junit.Test;

/** What the shared corpus cannot say: the Java-shaped API around the cases it pins. */
public class JavaWriterTest {

  @Test
  public void str_quotes_a_java_string_literal() {
    assertEquals("\"a\\\"b\\\\c\"", JavaWriter.str("a\"b\\c"));
    assertEquals("\"line\\nbreak\\ttab\\r\"", JavaWriter.str("line\nbreak\ttab\r"));
    assertEquals("\"\\u0001\"", JavaWriter.str("\u0001"));
    assertEquals("\"caf\u00e9\"", JavaWriter.str("caf\u00e9"));
  }

  @Test
  public void a_scoped_block_indents_and_closes_itself() {
    JavaWriter w = new JavaWriter();
    try (var cls = w.block("class A {")) {
      try (var m = w.block("void f() {")) {
        w.line("g();");
      }
    }
    assertEquals("class A {\n    void f() {\n        g();\n    }\n}\n", w.toString());
  }

  @Test
  public void a_block_can_close_with_its_own_tail() {
    JavaWriter w = new JavaWriter();
    try (var b = w.block("run(() -> {", "});")) {
      w.line("g();");
    }
    assertEquals("run(() -> {\n    g();\n});\n", w.toString());
  }

  @Test
  public void use_returns_the_name_to_write() {
    JavaWriter w = new JavaWriter().packageName("com.acme");
    String list = w.use("java.util.List");
    String str = w.use("java.lang.String");
    w.line("private final ", list, "<", str, "> names;");
    assertEquals("package com.acme;\n\nimport java.util.List;\n\nprivate final List<String> names;\n", w.toString());
  }

  @Test
  public void a_call_group_breaks_at_the_last_list_without_a_trailing_comma() {
    JavaWriter w = new JavaWriter(WriterOptions.JAVA.withWidth(30));
    w.line("return ", JavaWriter.call("build", "alpha", "beta", "gamma", "delta"), ";");
    assertEquals("return build(\n    alpha,\n    beta,\n    gamma,\n    delta\n);\n", w.toString());
  }

  @Test
  public void a_piece_that_is_not_text_is_refused() {
    try {
      new JavaWriter().line("x = ", 5, ";");
      fail("expected ERR_WRITER_UNKNOWN_PIECE");
    } catch (WriterException e) {
      assertEquals(WriterException.UNKNOWN_PIECE, e.code());
      assertTrue(e.getMessage(), e.getMessage().startsWith("ERR_WRITER_UNKNOWN_PIECE: "));
    }
  }

  @Test
  public void a_list_or_array_of_parts_is_concatenated() {
    JavaWriter w = new JavaWriter();
    w.line(List.of("a", "b"), new Object[] {"c", List.of("d")});
    assertEquals("abcd\n", w.toString());
  }

  @Test
  public void a_text_block_is_a_snippet() {
    JavaWriter w = new JavaWriter();
    try (var b = w.block("class A {")) {
      w.text(
          """
          void f() {
            g();
          }
          """);
    }
    assertEquals("class A {\n    void f() {\n      g();\n    }\n}\n", w.toString());
  }

  @Test
  public void a_subclass_can_change_one_layout_step() {
    JavaWriter w =
        new JavaWriter() {
          @Override
          protected void writeImports(CodeWriter section) {
            section.line("// imports are elsewhere");
          }
        };
    w.use("java.util.List");
    w.line("class A {}");
    assertEquals("// imports are elsewhere\n\nclass A {}\n", w.toString());
  }
}
