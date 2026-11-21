package com.metaobjects.mojo;

import org.apache.maven.execution.MavenSession;
import org.apache.maven.plugin.AbstractMojo;
import org.apache.maven.plugin.MojoExecution;
import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.Parameter;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * {@code mvn metaobjects:init} — start a project (ADR-0034 Amendment 2: codegen is opt-in, so a
 * scaffold wires NO generator).
 *
 * <p>It writes the port-neutral {@code .metaobjects/config.json} (the same new-project settings
 * {@code meta init} and {@code metaobjects init} write: a page size on every generated list route,
 * {@code api.unknownFields: reject}, {@code verify.handEdits: fail} and
 * {@code migrate.foreignKeyIndexes: true}) and an empty, loadable {@code metaobjects/meta.app.json}
 * to author into. It never overwrites a file it finds: it says it kept it, so re-running it on a
 * project that has them changes nothing.</p>
 *
 * <p>The generator list of a Maven project is the {@code <generators>} element of the plugin in the
 * pom, which is the project's own file; this goal never edits it. It prints the plugin entry to add
 * instead, with an empty {@code <generators/>}. {@code -Dmeta.init.withDocs=true} is the opt-in:
 * the printed entry then lists the api reference generator ({@code JavaApiDocsGenerator}) as well,
 * and without the flag no documentation generator is wired. Nothing writes code or docs until the
 * pom lists a generator ({@code mvn metaobjects:generate --list} shows the catalog).</p>
 */
@Mojo(name = "init", threadSafe = true)
public class InitMojo extends AbstractMojo {

    /** The default page size of a generated list route, as {@code meta init} writes it. */
    static final int DEFAULT_LIMIT = 50;

    /** The largest page a client may ask a generated list route for, as {@code meta init} writes it. */
    static final int MAX_LIMIT = 1000;

    static final String CONFIG = ".metaobjects/config.json";
    static final String METADATA = "metaobjects/meta.app.json";

    /** A loadable model with no entities in it. */
    static final String EMPTY_METADATA = "{\n  \"metadata.root\": {\n    \"package\": \"app\",\n    \"children\": []\n  }\n}\n";

    /** The port-neutral config a new project starts with; identical to what every other port's init writes. */
    static final String NEUTRAL_CONFIG =
        "{\n"
        + "  \"schema_version\": 1,\n"
        + "  \"migrate\": {\n    \"foreignKeyIndexes\": true\n  },\n"
        + "  \"verify\": {\n    \"handEdits\": \"fail\"\n  },\n"
        + "  \"api\": {\n"
        + "    \"pagination\": {\n      \"defaultLimit\": " + DEFAULT_LIMIT + ",\n      \"maxLimit\": " + MAX_LIMIT + "\n    },\n"
        + "    \"unknownFields\": \"reject\"\n"
        + "  }\n"
        + "}\n";

    /** {@code -Dmeta.init.withDocs=true} — list the api reference generator in the printed plugin entry. */
    @Parameter(property = "meta.init.withDocs", defaultValue = "false")
    boolean withDocs;

    @Parameter(defaultValue = "${project.basedir}", readonly = true)
    File baseDir;

    @Parameter(defaultValue = "${mojoExecution}", readonly = true)
    MojoExecution execution;

    @Parameter(defaultValue = "${session}", readonly = true)
    MavenSession session;

    /** What a scaffold did: the files it wrote and the ones it kept, project-relative. */
    record Result(List<String> wrote, List<String> kept) {}

    @Override
    public void execute() throws MojoExecutionException {
        Path root = (baseDir != null ? baseDir : new File(System.getProperty("user.dir"))).toPath();
        Result result;
        try {
            result = scaffold(root);
        } catch (IOException e) {
            throw new MojoExecutionException("metaobjects:init could not write the scaffold: " + e.getMessage(), e);
        }
        for (String rel : result.wrote()) getLog().info("wrote " + rel);
        for (String rel : result.kept()) getLog().info("kept " + rel + " (already exists)");
        getLog().info("Add this to the <build><plugins> of your pom.xml (init never edits it):\n"
            + pluginEntry(pluginVersion(), withDocs));
        getLog().info("next: describe your entities in metaobjects/, list the generators you want, then run "
            + "`mvn metaobjects:generate`.");
    }

    /** Write the two scaffold files under {@code root}, each only when it is missing. */
    static Result scaffold(Path root) throws IOException {
        List<String> wrote = new ArrayList<>();
        List<String> kept = new ArrayList<>();
        String[][] files = {{CONFIG, NEUTRAL_CONFIG}, {METADATA, EMPTY_METADATA}};
        for (String[] f : files) {
            Path path = root.resolve(f[0]);
            if (Files.exists(path)) {
                kept.add(f[0]);
                continue;
            }
            Files.createDirectories(path.getParent());
            Files.writeString(path, f[1], StandardCharsets.UTF_8);
            wrote.add(f[0]);
        }
        return new Result(wrote, kept);
    }

    /**
     * The plugin entry to add to the pom: an EMPTY generator list, or with {@code withDocs} the api
     * reference generator in it. {@code version} is the running plugin's, or a property placeholder
     * when it is not known.
     */
    static String pluginEntry(String version, boolean withDocs) {
        String generators = withDocs
            ? "        <generators>\n"
                + "          <generator>\n"
                + "            <classname>com.metaobjects.generator.apidocs.JavaApiDocsGenerator</classname>\n"
                + "            <args>\n"
                + "              <outputDir>docs</outputDir>\n"
                + "            </args>\n"
                + "          </generator>\n"
                + "        </generators>\n"
            : "        <generators/>\n";
        return "    <plugin>\n"
            + "      <groupId>com.metaobjects</groupId>\n"
            + "      <artifactId>metaobjects-maven-plugin</artifactId>\n"
            + "      <version>" + version + "</version>\n"
            + "      <configuration>\n"
            + generators
            + "      </configuration>\n"
            + "    </plugin>";
    }

    private String pluginVersion() {
        try {
            if (execution != null && execution.getPlugin() != null && execution.getPlugin().getVersion() != null) {
                return execution.getPlugin().getVersion();
            }
        } catch (RuntimeException ignored) {
            // fall through to the placeholder
        }
        return "${metaobjects.version}";
    }
}
