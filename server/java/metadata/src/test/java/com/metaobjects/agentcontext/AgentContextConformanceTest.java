package com.metaobjects.agentcontext;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Cross-port agent-context conformance — the BYTE-IDENTITY gate.
 *
 * <p>For each {@code fixtures/agent-context-conformance/<stack>/} corpus case,
 * assemble the consumer files against the repo-root {@code agent-context/} content
 * tree and assert the output is byte-identical to the committed
 * {@code expected/<path>} goldens — same set of paths AND same bytes per file. The
 * goldens are produced by the TypeScript reference assembler; passing this proves
 * the Java port reproduces it exactly.
 *
 * <p>Mirrors the Python reference test
 * {@code server/python/tests/conformance/test_agent_context_conformance.py} and the
 * repo-root walk-up pattern of the render module's conformance harnesses.
 */
@RunWith(Parameterized.class)
public class AgentContextConformanceTest {

    private static final Path REPO_ROOT;
    private static final Path CORPUS;
    private static final Path CONTENT_ROOT;

    static {
        Path p = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        while (p != null
                && !(Files.isDirectory(p.resolve("fixtures/agent-context-conformance"))
                && Files.isDirectory(p.resolve("agent-context")))) {
            p = p.getParent();
        }
        REPO_ROOT = p;
        CORPUS = p == null ? null : p.resolve("fixtures/agent-context-conformance");
        CONTENT_ROOT = p == null ? null : p.resolve("agent-context");
    }

    @Parameterized.Parameters(name = "{0}")
    public static List<Object[]> stacks() throws IOException {
        if (CORPUS == null || !Files.isDirectory(CORPUS)) {
            return List.of();
        }
        try (Stream<Path> s = Files.list(CORPUS)) {
            return s.filter(Files::isDirectory)
                    .filter(d -> Files.isRegularFile(d.resolve("stack.json")))
                    .sorted()
                    .map(d -> new Object[]{d.getFileName().toString(), d})
                    .collect(Collectors.toList());
        }
    }

    private final String stackName;
    private final Path caseDir;

    public AgentContextConformanceTest(String stackName, Path caseDir) {
        this.stackName = stackName;
        this.caseDir = caseDir;
    }

    private static List<String> jsonStrings(JsonObject obj, String key) {
        List<String> out = new ArrayList<>();
        JsonElement el = obj.get(key);
        if (el != null && el.isJsonArray()) {
            JsonArray arr = el.getAsJsonArray();
            for (JsonElement e : arr) {
                out.add(e.getAsString());
            }
        }
        return out;
    }

    private static Map<String, byte[]> collectExpected(Path expectedDir) {
        Map<String, byte[]> out = new TreeMap<>();
        try (Stream<Path> s = Files.walk(expectedDir)) {
            s.filter(Files::isRegularFile).forEach(p -> {
                String rel = expectedDir.relativize(p).toString().replace('\\', '/');
                try {
                    out.put(rel, Files.readAllBytes(p));
                } catch (IOException e) {
                    throw new UncheckedIOException(e);
                }
            });
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return out;
    }

    @Test
    public void byteIdentical() throws IOException {
        assertTrue("could not locate repo root (fixtures + agent-context)", REPO_ROOT != null);

        JsonObject spec = JsonParser.parseString(
                new String(Files.readAllBytes(caseDir.resolve("stack.json")), StandardCharsets.UTF_8))
                .getAsJsonObject();
        Stack stack = Stack.of(jsonStrings(spec, "servers"), jsonStrings(spec, "clients"));

        Map<String, byte[]> produced = new LinkedHashMap<>();
        for (AssembledFile f : AgentContextAssembler.assemble(CONTENT_ROOT, stack)) {
            produced.put(f.path(), f.contents().getBytes(StandardCharsets.UTF_8));
        }
        Map<String, byte[]> expected = collectExpected(caseDir.resolve("expected"));

        assertEquals(
                "[" + stackName + "] path set mismatch",
                new java.util.TreeSet<>(expected.keySet()),
                new java.util.TreeSet<>(produced.keySet()));

        for (String path : new java.util.TreeSet<>(expected.keySet())) {
            assertArrayEquals(
                    "[" + stackName + "] byte mismatch at " + path,
                    expected.get(path),
                    produced.get(path));
        }
    }
}
