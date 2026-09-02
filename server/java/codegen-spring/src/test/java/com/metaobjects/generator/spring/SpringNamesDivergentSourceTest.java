package com.metaobjects.generator.spring;

import com.metaobjects.generator.GeneratorException;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.source.MetaSource;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * {@code SpringNamesGenerator.resolveObjectNames} refuses an object whose
 * {@code @role: primary} sources disagree on a physical name — in BOTH directions.
 *
 * <p>{@code ValidateOnePrimarySource} enforces "exactly one primary" over OWN children
 * only, and effective-children shadowing matches an own child over a super child only on
 * a {@code (type, name)} pair — so two {@code source.rdb} nodes with DIFFERENT explicit
 * names at two levels of an {@code extends} chain never collide, and both survive the
 * resolving source walk. Each fixture loads with zero errors (the fixture loader throws
 * otherwise), so a guard test whose model the loader would reject cannot hide here.</p>
 *
 * <p><b>Direction 1</b> is what the old check could see: the inherited primary is
 * READ-ONLY, so {@code findPrimaryWritableSource} skipped it and matched the child's, and
 * the two disagreed. <b>Direction 2</b> is what it could not: both primaries are WRITABLE,
 * so both selectors landed on the same inherited node, agreed, and the guard stayed silent
 * while every artifact bound the parent's table over the child's own declaration.</p>
 *
 * <p>This also retires the claim the port carried in a comment — that no loadable JVM
 * model reaches this throw. It reasoned from {@code object.base} (which the JVM genuinely
 * cannot instantiate) and generalised; neither fixture here needs it.</p>
 */
public class SpringNamesDivergentSourceTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    // Direction 1: an object.entity may not carry a read-only primary
    // (ERR_ENTITY_PRIMARY_SOURCE_READONLY), so the read-only half is an abstract
    // object.projection. An ENTITY extending one is legal — only a PROJECTION is
    // restricted to extending projections.
    private static final String READ_ONLY_INHERITED = """
        { "metadata.root": { "package": "acme::demo", "children": [
          { "object.entity": { "name": "Base", "children": [
              { "source.rdb": { "name": "s", "@table": "bases" } },
              { "field.long": { "name": "id" } },
              { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ] } },
          { "object.projection": { "name": "ParentWeird", "abstract": true, "children": [
              { "source.rdb": { "name": "viewSrc", "@kind": "view", "@view": "v_parent" } },
              { "field.long": { "name": "id", "extends": "Base.id" } }
          ] } },
          { "object.entity": { "name": "ChildWeird", "extends": "ParentWeird", "children": [
              { "source.rdb": { "name": "tableSrc", "@table": "child_table" } },
              { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ] } }
        ] } }
        """;

    // Direction 2: nothing exotic — two plain entities, each naming its own table.
    private static final String BOTH_WRITABLE = """
        { "metadata.root": { "package": "acme::demo", "children": [
          { "object.entity": { "name": "ParentWeird", "abstract": true, "children": [
              { "source.rdb": { "name": "parentSrc", "@table": "parent_table" } },
              { "field.long": { "name": "id" } }
          ] } },
          { "object.entity": { "name": "ChildWeird", "extends": "ParentWeird", "children": [
              { "source.rdb": { "name": "childSrc", "@table": "child_table" } },
              { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ] } }
        ] } }
        """;

    private MetaObject childOf(String fixture, String baseName, String childName) throws IOException {
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.getRoot().toPath(), baseName, fixture);
        for (MetaObject o : loader.getMetaObjects()) {
            if (o.getName().endsWith("::" + childName)) return o;
        }
        throw new AssertionError("fixture did not declare " + childName);
    }

    private void assertRefused(String fixture, String baseName, String otherName) throws IOException {
        MetaObject child = childOf(fixture, baseName, "ChildWeird");

        // Pin the reachability MECHANISM: both sources survive the child merge. If one
        // shadowed the other there would be no divergence and this would pass vacuously.
        List<String> primaries = new ArrayList<>();
        for (MetaSource s : child.getSources(true)) {
            if (MetaSource.ROLE_PRIMARY.equals(s.getRole())) primaries.add(s.getPhysicalName());
        }
        Collections.sort(primaries);
        List<String> expected = new ArrayList<>(List.of(otherName, "child_table"));
        Collections.sort(expected);
        assertEquals(expected, primaries);

        try {
            SpringNamesGenerator.resolveObjectNames(child, "literal");
            fail("expected a GeneratorException naming both physical names");
        } catch (GeneratorException e) {
            // Each substring asserted separately, so a message dropping one still fails.
            assertTrue(e.getMessage(), e.getMessage().contains("ChildWeird"));
            assertTrue(e.getMessage(), e.getMessage().contains(otherName));
            assertTrue(e.getMessage(), e.getMessage().contains("child_table"));
        }
    }

    @Test
    public void direction1_readOnlyInheritedPrimaryBesideWritableOwnPrimaryIsRefused() throws IOException {
        assertRefused(READ_ONLY_INHERITED, "divergent-ro", "v_parent");
    }

    @Test
    public void direction2_twoWritablePrimariesDisagreeingOnATableNameIsRefused() throws IOException {
        assertRefused(BOTH_WRITABLE, "divergent-w", "parent_table");
    }

    @Test
    public void twoPrimariesAgreeingOnAPhysicalNameAreNotRefused() throws IOException {
        // The guard is about DISAGREEMENT, not about the count. Refusing two primaries
        // that name the same relation would make it stricter than the invariant it
        // protects: an object has ONE physical name, not one source declaration.
        String fixture = """
            { "metadata.root": { "package": "acme::demo", "children": [
              { "object.entity": { "name": "ParentSame", "abstract": true, "children": [
                  { "source.rdb": { "name": "parentSrc", "@table": "same_table" } },
                  { "field.long": { "name": "id" } }
              ] } },
              { "object.entity": { "name": "ChildSame", "extends": "ParentSame", "children": [
                  { "source.rdb": { "name": "childSrc", "@table": "same_table" } },
                  { "identity.primary": { "name": "pk", "@fields": ["id"] } }
              ] } }
            ] } }
            """;
        // Asserted through the EMITTED artifact rather than the resolver's private record:
        // a run that resolves cleanly but emits the wrong constant would be the same bug.
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
                tmp.getRoot().toPath(), "divergent-same", fixture);
        Path outDir = tmp.newFolder("same-out").toPath();
        SpringNamesGenerator gen = new SpringNamesGenerator();
        gen.setArgs(Map.of("outputDir", outDir.toString()));
        gen.execute(loader);

        Path emitted = outDir.resolve("acme/demo/ChildSameNames.java");
        assertTrue("expected " + emitted, Files.exists(emitted));
        assertTrue(Files.readString(emitted).contains("\"same_table\""));
    }
}
