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
            controller.contains("dto = new AccountDto(dto.id(), dto.name(), null, null);"));

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
        assertFalse(controller.contains("\"tokenHash\")"));
    }

    @Test
    public void unmarkedModelEmitsNoRedactionAndNoStrip() throws Exception {
        String controller = generate("plain", PLAIN, "AccountController.java", false);
        assertFalse(controller.contains("redact"));
        assertFalse(controller.contains("dto = new AccountDto("));
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
}
