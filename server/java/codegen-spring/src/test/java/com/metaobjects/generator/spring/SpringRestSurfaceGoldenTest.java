package com.metaobjects.generator.spring;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/**
 * The REST surface of the Spring generators, pinned byte for byte (W-JV-2).
 *
 * <p>{@code SpringControllerGenerator}, {@code SpringRepositoryGenerator},
 * {@code SpringNamesGenerator} and {@code SpringReportExportGenerator} run over
 * {@code golden/spring-rest-surface/input/meta.json}: entities with an enum, a decimal, a date, a
 * to-one reference and a many-to-many through entity, a read-only projection and a served report.
 * Every emitted file must equal its counterpart under {@code golden/spring-rest-surface/expected/}.
 *
 * <p>Why it exists: moving these generators onto the code writer (ADR-0063) changes how they lay
 * text out, and until now the Spring module had byte-exact files for DTOs only. The expected files
 * are the generators' output as they stood before any conversion. A conversion PR changes them on
 * purpose, and its description lists what moved and why; a change nobody meant shows up here as a
 * diff against a named file.
 *
 * <p>To rewrite the expected files after an intended change, run this test with
 * {@code -Dgolden.update=true} and review the diff.
 */
public class SpringRestSurfaceGoldenTest extends SharedRegistryTestBase {

  private static final Path GOLDEN = Path.of("src/test/resources/golden/spring-rest-surface");
  private static final String UPDATE = "golden.update";

  @Rule public TemporaryFolder tmp = new TemporaryFolder();

  private static Map<String, String> filesUnder(Path root) throws IOException {
    Map<String, String> files = new TreeMap<>();
    if (!Files.isDirectory(root)) return files;
    try (Stream<Path> walk = Files.walk(root)) {
      for (Path p : walk.filter(Files::isRegularFile).toList()) {
        files.put(root.relativize(p).toString().replace('\\', '/'), Files.readString(p, StandardCharsets.UTF_8));
      }
    }
    return files;
  }

  @Test
  public void theRestSurfaceRegeneratesByteIdentical() throws Exception {
    MetaDataLoader loader =
        SpringTestFixtures.loadFixture(
            tmp.newFolder().toPath(),
            "restSurface",
            Files.readString(GOLDEN.resolve("input/meta.json"), StandardCharsets.UTF_8));
    Path out = tmp.newFolder().toPath();
    Map<String, String> args = new HashMap<>();
    args.put("outputDir", out.toString());
    for (var generator :
        List.of(
            new SpringControllerGenerator(),
            new SpringRepositoryGenerator(),
            new SpringNamesGenerator(),
            new SpringReportExportGenerator())) {
      generator.setArgs(args);
      generator.execute(loader);
    }

    Map<String, String> actual = filesUnder(out);
    if (Boolean.getBoolean(UPDATE)) {
      Path expectedDir = GOLDEN.resolve("expected");
      if (Files.isDirectory(expectedDir)) {
        try (Stream<Path> walk = Files.walk(expectedDir)) {
          for (Path p : walk.sorted(java.util.Comparator.reverseOrder()).filter(Files::isRegularFile).toList()) Files.delete(p);
        }
      }
      for (Map.Entry<String, String> e : actual.entrySet()) {
        Path target = expectedDir.resolve(e.getKey());
        Files.createDirectories(target.getParent());
        Files.writeString(target, e.getValue(), StandardCharsets.UTF_8);
      }
    }

    Map<String, String> expected = filesUnder(GOLDEN.resolve("expected"));
    assertFalse("the golden tree must not be empty", expected.isEmpty());
    assertEquals("the generated file set must match the golden tree", expected.keySet(), actual.keySet());
    for (Map.Entry<String, String> e : expected.entrySet()) {
      assertEquals(e.getKey() + " must be byte-identical to the golden file", e.getValue(), actual.get(e.getKey()));
    }
  }
}
