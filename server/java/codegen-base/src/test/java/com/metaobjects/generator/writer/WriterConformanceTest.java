package com.metaobjects.generator.writer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

/**
 * Runs {@code fixtures/writer-conformance/} against the Java writer (spec/code-writer.md).
 * {@code core} cases run on {@link CodeWriter} with the options the case states; {@code java}
 * cases run on {@link JavaWriter} with its own defaults unless the case overrides them. A case
 * of another dialect belongs to that port's writer and is skipped here by name.
 */
@RunWith(Parameterized.class)
public class WriterConformanceTest {

  private static final String CORE = "core";
  private static final String JAVA = "java";

  private static Path cases() {
    return Path.of(System.getProperty("user.dir"))
        .resolve("../../../fixtures/writer-conformance/cases")
        .normalize();
  }

  @Parameterized.Parameters(name = "{0}")
  public static List<Object[]> corpus() throws IOException {
    List<Object[]> out = new ArrayList<>();
    try (Stream<Path> files = Files.list(cases())) {
      for (Path f : files.filter(p -> p.toString().endsWith(".json")).sorted().toList()) {
        JsonObject c = new Gson().fromJson(Files.readString(f), JsonObject.class);
        String dialect = c.get("dialect").getAsString();
        if (dialect.equals(CORE) || dialect.equals(JAVA)) {
          out.add(new Object[] {f.getFileName().toString().replaceFirst("\\.json$", ""), c});
        }
      }
    }
    return out;
  }

  private final JsonObject c;

  public WriterConformanceTest(String name, JsonObject c) {
    this.c = c;
  }

  @Test
  public void case_matches_expected_output() {
    boolean core = c.get("dialect").getAsString().equals(CORE);
    if (core) assertNotNull("a core case states its options", c.get("options"));
    if (c.has("error")) {
      try {
        run(core);
      } catch (WriterException e) {
        assertEquals(c.get("error").getAsString(), e.code());
        if (c.has("errorQuotes")) assertTrue(e.getMessage(), e.getMessage().contains(c.get("errorQuotes").getAsString()));
        return;
      }
      fail("expected " + c.get("error").getAsString());
    }
    List<String> lines = new ArrayList<>();
    for (JsonElement l : c.getAsJsonArray("expected")) lines.add(l.getAsString());
    assertEquals(lines.isEmpty() ? "" : String.join("\n", lines) + "\n", run(core));
  }

  private String run(boolean core) {
    CodeWriter base = core ? new CodeWriter(options()) : new JavaWriter(options());
    for (JsonElement e : c.getAsJsonArray("ops")) {
      JsonArray op = e.getAsJsonArray();
      String name = op.get(0).getAsString();
      List<Object> args = new ArrayList<>();
      for (int i = 1; i < op.size(); i++) args.add(piece(op.get(i)));
      switch (name) {
        case "line" -> base.line(args.toArray());
        case "open" -> base.open(args.toArray());
        case "close" -> base.close(args.toArray());
        case "blank" -> base.blank();
        case "text" -> base.text((String) args.get(0));
        default -> {
          if (!(base instanceof JavaWriter w)) throw new IllegalStateException("op " + name + " is not a core op");
          String[] s = args.stream().map(String.class::cast).toArray(String[]::new);
          switch (name) {
            case "use" -> w.use(s[0]);
            case "useStatic" -> w.useStatic(s[0]);
            case "package" -> w.packageName(s[0]);
            case "header" -> w.header(s);
            case "doc" -> w.doc(s);
            default -> throw new IllegalStateException("unknown op " + name);
          }
        }
      }
    }
    return base.toString();
  }

  /** The case's options laid over the dialect's defaults (core states all three). */
  private WriterOptions options() {
    WriterOptions o = c.get("dialect").getAsString().equals(CORE) ? new WriterOptions("  ", 120, true) : WriterOptions.JAVA;
    if (!c.has("options")) return o;
    JsonObject given = c.getAsJsonObject("options");
    if (given.has("indent")) o = o.withIndent(given.get("indent").getAsString());
    if (given.has("width")) o = o.withWidth(given.get("width").getAsInt());
    if (given.has("trailingComma")) o = o.withTrailingComma(given.get("trailingComma").getAsBoolean());
    return o;
  }

  private static Object piece(JsonElement p) {
    if (p.isJsonPrimitive()) return p.getAsString();
    if (p.isJsonArray()) {
      List<Object> parts = new ArrayList<>();
      for (JsonElement x : p.getAsJsonArray()) parts.add(piece(x));
      return parts;
    }
    JsonObject l = p.getAsJsonObject().getAsJsonObject("list");
    List<Object> items = new ArrayList<>();
    for (JsonElement x : l.getAsJsonArray("items")) items.add(piece(x));
    boolean pad = l.has("pad") && l.get("pad").getAsBoolean();
    return new Group(l.get("open").getAsString(), items, l.get("close").getAsString(), pad);
  }
}
