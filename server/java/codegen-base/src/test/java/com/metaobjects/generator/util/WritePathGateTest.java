package com.metaobjects.generator.util;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.Test;

/**
 * Every Java and Kotlin generator writes its files through {@link GeneratedFileWriter}.
 *
 * <p>The JVM ports have no shared runner loop: each generator writes its own files. The hash
 * manifest, the hand-edit refusal, the output-path collision check, the in-memory capture that
 * {@code verify} renders through and the unchanged-bytes check all live in that one class, so a
 * generator that opens a file any other way silently loses all five. Nothing but this test stops a
 * new generator doing so.
 *
 * <p>The rule, per scanned source file (comments and string literals removed first):
 *
 * <ul>
 *   <li>No file-writing API at all: {@code Files.write}, {@code Files.writeString},
 *       {@code Files.newBufferedWriter}, {@code Files.newOutputStream}, {@code Files.copy},
 *       {@code Files.createFile}, {@code File.createNewFile}, a {@code FileWriter},
 *       {@code FileOutputStream} or {@code RandomAccessFile}, a {@code PrintWriter} or
 *       {@code PrintStream} opened on a file, and Kotlin's {@code writeText}, {@code writeBytes},
 *       {@code appendText}, {@code outputStream()}, {@code bufferedWriter()} and
 *       {@code printWriter()}.</li>
 *   <li>In a generator module ({@code codegen-*}), no {@link GeneratedFileWriter#writeIfChanged}
 *       either: it skips the manifest. Generators call {@code write} or {@code writeUnmarked}. The
 *       Maven plugin's tool-state files (fingerprint, eject copies, {@code fmt}, {@code init}) are
 *       not generator output and use {@code writeIfChanged}.</li>
 * </ul>
 *
 * <p>The allowlist below names the only files that may break the rule, each with its reason. It
 * only shrinks.
 */
public class WritePathGateTest {

  /** {@code server/java/}: the tests run with the module as the working directory. */
  private static final Path JAVA = Path.of(System.getProperty("user.dir")).resolve("..").normalize();

  /** The modules holding generator source or the Maven goals that run it. */
  static final List<String> SCANNED_MODULES =
      List.of("codegen-base", "codegen-spring", "codegen-plantuml", "codegen-mustache", "codegen-kotlin", "maven-plugin");

  private static final Map<String, String> ALLOWED = new TreeMap<>(Map.of(
      "codegen-base/src/main/java/com/metaobjects/generator/util/GeneratedFileWriter.java",
          "The shared write path itself.",
      "codegen-base/src/main/java/com/metaobjects/generator/util/HashManifest.java",
          "Writes the hash manifest, the write path's own state, comparing bytes before it writes."));

  private static final List<Pattern> FORBIDDEN = List.of(
      Pattern.compile("\\bFiles\\s*\\.\\s*(write|writeString|newBufferedWriter|newOutputStream|copy|createFile)\\s*\\("),
      Pattern.compile("\\.\\s*createNewFile\\s*\\("),
      Pattern.compile("\\b(FileWriter|FileOutputStream|RandomAccessFile)\\s*\\("),
      Pattern.compile("\\b(PrintWriter|PrintStream)\\s*\\(\\s*(new\\s+)?(File|FileOutputStream|FileWriter)\\b"),
      Pattern.compile("\\b(PrintWriter|PrintStream)\\s*\\(\\s*\\w+\\s*\\.\\s*(toFile|getPath|toString)\\s*\\(\\s*\\)\\s*[,)]"),
      Pattern.compile("\\.\\s*(writeText|writeBytes|appendText|appendBytes)\\s*\\("),
      Pattern.compile("\\.\\s*(outputStream|bufferedWriter|printWriter|writer)\\s*\\(\\s*\\)"));

  private static final Pattern MANIFEST_SKIPPING = Pattern.compile("\\bwriteIfChanged\\s*\\(");

  /** Comments, then string and character literals (Java text blocks and Kotlin raw strings too). */
  private static final Pattern NOISE = Pattern.compile(
      "/\\*.*?\\*/|//[^\\n]*|\"\"\".*?\"\"\"|\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])+'", Pattern.DOTALL);

  static String code(String source) {
    Matcher m = NOISE.matcher(source);
    StringBuilder out = new StringBuilder();
    while (m.find()) m.appendReplacement(out, m.group().startsWith("/") ? " " : "\"\"");
    m.appendTail(out);
    return out.toString();
  }

  /** What in {@code source} (a file of {@code module}) writes a file other than through the shared path. */
  static List<String> violations(String module, String source) {
    String code = code(source);
    List<String> found = new ArrayList<>();
    for (Pattern p : FORBIDDEN) {
      Matcher m = p.matcher(code);
      while (m.find()) found.add(m.group().replaceAll("\\s+", ""));
    }
    if (module.startsWith("codegen-")) {
      Matcher m = MANIFEST_SKIPPING.matcher(code);
      while (m.find()) found.add(m.group().replaceAll("\\s+", ""));
    }
    return found;
  }

  // ── the scanner's own cases ─────────────────────────────────────────────────────────

  @Test
  public void catches_each_way_of_writing_a_file() {
    String[] bad = {
      "Files.writeString(p, s);", "Files.write(p, bytes);", "Files.newBufferedWriter(p)", "Files.copy(in, p)",
      "f.createNewFile();", "new FileWriter(f)", "new FileOutputStream(f)", "new PrintWriter(new File(\"x\"))",
      "new PrintWriter(path.toFile())", "file.writeText(src)", "path.toFile().outputStream()", "f.bufferedWriter()",
    };
    for (String b : bad) assertEquals(b, 1, violations("codegen-spring", b).size());
  }

  @Test
  public void passes_the_shared_path_and_in_memory_writers() {
    String[] good = {
      "GeneratedFileWriter.write(out, src);", "GeneratedFileWriter.writeUnmarked(out, src);",
      "new PrintWriter(new StringWriter())", "new PrintWriter(buffer)", "Files.readString(p)", "Files.createDirectories(d)",
      "// Files.writeString(p, s) is what we used to do", "String s = \"Files.writeString(\";",
      "/* new FileWriter(f) */", "val s = \"\"\"\n file.writeText(x)\n\"\"\"",
    };
    for (String g : good) assertEquals(g, List.of(), violations("codegen-spring", g));
  }

  @Test
  public void writeIfChanged_skips_the_manifest_so_only_the_plugin_may_call_it() {
    String call = "GeneratedFileWriter.writeIfChanged(file, text);";
    assertEquals(1, violations("codegen-base", call).size());
    assertEquals(1, violations("codegen-kotlin", call).size());
    assertEquals(List.of(), violations("maven-plugin", call));
  }

  // ── the gate over the real modules ──────────────────────────────────────────────────

  private static Map<String, List<String>> scan() throws IOException {
    Map<String, List<String>> byFile = new TreeMap<>();
    for (String module : SCANNED_MODULES) {
      Path main = JAVA.resolve(module).resolve("src/main");
      assertTrue(main + " is missing: the gate's module list is stale", Files.isDirectory(main));
      try (Stream<Path> files = Files.walk(main)) {
        for (Path f : files.filter(Files::isRegularFile).toList()) {
          String name = f.getFileName().toString();
          if (!name.endsWith(".java") && !name.endsWith(".kt")) continue;
          String rel = JAVA.relativize(f).toString().replace('\\', '/');
          byFile.put(rel, violations(module, Files.readString(f, StandardCharsets.UTF_8)));
        }
      }
    }
    return byFile;
  }

  @Test
  public void every_generator_writes_through_GeneratedFileWriter() throws IOException {
    List<String> offenders = new ArrayList<>();
    scan().forEach((file, found) -> {
      if (!found.isEmpty() && !ALLOWED.containsKey(file)) offenders.add(file + " " + found);
    });
    assertEquals(
        "Write generated files with GeneratedFileWriter.write (or writeUnmarked for output that cannot carry"
            + " the GENERATED marker), so the file is recorded in the hash manifest and unchanged bytes are"
            + " never rewritten.",
        List.of(),
        offenders);
  }

  @Test
  public void every_allowlisted_file_still_needs_its_entry() throws IOException {
    Map<String, List<String>> found = scan();
    List<String> stale = new ArrayList<>();
    for (String file : ALLOWED.keySet()) {
      if (found.getOrDefault(file, List.of()).isEmpty()) stale.add(file);
    }
    assertEquals("these files no longer write directly (or no longer exist): remove their entries", List.of(), stale);
  }
}
