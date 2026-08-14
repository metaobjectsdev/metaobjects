package com.metaobjects.integration;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.ServerSocket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.UUID;

/**
 * Obtain a fresh, isolated Postgres database per scenario.
 *
 * <p>Two modes, mirroring the TS/Kotlin/Python/C# suites:
 * <ol>
 *   <li><b>Shared sidecar (CI)</b>: if {@code METAOBJECTS_TEST_PG_URL} is set,
 *       connect to that already-running Postgres and {@code CREATE DATABASE} a
 *       uniquely-named database per instance (dropping it on close). No
 *       container boot / image pull on the hot path — the point of the shared
 *       {@code services: postgres} CI sidecar. Each scenario still gets a
 *       pristine empty database, so isolation is identical to the per-container
 *       path.</li>
 *   <li><b>Per-container (local dev)</b>: with no env var, boot a fresh
 *       container via the {@code docker} CLI, exactly as before.</li>
 * </ol>
 *
 * <p>Implementation note (mode 2): testcontainers-java 1.21.x bundles
 * docker-java 3.4.x which hardcodes a client API version (1.32-class) below the
 * minimum supported by recent Docker daemons (Docker Engine 29+ requires API
 * 1.44+). That mismatch surfaces as a BadRequestException during the
 * Testcontainers discovery phase, with no extraction path short of waiting for
 * an upstream docker-java upgrade. The hand-managed CLI path here is small, fast
 * (~3s incl. pg_isready), and avoids the version-negotiation issue entirely.
 * Mirrors the TS port's {@code postgres-container.ts}. The shared sidecar mode
 * sidesteps this entirely; the fallback keeps the docker path.
 */
public final class PostgresContainer implements AutoCloseable {
    /** Env var naming the shared CI Postgres sidecar (admin URL). Unset = per-container fallback. */
    private static final String SHARED_PG_URL_ENV = "METAOBJECTS_TEST_PG_URL";

    private static final String IMAGE = "postgres:16-alpine";
    private static final String PG_USER = "postgres";
    private static final String PG_PASSWORD = "test";

    private final boolean shared;
    private final String name;       // null in shared mode
    private final String adminUrl;   // JDBC admin URL, null in per-container mode
    private final String createdDb;  // created database name, null in per-container mode
    private final String jdbcUrl;
    private final String username;
    private final String password;

    public PostgresContainer() {
        String sharedUri = System.getenv(SHARED_PG_URL_ENV);
        if (sharedUri != null && !sharedUri.isBlank()) {
            this.shared = true;
            this.name = null;
            // postgres://user:pass@host:port/adminDb -> jdbc coordinates.
            URI u = URI.create(sharedUri);
            String[] userInfo = (u.getUserInfo() == null ? "" : u.getUserInfo()).split(":", 2);
            this.username = userInfo.length > 0 ? userInfo[0] : PG_USER;
            this.password = userInfo.length > 1 ? userInfo[1] : "";
            int port = u.getPort() == -1 ? 5432 : u.getPort();
            String adminDb = u.getPath() == null || u.getPath().length() <= 1
                ? "postgres" : u.getPath().substring(1);
            this.adminUrl = "jdbc:postgresql://" + u.getHost() + ":" + port + "/" + adminDb;
            this.createdDb = "mo_test_" + UUID.randomUUID().toString().replace("-", "");
            execAdmin("CREATE DATABASE \"" + createdDb + "\"");  // generated name — no user input
            this.jdbcUrl = "jdbc:postgresql://" + u.getHost() + ":" + port + "/" + createdDb;
            return;
        }
        this.shared = false;
        this.adminUrl = null;
        this.createdDb = null;
        this.username = PG_USER;
        this.password = PG_PASSWORD;
        this.name = "metaobjects-test-" + UUID.randomUUID().toString().substring(0, 8);
        int port = pickFreePort();
        runDocker("run", "-d", "--rm",
            "--name", name,
            "-e", "POSTGRES_PASSWORD=" + PG_PASSWORD,
            "-p", port + ":5432",
            IMAGE);
        this.jdbcUrl = "jdbc:postgresql://localhost:" + port + "/postgres";
        waitForReady();
    }

    public String jdbcUrl()  { return jdbcUrl; }
    public String username() { return username; }
    public String password() { return password; }

    @Override public void close() {
        if (shared) {
            try { execAdmin("DROP DATABASE IF EXISTS \"" + createdDb + "\" WITH (FORCE)"); }
            catch (RuntimeException ignored) { /* best-effort cleanup */ }
            return;
        }
        try { runDocker("rm", "-f", name); }
        catch (RuntimeException ignored) { /* container may already be gone */ }
    }

    /** Run a statement against the shared sidecar's admin database (auto-commit). */
    private void execAdmin(String sql) {
        try (Connection c = DriverManager.getConnection(adminUrl, username, password);
             Statement s = c.createStatement()) {
            s.execute(sql);
        } catch (SQLException e) {
            throw new RuntimeException("admin SQL failed: " + sql, e);
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private static int pickFreePort() {
        try (ServerSocket s = new ServerSocket(0)) { return s.getLocalPort(); }
        catch (IOException e) { throw new RuntimeException("could not pick free port", e); }
    }

    private static String runDocker(String... args) {
        String[] cmd = new String[args.length + 1];
        cmd[0] = "docker";
        System.arraycopy(args, 0, cmd, 1, args.length);
        try {
            Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
            StringBuilder out = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) out.append(line).append('\n');
            }
            int exit = p.waitFor();
            if (exit != 0) throw new RuntimeException(
                "docker " + String.join(" ", args) + " failed (exit=" + exit + "): " + out);
            return out.toString().trim();
        } catch (IOException | InterruptedException e) {
            throw new RuntimeException("docker " + String.join(" ", args) + " threw", e);
        }
    }

    /**
     * Postgres' first-boot entrypoint starts the server twice (initial init,
     * then the real boot). {@code pg_isready} can briefly return success during
     * the first window, so we also verify a real JDBC client connection from
     * the host succeeds before returning. Mirrors the TS port's two-phase wait.
     */
    // READINESS WINDOW. 30s was too tight: under a FULL local-CI run several ports spin
    // their own Postgres concurrently, and a container that is merely slow to boot
    // produces a red gate indistinguishable from a real failure -- it fires BEFORE any
    // test logic. Raising the bound costs nothing when the container is ready quickly
    // (this polls every 250ms and returns immediately) and only changes how long the
    // pathological case takes to give up.
    private static final int READY_TIMEOUT_S =
        Integer.parseInt(System.getenv().getOrDefault("MO_PG_READY_TIMEOUT_S", "120"));

    private void waitForReady() {
        long deadline = System.currentTimeMillis() + (READY_TIMEOUT_S * 1000L);
        while (System.currentTimeMillis() < deadline) {
            try {
                Process p = new ProcessBuilder("docker", "exec", name, "pg_isready", "-U", PG_USER)
                    .redirectErrorStream(true).start();
                if (p.waitFor() == 0 && canConnect()) return;
            } catch (Exception ignored) { /* try again */ }
            try { Thread.sleep(250); } catch (InterruptedException e) {
                Thread.currentThread().interrupt(); return;
            }
        }
        throw new RuntimeException("postgres container '" + name + "' did not become ready within " + READY_TIMEOUT_S + "s");
    }

    private boolean canConnect() {
        try (Connection c = DriverManager.getConnection(jdbcUrl, PG_USER, PG_PASSWORD)) {
            return c.isValid(2);
        } catch (SQLException ignored) { return false; }
    }
}
