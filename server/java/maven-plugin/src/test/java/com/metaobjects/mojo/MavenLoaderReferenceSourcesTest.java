package com.metaobjects.mojo;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.MetaDataException;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * The production build-time path for {@code <loader><referenceSources>}: the same
 * {@link MavenLoaderConfiguration#configure} + {@link MetaDataLoader#configure} sequence
 * {@code AbstractMetaDataMojo.createLoader} runs. The reference files load into the one model, the
 * nodes only they declare are the reference nodes, and a template declared only there is refused.
 * The tree is the shared {@code fixtures/reference-source-conformance} corpus.
 */
public class MavenLoaderReferenceSourcesTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static Path corpus() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.getParent();
        return dir.resolve("fixtures/reference-source-conformance/cases.json");
    }

    private Path project(String caseName) throws Exception {
        JsonObject all = JsonParser.parseString(Files.readString(corpus(), StandardCharsets.UTF_8)).getAsJsonObject();
        JsonObject c = null;
        for (JsonElement el : all.getAsJsonArray("cases")) {
            if (caseName.equals(el.getAsJsonObject().get("name").getAsString())) c = el.getAsJsonObject();
        }
        assertTrue("corpus case missing: " + caseName, c != null);
        Path root = tmp.newFolder().toPath();
        for (Map.Entry<String, JsonElement> e : c.getAsJsonObject("tree").entrySet()) {
            Path p = root.resolve(e.getKey());
            Files.createDirectories(p.getParent());
            Files.writeString(p, e.getValue().getAsString(), StandardCharsets.UTF_8);
        }
        return root;
    }

    private static MetaDataLoader load(Path root) {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "mojo-reference");
        MavenLoaderConfiguration.configure(loader, null, MavenLoaderReferenceSourcesTest.class.getClassLoader(),
                List.of(root.resolve("model/meta.prompts.json").toString()),
                List.of(root.resolve("replies/meta.replies.json").toString()),
                null, null, Map.of());
        return loader;
    }

    @Test
    public void referenceSourcesLoadIntoTheModelAndTheirNodesAreReferenceNodes() throws Exception {
        MetaDataLoader loader = load(project("reply-type-in-a-reference-source-resolves-and-is-not-generated"));
        assertTrue("loader errors: " + loader.getErrors(), loader.getErrors().isEmpty());
        assertEquals(Set.of("acme::support::SupportAnswer", "acme::support::AnswerSource"),
                loader.getRoot().getReferenceNodes());
    }

    @Test
    public void aTemplateDeclaredOnlyInAReferenceSourceIsRefused() throws Exception {
        Path project = project("a-template-in-a-reference-source-is-refused");
        // Refused by the load itself, so every Java entry point refuses it; init() may wrap it.
        Throwable t = assertThrows(RuntimeException.class, () -> load(project));
        String code = "<none>";
        for (; t != null; t = t.getCause()) {
            if (t instanceof MetaDataException m && m.getCode().isPresent()) { code = m.getCode().get().name(); break; }
        }
        assertEquals("ERR_REFERENCE_SOURCE_TEMPLATE", code);
    }
}
