package com.metaobjects.generator.spring;

import java.util.regex.Pattern;
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
 * #484 — a {@code @formExclude} field and a credential ({@code view.password}) are ignored by
 * every generated write route, and only the credential is left out of responses. The credential's
 * write path is not observable over HTTP, so this pins it in the generated source.
 */
public class SpringSecretFieldsCodegenTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final String MARKED = """
        {
          "metadata.root": { "package": "acme::secrets", "children": [
            { "object.entity": { "name": "Account", "children": [
                { "source.rdb": { "@table": "accounts" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "name" } },
                { "field.string": { "name": "tokenHash", "@formExclude": true } },
                { "field.string": { "name": "pinHash", "children": [ { "view.password": {} } ] } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }
        """;

    private static final String PLAIN = MARKED
        .replace(", \"@formExclude\": true", "")
        .replace(", \"children\": [ { \"view.password\": {} } ]", "");

    private String generate(String name, String fixture, String file, boolean dto) throws Exception {
        Path gen = tmp.newFolder("gen-" + name).toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder("ws-" + name).toPath(), name, fixture);
        run(new SpringControllerGenerator(), loader, gen);
        if (dto) run(new SpringDtoGenerator(), loader, gen);
        return Files.readString(gen.resolve("acme/secrets/" + file));
    }

    private static void run(com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?> g,
                            MetaDataLoader loader, Path out) {
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", out.toString());
        g.setArgs(args);
        g.execute(loader);
    }

    @Test
    public void createIgnoresBothDeniedFields_andPatchCarriesNeither() throws Exception {
        String controller = generate("marked", MARKED, "AccountController.java", true);
        assertTrue("create rebuilds the DTO without tokenHash and pinHash; saw:\n" + controller,
            controller.contains("dto = new AccountDto(null, dto.name(), null, null);"));

        Path gen = tmp.getRoot().toPath().resolve("gen-marked");
        String patch = Files.readString(gen.resolve("acme/secrets/AccountPatch.java"));
        assertFalse("Patch must not carry tokenHash", patch.contains("tokenHash"));
        assertFalse("Patch must not carry pinHash", patch.contains("pinHash"));
        assertTrue("Patch keeps the ordinary name", patch.contains("name"));
        // the shared DTO keeps both members for the application's own write path
        String dto = Files.readString(gen.resolve("acme/secrets/AccountDto.java"));
        assertTrue(dto.contains("tokenHash") && dto.contains("pinHash"));
    }

    @Test
    public void onlyTheCredentialIsHiddenOnRead() throws Exception {
        String controller = generate("read", MARKED, "AccountController.java", false);
        assertTrue("credential hidden from rows; saw:\n" + controller,
            controller.contains("redactAll(rows, \"pinHash\")"));
        assertTrue(controller.contains("redact(saved, \"pinHash\")"));
        assertFalse("@formExclude alone is still returned", controller.contains("redact(saved, \"pinHash\", \"tokenHash\")"));
        assertFalse(controller.contains("redact(saved, \"tokenHash\")"));
        assertFalse(controller.contains("redactAll(rows, \"tokenHash\")"));
    }

    @Test
    public void unmarkedModelEmitsNoRedactionAndNoStrip() throws Exception {
        String controller = generate("plain", PLAIN, "AccountController.java", false);
        assertFalse(controller.contains("redact"));
        // only the generated key is dropped: nothing here is a credential or @formExclude
        assertTrue(controller.contains("dto = new AccountDto(null, dto.name(), dto.tokenHash(), dto.pinHash());"));
    }

    /**
     * A TPH base whose subtypes share the {@code token} and {@code memo} columns: plain on
     * {@code AThing} (first in subtype order) and marked on {@code BThing}.
     */
    private static final String TPH_SHARED_COLUMN = """
        {
          "metadata.root": { "package": "acme::secrets", "children": [
            { "object.entity": { "name": "Thing", "@discriminator": "kind", "children": [
                { "source.rdb": { "@table": "things" } },
                { "field.long": { "name": "id" } },
                { "field.enum": { "name": "kind", "@values": ["A", "B"] } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "AThing", "extends": "Thing", "@discriminatorValue": "A", "children": [
                { "field.string": { "name": "token" } },
                { "field.string": { "name": "memo" } }
            ] } },
            { "object.entity": { "name": "BThing", "extends": "Thing", "@discriminatorValue": "B", "children": [
                { "field.string": { "name": "token", "children": [ { "view.password": {} } ] } },
                { "field.string": { "name": "memo", "@formExclude": true } }
            ] } }
          ] }
        }
        """;

    @Test
    public void tphSharedColumnMarkedOnALaterSubtypeIsHiddenAndIgnored() throws Exception {
        String controller = generate("tphshared", TPH_SHARED_COLUMN, "ThingController.java", false);
        assertTrue("the union list hides the credential; saw:\n" + controller,
            controller.contains("redactAll(rows, \"token\")"));
        assertTrue("every subtype create ignores both marked columns; saw:\n" + controller,
            controller.contains("dto = new ThingDto(null, null, null, null);"));
        assertFalse("memo (@formExclude only) is still returned",
            Pattern.compile("redact(All)?\\([^)]*\"memo\"").matcher(controller).find());
    }

    @Test
    public void tphSharedColumnMarkedOnALaterSubtypeIsLeftOutOfEverySubtypePatch() throws Exception {
        String aPatch = generate("tphpatch", TPH_SHARED_COLUMN, "AThingPatch.java", true);
        String bPatch = Files.readString(tmp.getRoot().toPath().resolve("gen-tphpatch/acme/secrets/BThingPatch.java"));
        for (String patch : new String[] { aPatch, bPatch }) {
            assertFalse("token is a credential on BThing; saw:\n" + patch, patch.contains("token"));
            assertFalse("memo is @formExclude on BThing; saw:\n" + patch, patch.contains("memo"));
        }
    }

    private static final String PROJECTION_HEAD =
        "{ \"object.projection\": { \"name\": \"AccountView\", \"children\": [\n"
        + "  { \"source.rdb\": { \"@kind\": \"view\", \"@view\": \"v_account\" } },\n"
        + "  { \"field.long\": { \"name\": \"id\", \"extends\": \"Account.id\" } },\n"
        + "  { \"field.string\": { \"name\": \"name\", \"extends\": \"Account.name\" } },\n";
    private static final String PROJECTION_TAIL =
        "  { \"identity.primary\": { \"name\": \"pk\", \"extends\": \"Account.pk\" } }\n"
        + "] } }";

    /** MARKED plus an AccountView projection carrying {@code extra} (a field declaration). */
    private static String projection(String extra) {
        String body = PROJECTION_HEAD + "  " + extra + "\n" + PROJECTION_TAIL;
        int end = MARKED.lastIndexOf("] }\n");
        int entityEnd = MARKED.lastIndexOf("} }", end);
        return MARKED.substring(0, entityEnd + 3) + ",\n" + body + "\n" + MARKED.substring(entityEnd + 3);
    }

    @Test
    public void projectionWithoutACredentialIsUnchanged() throws Exception {
        String controller = generate("projplain", projection(
            "{ \"field.string\": { \"name\": \"tokenHash\", \"extends\": \"Account.tokenHash\" } },"),
            "AccountViewController.java", false);
        assertFalse(controller.contains("redact"));
        assertFalse(controller.contains("ObjectMapper"));
        assertTrue(controller.contains("AccountViewController(AccountViewRepository repository) {"));
    }

    /** A credential the model also marks {@code @filterable} and {@code @sortable}, beside a normal field. */
    private static final String FILTERABLE_CREDENTIAL = MARKED
        .replace("{ \"field.string\": { \"name\": \"name\" } }",
                 "{ \"field.string\": { \"name\": \"name\", \"@filterable\": true, \"@sortable\": true } }")
        .replace("\"name\": \"pinHash\"", "\"name\": \"pinHash\", \"@filterable\": true, \"@sortable\": true");

    @Test
    public void credentialIsNeverOnTheFilterOrSortAllowlist() throws Exception {
        Path gen = tmp.newFolder("gen-allow").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
            tmp.newFolder("ws-allow").toPath(), "allow", FILTERABLE_CREDENTIAL);
        run(new SpringControllerGenerator(), loader, gen);
        run(new SpringFilterAllowlistGenerator(), loader, gen);

        String filter = Files.readString(gen.resolve("acme/secrets/AccountFilterAllowlist.java"));
        assertTrue("a normal filterable field stays; saw:\n" + filter, filter.contains("\"name\""));
        assertFalse("a credential is never filterable; saw:\n" + filter, filter.contains("pinHash"));

        String controller = Files.readString(gen.resolve("acme/secrets/AccountController.java"));
        String sort = controller.substring(controller.indexOf("SORT_ALLOWLIST = Set.of("));
        sort = sort.substring(0, sort.indexOf(");"));
        assertTrue("a normal sortable field stays; saw: " + sort, sort.contains("\"name\""));
        assertFalse("a credential is never sortable; saw: " + sort, sort.contains("pinHash"));
    }

    private static String tphFilterableToken(String aTokenChildren, String bTokenChildren) {
        return """
            {
              "metadata.root": { "package": "acme::secrets", "children": [
                { "object.entity": { "name": "Thing", "@discriminator": "kind", "children": [
                    { "source.rdb": { "@table": "things" } },
                    { "field.long": { "name": "id" } },
                    { "field.enum": { "name": "kind", "@values": ["A", "B"] } },
                    { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
                ] } },
                { "object.entity": { "name": "AThing", "extends": "Thing", "@discriminatorValue": "A", "children": [
                    { "field.string": { "name": "token", "@filterable": true, "@sortable": true%s } },
                    { "field.string": { "name": "label", "@filterable": true, "@sortable": true } }
                ] } },
                { "object.entity": { "name": "BThing", "extends": "Thing", "@discriminatorValue": "B", "children": [
                    { "field.string": { "name": "token", "@filterable": true, "@sortable": true%s } }
                ] } }
              ] }
            }
            """.formatted(aTokenChildren, bTokenChildren);
    }

    @Test
    public void aColumnAnySiblingSubtypeHidesIsOnNoFilterAllowlist_inEitherDeclarationOrder() throws Exception {
        String credential = ", \"children\": [ { \"view.password\": {} } ]";
        String[][] orders = { { "", credential }, { credential, "" } };
        for (int i = 0; i < orders.length; i++) {
            Path gen = tmp.newFolder("gen-tphallow" + i).toPath();
            MetaDataLoader loader = SpringTestFixtures.loadFixture(
                tmp.newFolder("ws-tphallow" + i).toPath(), "tphallow" + i, tphFilterableToken(orders[i][0], orders[i][1]));
            run(new SpringControllerGenerator(), loader, gen);
            run(new SpringFilterAllowlistGenerator(), loader, gen);

            String filter = Files.readString(gen.resolve("acme/secrets/ThingFilterAllowlist.java"));
            assertTrue("a plain subtype column stays; saw:\n" + filter, filter.contains("\"label\""));
            assertFalse("token is a credential on one subtype; saw:\n" + filter, filter.contains("token"));

            String controller = Files.readString(gen.resolve("acme/secrets/ThingController.java"));
            int at = controller.indexOf("SORT_ALLOWLIST = Set.of(");
            String sort = at < 0 ? "" : controller.substring(at, controller.indexOf(");", at));
            assertFalse("token is never sortable; saw: " + sort, sort.contains("token"));
        }
    }
}
