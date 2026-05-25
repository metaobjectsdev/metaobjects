package com.metaobjects.integration;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.UUID;

/**
 * Start a fresh Postgres container per scenario by shelling out to the
 * {@code docker} CLI directly.
 *
 * Implementation note: testcontainers-java 1.21.x bundles docker-java 3.4.x
 * which hardcodes a client API version (1.32-class) below the minimum
 * supported by recent Docker daemons (Docker Engine 29+ requires API 1.44+).
 * That mismatch surfaces as a BadRequestException during the Testcontainers
 * discovery phase, with no recovery path short of waiting for an upstream
 * docker-java upgrade. The hand-managed CLI path here is small, fast (~3s
 * incl. pg_isready), and avoids the version-negotiation issue entirely.
 * Mirrors the TS port's {@code postgres-container.ts} workaround for the
 * parallel bun/testcontainers-node compat issue.
 */
public final class PostgresContainer implements AutoCloseable {
    private static final String IMAGE = "postgres:16-alpine";
    private static final String PG_USER = "postgres";
    private static final String PG_PASSWORD = "test";

    private final String name;
    private final int port;
    private final String jdbcUrl;

    public PostgresContainer() {
        this.name = "metaobjects-test-" + UUID.randomUUID().toString().substring(0, 8);
        this.port = pickFreePort();
        runDocker("run", "-d", "--rm",
            "--name", name,
            "-e", "POSTGRES_PASSWORD=" + PG_PASSWORD,
            "-p", port + ":5432",
            IMAGE);
        this.jdbcUrl = "jdbc:postgresql://localhost:" + port + "/postgres";
        waitForReady();
    }

    public String jdbcUrl()  { return jdbcUrl; }
    public String username() { return PG_USER; }
    public String password() { return PG_PASSWORD; }

    @Override public void close() {
        try { runDocker("rm", "-f", name); }
        catch (RuntimeException ignored) { /* container may already be gone */ }
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
    private void waitForReady() {
        long deadline = System.currentTimeMillis() + 30_000;
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
        throw new RuntimeException("postgres container '" + name + "' did not become ready within 30s");
    }

    private boolean canConnect() {
        try (Connection c = DriverManager.getConnection(jdbcUrl, PG_USER, PG_PASSWORD)) {
            return c.isValid(2);
        } catch (SQLException ignored) { return false; }
    }
}
