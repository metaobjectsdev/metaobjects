package com.metaobjects.generator.spring;

import com.metaobjects.generator.util.RestSurfaceGate;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * F22 — a view-only {@code object.projection} gets a generated READ-ONLY Spring REST
 * surface: reads served, every write verb answering
 * {@code 405 {"error": "method_not_allowed"}}.
 *
 * <p>This suite asserts on the emitted STRINGS because the Java port has no gate that
 * reacts to changed generated output — the unit suite is green whether the emitters
 * change or not, and the api-contract integration lane only runs the corpus entities.
 * So the shapes the corpus cannot reach (a KEYLESS projection; the exact emitted
 * refusal) are pinned here.</p>
 *
 * <p>The model mirrors {@code fixtures/api-contract-conformance/projection/meta.json}
 * (writable {@code Invoice} + view-only {@code InvoiceSummary}) and adds
 * {@code TagCount}, a keyless projection the corpus has no room for.</p>
 */
public class SpringProjectionRestSurfaceTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final String FIXTURE = """
        {
          "metadata.root": { "package": "acme::sales", "children": [
            { "object.entity": { "name": "Invoice", "children": [
                { "source.rdb":       { "@table": "invoices" } },
                { "field.long":       { "name": "id" } },
                { "field.string":     { "name": "reference", "@required": true, "@maxLength": 40 } },
                { "field.long":       { "name": "amountCents", "@required": true } },
                { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "increment" } }
            ] } },
            { "object.projection": { "name": "InvoiceSummary", "children": [
                { "source.rdb":       { "@kind": "view", "@view": "v_invoice_summary" } },
                { "field.long":       { "name": "id", "extends": "Invoice.id", "@filterable": true, "@sortable": true } },
                { "field.string":     { "name": "reference", "extends": "Invoice.reference", "@filterable": true } },
                { "field.long":       { "name": "amountCents", "extends": "Invoice.amountCents", "@filterable": true } },
                { "identity.primary": { "name": "pk", "extends": "Invoice.pk" } }
            ] } },
            { "object.projection": { "name": "TagCount", "children": [
                { "source.rdb":    { "@kind": "view", "@view": "v_tag_count" } },
                { "field.string":  { "name": "tag", "@filterable": true } },
                { "field.int":     { "name": "total" } }
            ] } }
          ] }
        }
        """;

    private Path generateAll(String label) throws Exception {
        Path ws = tmp.newFolder().toPath();
        Path gen = tmp.newFolder().toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "projection-" + label, FIXTURE);

        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        for (com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?> g : List.of(
                new SpringDtoGenerator(),
                new SpringRepositoryGenerator(),
                new SpringControllerGenerator(),
                new SpringFilterAllowlistGenerator())) {
            g.setArgs(args);
            g.execute(loader);
        }
        return gen;
    }

    private MetaDataLoader load(String label) throws Exception {
        return SpringTestFixtures.loadFixture(tmp.newFolder().toPath(), "gate-" + label, FIXTURE);
    }

    // === the gate ============================================================

    /**
     * The trio moves together. The controller NAMES the repository and the allowlist, so
     * a gate widened in one and not the others emits a controller importing types nothing
     * generated — and {@code generate} still exits 0. Asserting LOCK-STEP rather than
     * restating the rule three times is what makes that un-driftable.
     */
    @Test
    public void controllerRepositoryAndAllowlistAgreeOnEveryObject() throws Exception {
        MetaDataLoader loader = load("lockstep");
        for (MetaObject obj : loader.getMetaObjects()) {
            boolean controller = SpringControllerGenerator.appliesTo(obj);
            assertEquals(obj.getName() + ": repository must agree with controller",
                    controller, SpringRepositoryGenerator.appliesTo(obj));
            assertEquals(obj.getName() + ": filter allowlist must agree with controller",
                    controller, SpringFilterAllowlistGenerator.appliesTo(obj));
        }
    }

    @Test
    public void viewOnlyProjectionIsAdmittedAsReadOnly() throws Exception {
        MetaDataLoader loader = load("admit");
        MetaObject invoice = loader.getMetaObjectByName("acme::sales::Invoice");
        MetaObject summary = loader.getMetaObjectByName("acme::sales::InvoiceSummary");
        MetaObject tagCount = loader.getMetaObjectByName("acme::sales::TagCount");

        assertTrue("the writable table entity still emits", SpringControllerGenerator.appliesTo(invoice));
        assertFalse("a table entity is not read-only", RestSurfaceGate.isReadOnly(invoice));

        assertTrue("a view-only projection emits (F22)", SpringControllerGenerator.appliesTo(summary));
        assertTrue("and it emits the READ-ONLY shape", RestSurfaceGate.isReadOnly(summary));

        // The identity is inherited (`identity.primary extends Invoice.pk`), so the item
        // routes hinge on a RESOLVING read — an own-only one would see no identity here
        // and silently drop GET /{id} from the emitted controller (ADR-0039).
        assertTrue("an inherited identity.primary still addresses the item route",
                RestSurfaceGate.hasItemRoute(summary));
        assertFalse("a keyless projection has no item route", RestSurfaceGate.hasItemRoute(tagCount));
    }

    // === the emitted controller ==============================================

    @Test
    public void readOnlyControllerServesReadsAndRefusesEveryWriteVerb() throws Exception {
        String src = Files.readString(generateAll("keyed").resolve("acme/sales/InvoiceSummaryController.java"));

        assertTrue("list route", src.contains("@RequestMapping(\"/api/invoice_summaries\")"));
        assertTrue("list handler", src.contains("public ResponseEntity<?> list("));
        assertTrue("item read", src.contains("@GetMapping(\"/{id}\")"));
        assertTrue("item read is typed by the INHERITED pk",
                src.contains("public ResponseEntity<?> get(@PathVariable Long id)"));

        // Every write verb is MOUNTED — that is the point. Unmounted, Spring answers a
        // POST on a path it knows with its own error body, a fifth shape on the wire.
        assertTrue("POST refused", src.contains("@PostMapping"));
        assertTrue("item writes refused",
                src.contains("method = { RequestMethod.PATCH, RequestMethod.PUT, RequestMethod.DELETE }"));
        assertTrue("the cross-port envelope",
                src.contains("Map.of(\"error\", \"method_not_allowed\""));
        assertTrue("405, not 404 — the same path answers GET",
                src.contains("ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED)"));

        // ...and no write HANDLER exists to reach.
        assertFalse("no create path", src.contains("repository.create("));
        assertFalse("no update path", src.contains("repository.patch("));
        assertFalse("no delete path", src.contains("repository.delete("));
        // Nothing binds a request body here, so injecting an ObjectMapper or a Validator
        // would make a consumer wire beans this controller can never use.
        assertFalse("no ObjectMapper injection", src.contains("ObjectMapper objectMapper"));
        assertFalse("no Validator injection", src.contains("Validator validator"));
    }

    /**
     * A keyless projection mounts no {@code /{id}} read, so it must refuse no item write
     * either — refusing one would advertise an address the port never serves.
     */
    @Test
    public void keylessProjectionRefusesOnlyTheCollectionVerb() throws Exception {
        String src = Files.readString(generateAll("keyless").resolve("acme/sales/TagCountController.java"));

        assertTrue("list route still served", src.contains("public ResponseEntity<?> list("));
        assertFalse("no item read", src.contains("@GetMapping(\"/{id}\")"));
        assertTrue("collection POST still refused", src.contains("@PostMapping"));
        assertFalse("no item refusal", src.contains("RequestMethod.PATCH"));
        assertFalse("no @PathVariable to bind", src.contains("@PathVariable"));
    }

    // === the emitted consumer seam ===========================================

    @Test
    public void readOnlyRepositoryOffersNoWriteMethod() throws Exception {
        Path gen = generateAll("seam");
        String src = Files.readString(gen.resolve("acme/sales/InvoiceSummaryRepository.java"));

        assertTrue("list", src.contains("list(int limit, int offset, SortClause sort, List<FilterPredicate> filters)"));
        assertTrue("count", src.contains("long count(List<FilterPredicate> filters)"));
        assertTrue("findById", src.contains("Optional<InvoiceSummaryDto> findById(Long id)"));

        // An interface is a contract offered to a consumer. A projection cannot honour
        // these against a SQL view under ANY implementation, so emitting them would ask
        // every adopter to write four methods that must throw.
        assertFalse("no create", src.contains(" create("));
        assertFalse("no update", src.contains(" update("));
        assertFalse("no patch", src.contains(" patch("));
        assertFalse("no delete", src.contains(" delete("));

        // The keyless one drops findById too — it matches the controller's route set.
        String keyless = Files.readString(gen.resolve("acme/sales/TagCountRepository.java"));
        assertFalse("no findById without an item route", keyless.contains("findById"));

        // The writable entity's seam is untouched.
        String invoice = Files.readString(gen.resolve("acme/sales/InvoiceRepository.java"));
        assertTrue("the writable seam still writes", invoice.contains("InvoiceDto create(InvoiceDto dto)"));
    }

    @Test
    public void projectionGetsItsOwnFilterAllowlist() throws Exception {
        Path gen = generateAll("allowlist");
        // Generated from the PROJECTION's own declared field set, not the base entity's —
        // and it must exist at all, because the emitted controller imports it by name.
        String src = Files.readString(gen.resolve("acme/sales/InvoiceSummaryFilterAllowlist.java"));
        assertTrue("id is filterable", src.contains("\"id\""));
        assertTrue("reference is filterable", src.contains("\"reference\""));
        assertTrue("the controller names it",
                Files.readString(gen.resolve("acme/sales/InvoiceSummaryController.java"))
                     .contains("InvoiceSummaryFilterAllowlist.FIELDS"));
    }
}
