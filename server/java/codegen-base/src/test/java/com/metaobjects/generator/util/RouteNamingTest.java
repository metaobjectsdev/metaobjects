package com.metaobjects.generator.util;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.EntityMetaObject;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.ValueMetaObject;
import com.metaobjects.registry.ObjectClassRegistry;
import com.metaobjects.source.RdbSource;
import org.junit.After;
import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * THE collection-URL spelling, for both JVM generators at once.
 *
 * <p>The multi-word and consonant+y axes are also gated end-to-end by
 * {@code fixtures/api-contract-conformance/m2m/} (the {@code PostCategory} scenario).
 * The ACRONYM case is not — no corpus entity carries one — so it is pinned here,
 * against the same rule, exactly as the C# and Python ports pin it in theirs.</p>
 */
public class RouteNamingTest {

    // A single regular word. Every port's OLD rule already agreed here, which is
    // precisely why four different spellings shipped with every corpus green.
    @Test
    public void singleRegularWordIsUnchangedByTheNewRule() {
        assertEquals("authors", RouteNaming.collectionSegment("Author"));
        assertEquals("posts", RouteNaming.collectionSegment("Post"));
        assertEquals("tags", RouteNaming.collectionSegment("Tag"));
        assertEquals("persons", RouteNaming.collectionSegment("Person"));
        assertEquals("accounts", RouteNaming.collectionSegment("Account"));
        assertEquals("auths", RouteNaming.collectionSegment("Auth"));
        assertEquals("documents", RouteNaming.collectionSegment("Document"));
        assertEquals("orders", RouteNaming.collectionSegment("Order"));
    }

    // Multi-word: the capitals carry the word boundary, so lowercasing without
    // separating served PostCategory at /postcategorys.
    @Test
    public void multiWordNameIsSeparated() {
        assertEquals("post_categories", RouteNaming.collectionSegment("PostCategory"));
        assertEquals("order_summaries", RouteNaming.collectionSegment("OrderSummary"));
        assertEquals("member_accounts", RouteNaming.collectionSegment("MemberAccount"));
    }

    // A run of capitals stays together until the final one that begins a word.
    @Test
    public void acronymStaysTogether() {
        assertEquals("http_servers", RouteNaming.collectionSegment("HTTPServer"));
        assertEquals("api_keys", RouteNaming.collectionSegment("APIKey"));
    }

    @Test
    public void pluralizeFollowsTheCrossPortContract() {
        // Sibilants take -es.
        assertEquals("addresses", RouteNaming.pluralize("address"));
        assertEquals("boxes", RouteNaming.pluralize("box"));
        assertEquals("buzzes", RouteNaming.pluralize("buzz"));
        assertEquals("matches", RouteNaming.pluralize("match"));
        assertEquals("dishes", RouteNaming.pluralize("dish"));
        // Consonant + y becomes -ies; a VOWEL before the y does not.
        assertEquals("categories", RouteNaming.pluralize("category"));
        assertEquals("days", RouteNaming.pluralize("day"));
        // Everything else takes -s.
        assertEquals("authors", RouteNaming.pluralize("author"));
    }

    @Test
    public void emptyAndNullAreReturnedUnchanged() {
        assertEquals("", RouteNaming.collectionSegment(""));
        assertEquals(null, RouteNaming.collectionSegment(null));
        assertEquals("", RouteNaming.pluralize(""));
        assertEquals(null, RouteNaming.pluralize(null));
    }

    // ---- Already-plural detection --------------------------------
    //
    // An already-plural entity name used to double (ProgramPurchaseStats ->
    // ProgramPurchaseStatses / program_purchase_statses) in the REST collection
    // segment. Mirrors the TS fix in metadata/src/naming.ts exactly (same
    // four-letter exclusion set before a final "s").

    @Test
    public void alreadyPluralWordsAreLeftUnchanged() {
        assertEquals("stats", RouteNaming.pluralize("stats"));
        assertEquals("settings", RouteNaming.pluralize("settings"));
        assertEquals("details", RouteNaming.pluralize("details"));
        assertEquals("news", RouteNaming.pluralize("news"));
        assertEquals("analytics", RouteNaming.pluralize("analytics"));
        assertEquals("series", RouteNaming.pluralize("series"));
        assertEquals("photos", RouteNaming.pluralize("photos"));
    }

    @Test
    public void collectionSegmentDoesNotDoublePluralizeAnAlreadyPluralEntityName() {
        assertEquals("program_purchase_stats", RouteNaming.collectionSegment("ProgramPurchaseStats"));
        assertEquals("settings", RouteNaming.collectionSegment("Settings"));
    }

    @Test
    public void wordsEndingInSUIAPlusSKeepExistingBehavior() {
        assertEquals("statuses", RouteNaming.pluralize("status"));
        assertEquals("addresses", RouteNaming.pluralize("address"));
        assertEquals("bonuses", RouteNaming.pluralize("bonus"));
        assertEquals("aliases", RouteNaming.pluralize("alias"));
        assertEquals("gases", RouteNaming.pluralize("gas"));
        // Documented pre-existing imperfection, explicitly out of scope — not "analyses".
        assertEquals("analysises", RouteNaming.pluralize("analysis"));
    }

    @Test
    public void documentedKnownMissLensReadsAsAlreadyPlural() {
        // Correct plural is "lenses"; this heuristic is not a dictionary. See
        // RouteNaming.pluralize's doc comment.
        assertEquals("lens", RouteNaming.pluralize("lens"));
    }

    /**
     * fixtures/naming-conformance/ — the shared cross-port data proving every port's
     * API-surface pluralizer agrees on the same inputs. See that corpus's README; the
     * FROZEN legacy-pluralizer half of the same fixture is checked in
     * {@code metadata}'s {@code Fr016SourcePhysicalNameTest} (a different module —
     * {@code codegen-base} has no access to {@code MetaSource}'s private
     * {@code pluralizeInternal}, nor should it).
     */
    @Test
    public void namingConformanceApiPluralsMatch() throws IOException {
        Path repoRoot = Path.of(System.getProperty("user.dir")).resolve("../../..").normalize();
        Path fixture = repoRoot.resolve("fixtures/naming-conformance/already-plural-pluralize.json");
        JsonObject root = JsonParser.parseString(Files.readString(fixture)).getAsJsonObject();
        JsonArray cases = root.getAsJsonArray("cases");
        for (int i = 0; i < cases.size(); i++) {
            JsonObject c = cases.get(i).getAsJsonObject();
            String name = c.get("name").getAsString();
            String expected = c.get("apiPlural").getAsString();
            // RouteNaming.pluralize expects an already-lowercased word (what toSnakeCase
            // returns); every fixture case is a single word, so lowercasing both sides
            // is byte-equivalent to snake_casing first.
            assertEquals(
                "pluralize(" + name + ")",
                expected.toLowerCase(), RouteNaming.pluralize(name.toLowerCase()));
        }
    }

    // ---- assertNoCollectionNameCollisions ---------------------------------

    // An entity that gets a collection: concrete, backed by a source.rdb.
    private static MetaObject entity(String name) {
        MetaObject entity = new EntityMetaObject(name);
        entity.addChild(new RdbSource("source"));
        return entity;
    }

    private static MetaObject value(String name) {
        return new ValueMetaObject(name);
    }

    @Test
    public void assertNoCollectionNameCollisionsDoesNotThrowForDistinctSegments() {
        RouteNaming.assertNoCollectionNameCollisions(List.of(entity("Post"), entity("Author"), entity("Category")));
    }

    @Test
    public void assertNoCollectionNameCollisionsThrowsForAddressAndAddresses() {
        GeneratorException ex = assertThrows(GeneratorException.class,
            () -> RouteNaming.assertNoCollectionNameCollisions(List.of(entity("Address"), entity("Addresses"))));
        assertTrue(ex.getMessage().contains("Address"));
        assertTrue(ex.getMessage().contains("Addresses"));
    }

    @Test
    public void assertNoCollectionNameCollisionsThrowsForOrderAndOrders() {
        assertThrows(GeneratorException.class,
            () -> RouteNaming.assertNoCollectionNameCollisions(List.of(entity("Order"), entity("Orders"))));
    }

    @Test
    public void assertNoCollectionNameCollisionsThrowsForRouteSegmentTwins() {
        // ApiKey / APIKey both snake_case to api_key and serve /api_keys.
        GeneratorException ex = assertThrows(GeneratorException.class,
            () -> RouteNaming.assertNoCollectionNameCollisions(List.of(entity("ApiKey"), entity("APIKey"))));
        assertTrue(ex.getMessage().contains("\"ApiKey\""));
        assertTrue(ex.getMessage().contains("\"APIKey\""));
        assertTrue(ex.getMessage().contains("api_keys"));
    }

    @Test
    public void assertNoCollectionNameCollisionsExcludesValueObjects() {
        // "Address" (entity) resolves to /addresses; an unrelated object.value named
        // "Addresses" never gets a route, so it must not trip this.
        RouteNaming.assertNoCollectionNameCollisions(List.of(entity("Address"), value("Addresses")));
    }

    /**
     * fixtures/naming-conformance/ — the shared collisionCases half, run here too (the
     * API-surface-plurals half is {@link #namingConformanceApiPluralsMatch}).
     */
    @Test
    public void namingConformanceCollisionCasesAreRefused() throws IOException {
        Path repoRoot = Path.of(System.getProperty("user.dir")).resolve("../../..").normalize();
        Path fixture = repoRoot.resolve("fixtures/naming-conformance/already-plural-pluralize.json");
        JsonObject root = JsonParser.parseString(Files.readString(fixture)).getAsJsonObject();
        JsonArray cases = root.getAsJsonArray("collisionCases");
        for (int i = 0; i < cases.size(); i++) {
            JsonObject c = cases.get(i).getAsJsonObject();
            String a = c.get("entityA").getAsString();
            String b = c.get("entityB").getAsString();
            assertThrows("(" + a + ", " + b + ")", GeneratorException.class,
                () -> RouteNaming.assertNoCollectionNameCollisions(List.of(entity(a), entity(b))));
        }
    }

    // ---- an object that emits no collection never claims a collection name ----
    //
    // fixtures/naming-conformance/'s shapeOnlyCases: an abstract or sourceless object gets no
    // controller, repository or route, so a same-named emitting entity in another package is
    // not a collision. crossPackageCollisionCases is the control.

    @After
    public void resetRegistry() {
        ObjectClassRegistry.resetGlobal();
    }

    private static JsonObject namingCorpus() throws IOException {
        Path repoRoot = Path.of(System.getProperty("user.dir")).resolve("../../..").normalize();
        Path fixture = repoRoot.resolve("fixtures/naming-conformance/already-plural-pluralize.json");
        return JsonParser.parseString(Files.readString(fixture)).getAsJsonObject();
    }

    /** Each object in its own package (one source per package), declaring an {@code id} key. */
    private static List<MetaObject> packagedObjects(JsonObject... objects) {
        List<com.metaobjects.loader.MetaDataSource> sources = new ArrayList<>();
        for (int i = 0; i < objects.length; i++) {
            JsonObject o = objects[i];
            String pkg = o.get("package").getAsString();
            String name = o.get("name").getAsString();
            boolean isAbstract = o.has("abstract") && o.get("abstract").getAsBoolean();
            boolean source = !o.has("source") || o.get("source").getAsBoolean();
            String json = "{ \"metadata.root\": { \"package\": \"" + pkg + "\", \"children\": [\n"
                + "  { \"object.entity\": { \"name\": \"" + name + "\", "
                + (isAbstract ? "\"abstract\": true, " : "") + "\"children\": [\n"
                + (source ? "    { \"source.rdb\": { \"@table\": \"" + pkg + "_" + name.toLowerCase() + "\" } },\n" : "")
                + "    { \"field.long\": { \"name\": \"id\" } },\n"
                + "    { \"identity.primary\": { \"@fields\": \"id\" } }\n"
                + "  ] } }\n] } }";
            sources.add(new InMemoryStringSource(json, "naming/" + pkg + "-" + i + ".json"));
        }
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "naming");
        loader.init();
        loader.load(sources);
        return new ArrayList<>(loader.getMetaObjects());
    }

    @Test
    public void namingConformanceAnObjectThatEmitsNoCollectionClaimsNoName() throws IOException {
        JsonArray cases = namingCorpus().getAsJsonArray("shapeOnlyCases");
        for (int i = 0; i < cases.size(); i++) {
            JsonObject c = cases.get(i).getAsJsonObject();
            JsonObject shapeOnly = c.getAsJsonObject("shapeOnly");
            JsonObject emitting = c.getAsJsonObject("emitting");
            // Both orders: the first-seen object owns a name, so order must not matter.
            RouteNaming.assertNoCollectionNameCollisions(packagedObjects(shapeOnly, emitting));
            ObjectClassRegistry.resetGlobal();
            RouteNaming.assertNoCollectionNameCollisions(packagedObjects(emitting, shapeOnly));
            ObjectClassRegistry.resetGlobal();
        }
    }

    @Test
    public void namingConformanceTwoEmittingEntitiesInTwoPackagesStillCollide() throws IOException {
        JsonArray cases = namingCorpus().getAsJsonArray("crossPackageCollisionCases");
        for (int i = 0; i < cases.size(); i++) {
            JsonObject c = cases.get(i).getAsJsonObject();
            List<MetaObject> objects = packagedObjects(c.getAsJsonObject("entityA"), c.getAsJsonObject("entityB"));
            GeneratorException ex = assertThrows(GeneratorException.class,
                () -> RouteNaming.assertNoCollectionNameCollisions(objects));
            assertTrue(ex.getMessage(), ex.getMessage().contains(c.get("collidesOn").getAsString().toLowerCase()));
        }
    }
}
