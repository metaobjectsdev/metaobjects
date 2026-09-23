package com.metaobjects.generator.spring;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import java.io.IOException;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.Assert.assertTrue;

/**
 * Eject proof (a) — every Java generator {@code mvn metaobjects:eject} can copy out of this
 * module compiles, package-renamed, against the PUBLISHED API (this module's own compiled
 * classes plus its declared dependencies — exactly what an adopter's new {@code codegen/}
 * module depends on after eject). See {@code docs/superpowers/specs/
 * 2026-09-22-eject-in-every-port-design.md} (JVM section) and {@code
 * com.metaobjects.generator.GeneratorRegistry}'s {@code ejectPath(...)} calls, whose
 * classnames this list mirrors.
 *
 * <p>This reads straight off {@code src/main/java} rather than through the Maven eject
 * mojo (which lives in a downstream module, {@code maven-plugin}, that depends on THIS one —
 * the reverse dependency direction is not available here) and rewrites the package line the
 * exact same way eject does: the ONE deliberate edit ADR-0034 makes. If the reference
 * generator ever starts using a helper that isn't public, this test fails with the same
 * "cannot find symbol" a real adopter's build would.
 */
public class EjectedGeneratorsCompileTest {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    /** Every stable name codegen-spring ships as an ejectable reference (GeneratorRegistry). */
    private static final List<String> EJECTABLE_SIMPLE_NAMES = List.of(
            "SpringControllerGenerator",
            "SpringOutputParserGenerator",
            "SpringOutputPromptGenerator",
            "SpringRenderHelperGenerator",
            "SpringFilterAllowlistGenerator",
            "SpringRepositoryGenerator",
            "SpringDtoGenerator",
            "SpringValueObjectGenerator",
            "LlmTraceHelperGenerator",
            "SpringNamesGenerator"
    );

    private static final Pattern PACKAGE_LINE = Pattern.compile("(?m)^package\\s+[\\w.]+\\s*;\\s*$");

    private static String rewritePackage(String source, String newPackage) {
        Matcher m = PACKAGE_LINE.matcher(source);
        assertTrue("expected a package line", m.find());
        return new StringBuilder(source).replace(m.start(), m.end(), "package " + newPackage + ";").toString();
    }

    @Test
    public void everyEjectableGeneratorCompilesPackageRenamed() throws IOException {
        Path srcDir = Path.of("src/main/java/com/metaobjects/generator/spring");
        assertTrue("expected " + srcDir.toAbsolutePath() + " to exist", Files.isDirectory(srcDir));

        Path outDir = tempFolder.newFolder("owned").toPath().resolve("com/acme/owned");
        Files.createDirectories(outDir);

        List<File> sources = new ArrayList<>();
        for (String simpleName : EJECTABLE_SIMPLE_NAMES) {
            Path original = srcDir.resolve(simpleName + ".java");
            assertTrue("expected " + original + " to exist", Files.exists(original));
            String rewritten = rewritePackage(
                    Files.readString(original, StandardCharsets.UTF_8), "com.acme.owned");
            Path copy = outDir.resolve(simpleName + ".java");
            Files.writeString(copy, rewritten, StandardCharsets.UTF_8);
            sources.add(copy.toFile());
        }

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        Path classesOut = tempFolder.newFolder("classes").toPath();
        try (StandardJavaFileManager fm = javac.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8)) {
            fm.setLocation(javax.tools.StandardLocation.CLASS_OUTPUT, List.of(classesOut.toFile()));
            Iterable<? extends JavaFileObject> units = fm.getJavaFileObjectsFromFiles(sources);
            List<String> options = List.of("-classpath", System.getProperty("java.class.path"));
            boolean ok = javac.getTask(null, fm, diagnostics, options, null, units).call();

            StringBuilder errs = new StringBuilder();
            for (Diagnostic<? extends JavaFileObject> d : diagnostics.getDiagnostics()) {
                if (d.getKind() == Diagnostic.Kind.ERROR) {
                    errs.append(d.toString()).append('\n');
                }
            }
            assertTrue("ejected+package-renamed generators failed to compile:\n" + errs,
                    ok && errs.length() == 0);
        }
    }
}
