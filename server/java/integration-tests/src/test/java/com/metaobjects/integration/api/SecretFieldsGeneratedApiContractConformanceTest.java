package com.metaobjects.integration.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.integration.api.ApiContractScenarios.ApiRequest;
import com.metaobjects.integration.api.ApiContractScenarios.ApiScenario;
import com.metaobjects.integration.api.generated.GeneratedAccountControllerHarness;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * #484 — the Java GENERATED-controller lane for the {@code secret-fields} api-contract
 * sub-corpus: a {@code @formExclude} field is ignored on every generated write route and still
 * returned, and a credential ({@code view.password}) is ignored on write and never returned.
 *
 * <p>Generated lane ONLY, on every port: what is under test is whether the GENERATOR emits routes
 * that honour the marks, which a hand-rolled reference server would satisfy by construction.</p>
 *
 * <p>Run on-demand:
 * {@code mvn -f server/java/integration-tests/pom.xml test -Dtest=SecretFieldsGeneratedApiContractConformanceTest}</p>
 */
@DisplayName("API contract secret-fields — GENERATED Spring controller (codegen-spring) over embedded Tomcat")
final class SecretFieldsGeneratedApiContractConformanceTest {

    private static final Path CONFIG_ROOT = ApiContractScenarioLoader.findCorpusRoot();
    private static final Path ROOT = CONFIG_ROOT.resolve("secret-fields");
    private static final List<ApiScenario> SCENARIOS =
        ApiContractScenarioLoader.loadScenarios(ROOT.resolve("scenarios"));

    private static GeneratedAccountControllerHarness HARNESS;

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> seedRows() throws IOException {
        String text = Files.readString(ROOT.resolve("seed.json"), StandardCharsets.UTF_8);
        Object rows = new ObjectMapper().readValue(text, Map.class).get("rows");
        if (!(rows instanceof List<?>)) throw new IllegalStateException("secret-fields/seed.json: missing 'rows' array");
        return (List<Map<String, Object>>) rows;
    }

    @BeforeAll
    static void setUp() throws Exception {
        Path genDir = Files.createTempDirectory("secret-fields-generated-controller");
        HARNESS = new GeneratedAccountControllerHarness(ROOT, CONFIG_ROOT, genDir, seedRows());
    }

    @AfterAll
    static void tearDown() throws Exception {
        if (HARNESS != null) HARNESS.close();
    }

    static Stream<Arguments> scenarios() {
        return SCENARIOS.stream().map(s -> Arguments.of(s.name(), s));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("scenarios")
    void scenario(String name, ApiScenario scenario) {
        assertDoesNotThrow(() -> {
            HARNESS.reset();
            for (ApiRequest req : scenario.requests()) {
                GeneratedAccountControllerHarness.Response res =
                    HARNESS.exchange(req.method(), req.path(), req.body());
                Object parsed = HARNESS.parseBody(res.body());
                ApiContractAssertions.assertResponse(scenario.name(), req, res.status(), parsed);
            }
            assertDeniedColumnsNeverWritten(scenario.name());
        });
    }

    /**
     * A read-only projection field that extends {@code Account.pinHash} inherits the credential, so
     * the projection's generated list and get never return it either (the corpus README: a
     * credential is never returned). The other fields still are.
     */
    @Test
    @SuppressWarnings("unchecked")
    void projectionInheritingACredentialNeverReturnsIt() throws Exception {
        HARNESS.reset();
        GeneratedAccountControllerHarness.Response list = HARNESS.exchange("GET", "/api/account_views", null);
        assertEquals(200, list.status(), list.body());
        List<Map<String, Object>> rows = (List<Map<String, Object>>) HARNESS.parseBody(list.body());
        assertEquals(List.of("Ada Lovelace", "Alan Turing"), rows.stream().map(r -> r.get("name")).toList());
        for (Map<String, Object> row : rows) assertFalse(row.containsKey("pinHash"), list.body());

        GeneratedAccountControllerHarness.Response one = HARNESS.exchange("GET", "/api/account_views/1", null);
        assertEquals(200, one.status(), one.body());
        Map<String, Object> row = (Map<String, Object>) HARNESS.parseBody(one.body());
        assertEquals("Ada Lovelace", row.get("name"));
        assertFalse(row.containsKey("pinHash"), one.body());
    }

    static Stream<Arguments> namingStrategies() {
        return Stream.of(
            Arguments.of("none", null),
            Arguments.of("snake", com.fasterxml.jackson.databind.PropertyNamingStrategies.SNAKE_CASE),
            Arguments.of("kebab", com.fasterxml.jackson.databind.PropertyNamingStrategies.KEBAB_CASE));
    }

    /**
     * A credential is never returned whatever the host mapper's property naming strategy: under
     * {@code SNAKE_CASE} the key is {@code pin_hash}, under {@code KEBAB_CASE} {@code pin-hash}, and
     * the generated controller reads that key from the mapper's own contract rather than spelling it
     * {@code pinHash}. Drives the entity's list and get-by-id and the inheriting projection's.
     */
    @ParameterizedTest(name = "naming={0}")
    @MethodSource("namingStrategies")
    void credentialIsNeverReturnedUnderAnyNamingStrategy(
            String label, com.fasterxml.jackson.databind.PropertyNamingStrategy naming) throws Exception {
        Path genDir = Files.createTempDirectory("secret-fields-naming-" + label);
        try (GeneratedAccountControllerHarness harness =
                 new GeneratedAccountControllerHarness(ROOT, CONFIG_ROOT, genDir, seedRows(), naming)) {
            harness.reset();
            for (String path : List.of("/api/accounts", "/api/accounts/1", "/api/account_views", "/api/account_views/1")) {
                GeneratedAccountControllerHarness.Response res = harness.exchange("GET", path, null);
                assertEquals(200, res.status(), label + " " + path + ": " + res.body());
                assertTrue(res.body().contains("Ada Lovelace"), label + " " + path + ": " + res.body());
                assertFalse(res.body().contains("pin-hash-1"), label + " " + path + " leaked the credential: " + res.body());
                assertFalse(res.body().contains("pin-hash-2"), label + " " + path + " leaked the credential: " + res.body());
            }
            // @formExclude alone still returns the field, under the strategy's own key.
            String tokenKey = naming == null ? "tokenHash"
                : ((com.fasterxml.jackson.databind.PropertyNamingStrategies.NamingBase) naming).translate("tokenHash");
            assertTrue(harness.exchange("GET", "/api/accounts/1", null).body().contains("\"" + tokenKey + "\":\"token-hash-1\""),
                label + ": tokenHash must still be returned as " + tokenKey);
        }
    }

    /** Renames the credential's JSON key to one that does not spell its field name at all. */
    abstract static class RenameCredentialMixin {
        @com.fasterxml.jackson.annotation.JsonProperty("secret")
        abstract String pinHash();
    }

    /**
     * A credential is never returned when the host mapper renames it with a mixin to a key that does
     * not normalise to the field name ({@code secret}): only the mapper's own contract reveals the key.
     * Oracle: the seeded {@code pinHash} values from {@code seed.json}; a helper that removed the key
     * spelled {@code pinHash} would return them under {@code secret}.
     */
    @Test
    void credentialRenamedByAMixinIsNeverReturned() throws Exception {
        Path genDir = Files.createTempDirectory("secret-fields-mixin");
        try (GeneratedAccountControllerHarness harness = new GeneratedAccountControllerHarness(
                ROOT, CONFIG_ROOT, genDir, seedRows(), null,
                (mapper, dto) -> mapper.addMixIn(dto, RenameCredentialMixin.class))) {
            harness.reset();
            for (String path : List.of("/api/accounts", "/api/accounts/1")) {
                GeneratedAccountControllerHarness.Response res = harness.exchange("GET", path, null);
                assertEquals(200, res.status(), path + ": " + res.body());
                assertTrue(res.body().contains("Ada Lovelace"), path + ": " + res.body());
                assertFalse(res.body().contains("secret"), path + " kept the renamed credential key: " + res.body());
                for (Map<String, Object> row : seedRows()) {
                    assertFalse(res.body().contains((String) row.get("pinHash")),
                        path + " leaked the credential: " + res.body());
                }
            }
        }
    }

    /**
     * Fail closed: when the mapper writes the row through a custom serializer, the credential's key
     * cannot be read from its contract, so the response is refused (500) instead of returning the row.
     * Oracle: the seeded {@code pinHash} values from {@code seed.json}, which this serializer writes
     * out in full, so a helper that sent the row unstripped would return them.
     */
    @Test
    @SuppressWarnings("unchecked")
    void customSerializerForTheRowRefusesTheResponse() throws Exception {
        Path genDir = Files.createTempDirectory("secret-fields-custom-serializer");
        try (GeneratedAccountControllerHarness harness = new GeneratedAccountControllerHarness(
                ROOT, CONFIG_ROOT, genDir, seedRows(), null,
                (mapper, dto) -> {
                    com.fasterxml.jackson.databind.module.SimpleModule module =
                        new com.fasterxml.jackson.databind.module.SimpleModule();
                    module.addSerializer((Class<Object>) dto, new com.fasterxml.jackson.databind.JsonSerializer<Object>() {
                        @Override
                        public void serialize(Object value, com.fasterxml.jackson.core.JsonGenerator gen,
                                              com.fasterxml.jackson.databind.SerializerProvider provider)
                                throws IOException {
                            try {
                                gen.writeStartObject();
                                gen.writeStringField("name", (String) dto.getMethod("name").invoke(value));
                                gen.writeStringField("pinHash", (String) dto.getMethod("pinHash").invoke(value));
                                gen.writeEndObject();
                            } catch (ReflectiveOperationException e) {
                                throw new IOException(e);
                            }
                        }
                    });
                    mapper.registerModule(module);
                })) {
            harness.reset();
            for (String path : List.of("/api/accounts", "/api/accounts/1")) {
                GeneratedAccountControllerHarness.Response res = harness.exchange("GET", path, null);
                assertEquals(500, res.status(), path + ": " + res.body());
                for (Map<String, Object> row : seedRows()) {
                    assertFalse(res.body().contains((String) row.get("pinHash")),
                        path + " leaked the credential: " + res.body());
                }
            }
        }
    }

    /**
     * The stored rows, read from the repository seam: a seeded row still holds its seed
     * {@code tokenHash} and {@code pinHash} (neither was writable), and a row the scenario created
     * holds null in both. This is what pins {@code pinHash}'s write path, which no response shows.
     */
    private static void assertDeniedColumnsNeverWritten(String scenario) throws Exception {
        Map<Object, Map<String, Object>> seeded = new java.util.HashMap<>();
        for (Map<String, Object> row : seedRows()) seeded.put(((Number) row.get("id")).longValue(), row);
        for (Map<String, Object> stored : HARNESS.storedRows()) {
            Map<String, Object> seed = seeded.get(stored.get("id"));
            for (String col : List.of("tokenHash", "pinHash")) {
                Object want = seed == null ? null : seed.get(col);
                org.junit.jupiter.api.Assertions.assertEquals(want, stored.get(col),
                    scenario + ": stored " + col + " of row " + stored.get("id") + " must be untouched");
            }
        }
    }
}
