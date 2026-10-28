package com.metaobjects.mojo;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.MetaDataException;
import com.metaobjects.config.DependencySet;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * FR-023 — the production build-time path: the same {@code DependencySet.resolve} +
 * {@link MavenLoaderConfiguration#configure} + {@link MetaDataLoader#configure} sequence
 * {@code AbstractMetaDataMojo.createLoader} runs, over a project that imports a shared model through
 * its committed snapshot. The project and snapshot are the shared
 * {@code fixtures/dependency-conformance} corpus case; the load must carry the snapshot, scope the
 * imported package out, and refuse a stale snapshot.
 */
public class MavenLoaderDependenciesTest {

    private static final String CASE = "a-dependency-adds-its-artifact-to-the-resolved-set";

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static Path corpus() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.getParent();
        return dir.resolve("fixtures/dependency-conformance");
    }

    private static void write(Path p, byte[] bytes) throws Exception {
        Files.createDirectories(p.getParent());
        Files.write(p, bytes);
    }

    private Path project(boolean corruptSnapshot) throws Exception {
        JsonObject all = JsonParser.parseString(
                Files.readString(corpus().resolve("cases.json"), StandardCharsets.UTF_8)).getAsJsonObject();
        JsonObject c = null;
        for (JsonElement el : all.getAsJsonArray("cases")) {
            if (CASE.equals(el.getAsJsonObject().get("name").getAsString())) c = el.getAsJsonObject();
        }
        assertTrue("corpus case missing: " + CASE, c != null);
        Path root = tmp.newFolder().toPath();
        for (Map.Entry<String, JsonElement> e : c.getAsJsonObject("tree").entrySet()) {
            write(root.resolve(e.getKey()), e.getValue().getAsString().getBytes(StandardCharsets.UTF_8));
        }
        for (Map.Entry<String, JsonElement> e : c.getAsJsonObject("treeFiles").entrySet()) {
            byte[] bytes = Files.readAllBytes(corpus().resolve(e.getValue().getAsString()));
            if (corruptSnapshot) bytes = (new String(bytes, StandardCharsets.UTF_8) + " ").getBytes(StandardCharsets.UTF_8);
            write(root.resolve(e.getKey()), bytes);
        }
        write(root.resolve(".metaobjects/config.json"), c.getAsJsonObject("config").toString().getBytes(StandardCharsets.UTF_8));
        write(root.resolve(".metaobjects/deps.lock.json"), c.getAsJsonObject("lock").toString().getBytes(StandardCharsets.UTF_8));
        return root;
    }

    private static MetaDataLoader load(Path root) {
        DependencySet dependencies = DependencySet.resolve(root);
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "mojo-path");
        MavenLoaderConfiguration.configure(loader, null, MavenLoaderDependenciesTest.class.getClassLoader(),
                List.of(root.resolve("metaobjects/meta.app.json").toString()), null, dependencies, Map.of());
        dependencies.refuseUnownedPackages(loader.getRoot());
        return loader;
    }

    @Test
    public void theConfiguredLoaderCarriesTheSnapshotAndScopesItOut() throws Exception {
        MetaDataLoader loader = load(project(false));
        Set<String> names = new TreeSet<>();
        for (MetaObject mo : loader.getMetaObjects()) names.add(mo.getName());
        assertTrue("snapshot loaded: " + names, names.contains("acme::common::Customer"));
        assertTrue("own file loaded: " + names, names.contains("app::Order"));
        DependencySet deps = loader.getRoot().getDependencySet();
        assertTrue(deps.imported("acme::common::Customer"));
        assertTrue(deps.inScope("app::Order"));
        assertEquals(false, deps.inScope("acme::common::Customer"));
    }

    @Test
    public void aTamperedSnapshotIsRefusedAsStale() throws Exception {
        MetaDataException e = assertThrows(MetaDataException.class, () -> load(project(true)));
        assertEquals("ERR_DEPENDENCY_SNAPSHOT_STALE", e.getCode().map(Enum::name).orElse("<none>"));
    }

    @Test
    public void anImportedObjectDoesNotCollideWithAnOwnObjectOfTheSameRoute() throws Exception {
        Path root = project(false);
        write(root.resolve("metaobjects/meta.customer.json"),
                ("{\"metadata.root\":{\"package\":\"app\",\"children\":[{\"object.entity\":{\"name\":\"Customer\","
                + "\"children\":[{\"source.rdb\":{\"@table\":\"app_customers\"}},{\"field.long\":{\"name\":\"id\"}},"
                + "{\"identity.primary\":{\"name\":\"pk\",\"@fields\":[\"id\"]}}]}}]}}").getBytes(StandardCharsets.UTF_8));
        DependencySet dependencies = DependencySet.resolve(root);
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "collide");
        MavenLoaderConfiguration.configure(loader, null, MavenLoaderDependenciesTest.class.getClassLoader(),
                List.of(root.resolve("metaobjects/meta.app.json").toString(),
                        root.resolve("metaobjects/meta.customer.json").toString()),
                null, dependencies, Map.of());
        // Everything loaded collides on the `customers` segment; only what generates must not.
        assertThrows(com.metaobjects.generator.GeneratorException.class,
                () -> com.metaobjects.generator.util.RouteNaming.assertNoCollectionNameCollisions(loader.getMetaObjects()));
        com.metaobjects.generator.util.RouteNaming.assertNoCollectionNameCollisions(
                com.metaobjects.generator.util.GeneratorUtil.ownMetaObjects(loader));
    }
}
