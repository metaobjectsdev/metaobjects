package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * #271 — a projection with NO {@code source.*} anywhere in its super chain is not
 * backed by any store, so the DB-bound generators must emit nothing for it.
 *
 * <p>This is the shape #210 makes common: a prompt payload becomes a sourceless
 * projection. {@code appliesTo} rejects it twice over — a leading
 * {@code SUBTYPE_ENTITY} check, and then #248's source-presence guard. Only the
 * SOURCELESS ENTITY below reaches the second one, so it is what actually pins the
 * #248 contract here; the projection assertion pins the subtype gate. Deleting the
 * source guard would emit a repository interface over a table that does not exist,
 * and the failure would surface at Spring wiring time rather than at codegen.</p>
 *
 * <p>The projection reuses the entity's field SHAPE via field-level {@code extends},
 * which carries field properties and NOT object children — so it inherits no source.
 * Object-level {@code extends} to an entity is illegal for a projection
 * (FR-024/ADR-0028), which is precisely why a sourceless projection is a crisp,
 * reachable shape rather than an accident.</p>
 */
public class SpringSourcelessProjectionTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private static final String FIXTURE = """
        {
          "metadata.root": { "package": "acme::blog", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "source.rdb":   { "@table": "authors" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "name", "@required": true, "@maxLength": 200 } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } },
            { "object.projection": { "name": "AuthorPayload", "children": [
                { "field.string": { "name": "name", "extends": "acme::blog::Author.name" } },
                { "field.string": { "name": "summary" } }
            ] } },
            { "object.entity": { "name": "Draft", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "body" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } }
          ] }
        }
        """;

    @Test
    public void sourcelessProjectionGetsNoRepository() throws Exception {
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
                tempFolder.newFolder().toPath(), "sourceless-projection", FIXTURE);

        MetaObject author = loader.getMetaObjectByName("acme::blog::Author");
        MetaObject payload = loader.getMetaObjectByName("acme::blog::AuthorPayload");
        MetaObject draft = loader.getMetaObjectByName("acme::blog::Draft");

        // The sourced entity still emits — the no-churn half of the assertion.
        assertTrue("a sourced entity must still get a repository",
                SpringRepositoryGenerator.appliesTo(author));

        // A sourceless ENTITY is what actually exercises the source gate: it clears
        // appliesTo's leading SUBTYPE_ENTITY check and is rejected only by the
        // `firstRdbSource(entity) == null` guard. Asserting on the projection alone
        // would be vacuous — the subtype check short-circuits before the source is
        // ever consulted, so deleting the source guard would leave that green.
        assertFalse("a sourceless entity has no table to back a repository",
                SpringRepositoryGenerator.appliesTo(draft));

        // The sourceless projection is excluded too (by the subtype gate).
        assertFalse("a sourceless projection has no table to back a repository",
                SpringRepositoryGenerator.appliesTo(payload));
    }
}
