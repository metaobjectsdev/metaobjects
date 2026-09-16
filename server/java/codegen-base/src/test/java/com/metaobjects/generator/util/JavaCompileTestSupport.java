package com.metaobjects.generator.util;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Compile every {@code .java} under a directory in-process against the test classpath,
 * failing with the diagnostics AND a full source dump when it does not succeed.
 *
 * <p>Mirrors {@code SpringTestFixtures.compileGenerated} in {@code codegen-spring}, which
 * ended the same problem there: several test classes in this module had each hand-rolled
 * this block, and every new copy re-diverged (a dropped source dump, a different charset).
 * New compile-the-emit tests in {@code codegen-base} should call this instead of re-writing
 * the {@code ToolProvider}/{@code DiagnosticCollector} boilerplate.
 */
public final class JavaCompileTestSupport {

    private JavaCompileTestSupport() { /* no instances */ }

    /**
     * @param genRoot    directory the generators wrote into
     * @param classesDir a fresh directory for {@code javac} output
     */
    public static void compileGenerated(Path genRoot, Path classesDir) throws IOException {
        List<File> sources;
        try (Stream<Path> walk = Files.walk(genRoot)) {
            sources = walk.filter(f -> f.toString().endsWith(".java"))
                          .map(Path::toFile)
                          .collect(Collectors.toList());
        }
        if (sources.isEmpty()) {
            throw new AssertionError("expected generated .java files under " + genRoot);
        }

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        if (javac == null) {
            throw new AssertionError("JDK (not JRE) required — getSystemJavaCompiler() returned null");
        }
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        StandardJavaFileManager fm = javac.getStandardFileManager(diags, null, null);
        List<String> opts = List.of(
            "-classpath", System.getProperty("java.class.path"),
            "-d", classesDir.toString());

        if (javac.getTask(null, fm, diags, opts, null,
                fm.getJavaFileObjectsFromFiles(sources)).call()) {
            return;
        }
        StringBuilder sb = new StringBuilder("generated sources failed to compile:\n");
        for (Diagnostic<? extends JavaFileObject> d : diags.getDiagnostics()) {
            sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null)).append('\n');
            if (d.getSource() != null) {
                sb.append("    at ").append(d.getSource().getName())
                  .append(':').append(d.getLineNumber()).append('\n');
            }
        }
        for (File f : sources) {
            sb.append("\n=== ").append(f.getName()).append(" ===\n")
              .append(Files.readString(f.toPath())).append('\n');
        }
        throw new AssertionError(sb.toString());
    }
}
