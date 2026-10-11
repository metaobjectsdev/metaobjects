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
 * Each one's copy set (the generator and the classes that hold the rest of its emit)
 * compiles in ONE package of the adopter's, against this module's PUBLISHED API and nothing
 * else, which is what a {@code codegen/} module has after {@code mvn metaobjects:eject}.
 *
 * <p>The sibling of {@code EjectedGeneratorsCompileTest} in {@code codegen-spring}, and it
 * reads {@code src/main/java} for the same reason: the eject mojo lives downstream of this
 * module, where {@code EntityExtractorEjectRoundTripTest} runs the real one. A copy set is
 * closed when this compiles: a class in it that names a same-package class left out of the
 * set, or calls a member of one that is not public, fails here with the "cannot find
 * symbol" an adopter's build would show.</p>
 */
public class EjectedBaseGeneratorsCompileTest {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private static final String REFERENCE_PACKAGE = "com.metaobjects.generator.direct.object";
    private static final String OWNED_PACKAGE = "com.acme.owned";

    /** What eject copies for {@code entity}, as class names under {@link #REFERENCE_PACKAGE}. */
    private static final List<String> ENTITY = List.of(
            "javacode.JavaObjectCodeGenerator",
            "javacode.JavaCodeGenerator",
            "BaseObjectCodeGenerator",
            "BaseObjectCodeWriter",
            "javacode.JavaCodeWriter",
            "javacode.PojoAwareCodeWriter",
            "javacode.ValueObjectCodeWriter");

    /** What eject copies for {@code extractor}. */
    private static final List<String> EXTRACTOR = List.of(
            "javacode.ExtractorCodeGenerator",
            "javacode.JavaCodeWriter",
            "BaseObjectCodeWriter");

    private static final Pattern PACKAGE_LINE = Pattern.compile("(?m)^package\\s+[\\w.]+\\s*;\\s*$");

    private static String simpleName(String className) {
        return className.substring(className.lastIndexOf('.') + 1);
    }

    /** The two edits eject makes: the package line, and imports of the classes copied along. */
    private static String owned(String source, List<String> copySet) {
        Matcher m = PACKAGE_LINE.matcher(source);
        assertTrue("expected a package line", m.find());
        String out = new StringBuilder(source)
                .replace(m.start(), m.end(), "package " + OWNED_PACKAGE + ";").toString();
        for (String className : copySet) {
            out = out.replace("import " + REFERENCE_PACKAGE + "." + className + ";",
                    "import " + OWNED_PACKAGE + "." + simpleName(className) + ";");
        }
        return out;
    }

    private void compilesInOnePackage(String label, List<String> copySet) throws IOException {
        Path srcRoot = Path.of("src/main/java", REFERENCE_PACKAGE.replace('.', '/'));
        Path ownedRoot = tempFolder.newFolder(label).toPath();
        Path outDir = ownedRoot.resolve(OWNED_PACKAGE.replace('.', '/'));
        Files.createDirectories(outDir);

        for (String className : copySet) {
            Path original = srcRoot.resolve(className.replace('.', '/') + ".java");
            assertTrue("expected " + original + " to exist", Files.exists(original));
            Files.writeString(outDir.resolve(simpleName(className) + ".java"),
                    owned(Files.readString(original, StandardCharsets.UTF_8), copySet),
                    StandardCharsets.UTF_8);
        }

        // In-process compile against this module's published API and the test classpath —
        // exactly what an adopter's codegen/ module holds after eject. The shared
        // codegen-base compile helper, which dumps the sources on failure.
        JavaCompileTestSupport.compileGenerated(ownedRoot,
                tempFolder.newFolder(label + "-classes").toPath());
    }

    @Test
    public void entityCompilesWithItsWritersInOneOwnedPackage() throws IOException {
        compilesInOnePackage("entity", ENTITY);
    }

    @Test
    public void extractorCompilesWithItsNamingWriterInOneOwnedPackage() throws IOException {
        compilesInOnePackage("extractor", EXTRACTOR);
    }
}
