package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Open-for-extension contract for the Spring generators.
 *
 * <p>The base generators hide their per-entity emission logic behind granular
 * {@code protected} template methods ({@code emit}, {@code writeJavaFile},
 * {@code componentType}, …). An adopter must be able to subclass a generator and
 * override one of those steps to alter the emitted output <em>without forking</em>
 * the generator. This test pins that contract on {@link SpringDtoGenerator}:
 *
 * <ul>
 *   <li>A subclass overriding {@link SpringDtoGenerator#writeJavaFile} (a now-{@code
 *       protected} emit step) changes the emitted file as expected.</li>
 *   <li>The stock {@link SpringDtoGenerator} — same fixture, same args — emits the
 *       unmodified, byte-for-byte-default output (no marker leaks in).</li>
 * </ul>
 *
 * If any of these emit steps regress back to {@code private}, this test stops
 * compiling — that's the regression guard.
 */
public class SpringDtoGeneratorExtensibilityTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private static final String AUTHOR_FIXTURE = """
        {
          "metadata.root": { "package": "acme::blog", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long":      { "name": "id" } },
                { "field.string":    { "name": "name", "@maxLength": 100, "@required": true } },
                { "source.rdb":      { "@table": "authors" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }
        """;

    private static final String MARKER = "// CUSTOM-ADOPTER-HEADER";

    /**
     * An adopter subclass that overrides the granular {@code writeJavaFile} emit
     * step (now {@code protected}) to prepend a banner before delegating to the
     * stock body-writer. This is the override that forking would otherwise force.
     */
    private static final class BannerDtoGenerator extends SpringDtoGenerator {
        @Override
        protected void writeJavaFile(MetaObject entity, Path outRoot, String pkg, String typeName, String body) {
            super.writeJavaFile(entity, outRoot, pkg, typeName, MARKER + "\n" + body);
        }
    }

    @Test
    public void subclassOverrideOfProtectedEmitStepChangesOutput() throws Exception {
        Path outDir = tempFolder.newFolder("dto-override").toPath();
        Path workspace = tempFolder.newFolder("dto-override-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "author-override", AUTHOR_FIXTURE);

        BannerDtoGenerator gen = new BannerDtoGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        Path dto = outDir.resolve("acme/blog/AuthorDto.java");
        assertTrue("expected AuthorDto.java at " + dto, Files.exists(dto));
        String src = Files.readString(dto);

        // The override took effect: the adopter banner leads the file.
        assertTrue("expected adopter marker injected by the override; saw:\n" + src,
            src.startsWith(MARKER));
        // The override delegated to super — the default record body is intact.
        assertTrue("expected default record body preserved under the override; saw:\n" + src,
            src.contains("public record AuthorDto("));
    }

    @Test
    public void stockGeneratorOutputIsUnchangedByTheOverridePoint() throws Exception {
        Path outDir = tempFolder.newFolder("dto-stock").toPath();
        Path workspace = tempFolder.newFolder("dto-stock-fx").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(workspace, "author-stock", AUTHOR_FIXTURE);

        SpringDtoGenerator gen = new SpringDtoGenerator();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        gen.setArgs(args);
        gen.execute(loader);

        String src = Files.readString(outDir.resolve("acme/blog/AuthorDto.java"));
        // The base generator never carries the adopter marker — making the emit
        // step overridable did not change its default output.
        assertFalse("stock generator must not carry the adopter marker; saw:\n" + src,
            src.contains(MARKER));
        assertTrue("expected stock default record; saw:\n" + src,
            src.contains("public record AuthorDto("));
    }
}
