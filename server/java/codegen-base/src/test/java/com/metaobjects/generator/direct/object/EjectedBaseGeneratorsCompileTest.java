package com.metaobjects.generator.direct.object;

import com.metaobjects.generator.util.JavaCompileTestSupport;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.Assert.assertTrue;

/**
 * Eject proof (a) for the two generators this module ships a reference for: {@code entity}
 * ({@code JavaObjectCodeGenerator}) and {@code extractor} ({@code ExtractorCodeGenerator}).
 * Each compiles, package-renamed, against this module's PUBLISHED API and nothing else,
 * which is what an adopter's {@code codegen/} module has after {@code mvn metaobjects:eject}.
 *
 * <p>The sibling of {@code EjectedGeneratorsCompileTest} in {@code codegen-spring}, and it
 * reads {@code src/main/java} for the same reason: the eject mojo lives downstream of this
 * module. If either reference starts using a member that is not public, or a same-package
 * class by its bare name, this fails with the "cannot find symbol" an adopter's build would
 * show. That is how {@code entity} failed before: it called two {@code protected} naming
 * hooks on a writer it did not extend, which only compiles inside the writer's package.</p>
 */
public class EjectedBaseGeneratorsCompileTest {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    /** The simple names this module's pom ships under META-INF/metaobjects/reference/java. */
    private static final List<String> EJECTABLE_SIMPLE_NAMES = List.of(
            "JavaObjectCodeGenerator",
            "ExtractorCodeGenerator"
    );

    private static final Pattern PACKAGE_LINE = Pattern.compile("(?m)^package\\s+[\\w.]+\\s*;\\s*$");

    private static String rewritePackage(String source, String newPackage) {
        Matcher m = PACKAGE_LINE.matcher(source);
        assertTrue("expected a package line", m.find());
        return new StringBuilder(source).replace(m.start(), m.end(), "package " + newPackage + ";").toString();
    }

    @Test
    public void entityAndExtractorCompilePackageRenamed() throws IOException {
        Path srcDir = Path.of("src/main/java/com/metaobjects/generator/direct/object/javacode");
        assertTrue("expected " + srcDir.toAbsolutePath() + " to exist", Files.isDirectory(srcDir));

        Path ownedRoot = tempFolder.newFolder("owned").toPath();
        Path outDir = ownedRoot.resolve("com/acme/owned");
        Files.createDirectories(outDir);

        for (String simpleName : EJECTABLE_SIMPLE_NAMES) {
            Path original = srcDir.resolve(simpleName + ".java");
            assertTrue("expected " + original + " to exist", Files.exists(original));
            String rewritten = rewritePackage(
                    Files.readString(original, StandardCharsets.UTF_8), "com.acme.owned");
            Files.writeString(outDir.resolve(simpleName + ".java"), rewritten,
                    StandardCharsets.UTF_8);
        }

        // In-process compile against this module's published API and the test classpath —
        // exactly what an adopter's codegen/ module holds after eject. The shared
        // codegen-base compile helper, which dumps the sources on failure.
        JavaCompileTestSupport.compileGenerated(ownedRoot,
                tempFolder.newFolder("classes").toPath());
    }
}
