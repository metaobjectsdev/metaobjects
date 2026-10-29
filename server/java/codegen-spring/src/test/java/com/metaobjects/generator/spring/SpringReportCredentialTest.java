package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
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
 * #484 — a served report's column is DERIVED from its {@code @of} field and so loses the field's
 * {@code view.password}. A column over a credential (grouped, or min/max-ed) is still a credential:
 * the report's list route (and its json export) omits it and the csv/xml export names no column for
 * it. A report with no credential source generates no redaction.
 */
public class SpringReportCredentialTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final String MODEL = """
        {
          "metadata.root": { "package": "acme::acct", "children": [
            { "object.entity": { "name": "Account", "children": [
                { "source.rdb": { "@table": "accounts" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "name", "@required": true, "@maxLength": 40 } },
                { "field.string": { "name": "pinHash", "@maxLength": 80, "children": [ { "view.password": {} } ] } },
                { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "increment" } },
                { "dimension.attribute": { "name": "name", "@of": "Account.name" } },
                { "dimension.attribute": { "name": "pinHash", "@of": "Account.pinHash" } },
                { "measure.aggregate": { "name": "accounts", "@agg": "count", "@of": "Account.id" } },
                { "measure.aggregate": { "name": "firstPin", "@agg": "min", "@of": "Account.pinHash" } }
            ] } },
            { "object.report": { "name": "AccountsByPin", "@from": "Account", "@dimensions": ["pinHash"], "@measures": ["accounts"],
                "children": [ { "source.rdb": { "@kind": "view", "@view": "v_accounts_by_pin" } } ] } },
            { "object.report": { "name": "AccountPinRange", "@from": "Account", "@dimensions": ["name"], "@measures": ["firstPin"],
                "children": [ { "source.rdb": { "@kind": "view", "@view": "v_account_pin_range" } } ] } },
            { "object.report": { "name": "AccountsByName", "@from": "Account", "@dimensions": ["name"], "@measures": ["accounts"],
                "children": [ { "source.rdb": { "@kind": "view", "@view": "v_accounts_by_name" } } ] } }
          ] }
        }
        """;

    private Path gen;

    private void generate() throws Exception {
        gen = tmp.newFolder("gen").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder("ws").toPath(), "report-credential", MODEL);
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        for (com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?> g : java.util.List.of(
                new SpringDtoGenerator(), new SpringRepositoryGenerator(),
                new SpringControllerGenerator(), new SpringFilterAllowlistGenerator(),
                new SpringReportExportGenerator())) {
            g.setArgs(args);
            g.execute(loader);
        }
    }

    private String read(String name) throws Exception {
        return Files.readString(gen.resolve("acme/acct/" + name + ".java"));
    }

    @Test
    public void groupedCredentialIsHiddenFromTheListAndExport() throws Exception {
        generate();
        String controller = read("AccountsByPinController");
        assertTrue(controller.contains("redactAll(rows, \"pinHash\")"));
        assertTrue("the mapper is injected for redaction", controller.contains("ObjectMapper objectMapper) {"));
        String export = read("AccountsByPinExport");
        assertFalse("no credential column in the export; saw:\n" + export, export.contains("pinHash"));
        assertTrue(export.contains("\"accounts\""));
    }

    @Test
    public void minOverACredentialIsHidden() throws Exception {
        generate();
        assertTrue(read("AccountPinRangeController").contains("redactAll(rows, \"firstPin\")"));
        String export = read("AccountPinRangeExport");
        assertFalse(export.contains("firstPin"));
        assertTrue(export.contains("\"name\""));
    }

    @Test
    public void plainReportIsUnchanged() throws Exception {
        generate();
        String controller = read("AccountsByNameController");
        assertFalse(controller.contains("redact"));
        assertFalse(controller.contains("ObjectMapper"));
        String export = read("AccountsByNameExport");
        assertTrue(export.contains("\"name\"") && export.contains("\"accounts\""));
    }

    /** The SORT_ALLOWLIST declaration, up to its closing statement. */
    private static String sortList(String controller) {
        int at = controller.indexOf("SORT_ALLOWLIST = Set.of(");
        return controller.substring(at, controller.indexOf(';', at));
    }

    @Test
    public void credentialColumnIsNeitherFilterableNorSortable() throws Exception {
        generate();
        String byPin = read("AccountsByPinFilterAllowlist");
        assertFalse("pinHash must not be filterable:\n" + byPin, byPin.contains("pinHash"));
        assertTrue(byPin.contains("\"accounts\""));
        assertFalse("pinHash must not be sortable", sortList(read("AccountsByPinController")).contains("pinHash"));
        String range = read("AccountPinRangeFilterAllowlist");
        assertFalse(range.contains("firstPin"));
        assertTrue(range.contains("\"name\""));
        assertFalse(sortList(read("AccountPinRangeController")).contains("firstPin"));
        // A plain report keeps both columns in both allowlists.
        String plain = read("AccountsByNameFilterAllowlist");
        assertTrue(plain.contains("\"name\"") && plain.contains("\"accounts\""));
        String plainCtl = read("AccountsByNameController");
        assertTrue(sortList(plainCtl).contains("\"accounts\""));
    }
}
