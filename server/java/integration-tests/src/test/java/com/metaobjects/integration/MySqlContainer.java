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
 * A throwaway MySQL database for one test, started through the {@code docker} CLI.
 *
 * <p>Same approach as {@link PostgresContainer} and for the same reason: testcontainers-java's
 * bundled docker-java cannot negotiate with current Docker daemons. Only the per-container mode
 * exists here; there is no shared CI sidecar for MySQL.
 *
 * <p>Set {@code METAOBJECTS_TEST_MYSQL_URL} ({@code jdbc:mysql://host:port/db}, with
 * {@code METAOBJECTS_TEST_MYSQL_USER} / {@code _PASSWORD}) to run against an existing server
 * instead. The test then owns that database: it creates and drops its own table.
 */
public final class MySqlContainer implements AutoCloseable {
    private static final String URL_ENV = "METAOBJECTS_TEST_MYSQL_URL";
    private static final String IMAGE = "mysql:8.4";
    private static final String DB = "mo_test";
    private static final String PASSWORD = "test";
    private static final int START_ATTEMPTS = 3;
    private static final int READY_TIMEOUT_S =
        Integer.parseInt(System.getenv().getOrDefault("MO_MYSQL_READY_TIMEOUT_S", "180"));

    private final String name;      // null when an existing server is used
    private final String jdbcUrl;
    private final String username;
    private final String password;

    public MySqlContainer() {
        String existing = System.getenv(URL_ENV);
        if (existing != null && !existing.isBlank()) {
            this.name = null;
            this.jdbcUrl = existing;
            this.username = System.getenv().getOrDefault("METAOBJECTS_TEST_MYSQL_USER", "root");
            this.password = System.getenv().getOrDefault("METAOBJECTS_TEST_MYSQL_PASSWORD", "");
            return;
        }
        this.name = "metaobjects-mysql-" + UUID.randomUUID().toString().substring(0, 8);
        this.username = "root";
        this.password = PASSWORD;
        String started = null;
        RuntimeException last = null;
        for (int attempt = 1; attempt <= START_ATTEMPTS && started == null; attempt++) {
            int port = pickFreePort();
            try {
                runDocker("run", "-d", "--name", name,
                    "-e", "MYSQL_ROOT_PASSWORD=" + PASSWORD,
                    "-e", "MYSQL_DATABASE=" + DB,
                    "-p", port + ":3306",
                    IMAGE);
            } catch (RuntimeException e) {
                last = e;
                forceRemove();
                continue;
            }
            String candidate = "jdbc:mysql://localhost:" + port + "/" + DB;
            try {
                waitForReady(candidate);
                started = candidate;
            } catch (RuntimeException e) {
                last = e;
                forceRemove();
            }
        }
        if (started == null) {
            throw new RuntimeException("mysql container '" + name + "' failed to start in "
                + START_ATTEMPTS + " attempts", last);
        }
        this.jdbcUrl = started;
    }

    public String jdbcUrl()  { return jdbcUrl; }
    public String username() { return username; }
    public String password() { return password; }

    public Connection open() throws SQLException {
        return DriverManager.getConnection(jdbcUrl, username, password);
    }

    @Override public void close() {
        if (name != null) forceRemove();
    }

    // MySQL's entrypoint runs a temporary server to initialise the data directory, stops it,
    // then starts the real one. Readiness needs both: the final server has logged its start,
    // and a JDBC connection to the created database succeeds.
    private void waitForReady(String url) {
        long deadline = System.currentTimeMillis() + READY_TIMEOUT_S * 1000L;
        while (System.currentTimeMillis() < deadline) {
            String state = inspectState();
            if (state == null || !"running".equals(state)) {
                throw new RuntimeException("mysql container '" + name + "' is '"
                    + (state == null ? "gone" : state) + "', not running. docker logs:\n" + tailLogs());
            }
            if (canConnect(url) && initComplete()) return;
            try { Thread.sleep(500); } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
        throw new RuntimeException("mysql container '" + name + "' did not become ready within "
            + READY_TIMEOUT_S + "s. docker logs:\n" + tailLogs());
    }

    private boolean initComplete() {
        // The temporary server listens on "port: 0"; only the final server logs port 3306.
        String logs = runDockerQuiet("logs", name);
        return logs.contains("ready for connections") && logs.contains("port: 3306");
    }

    private boolean canConnect(String url) {
        try (Connection c = DriverManager.getConnection(url, username, password)) {
            return c.isValid(2);
        } catch (SQLException ignored) {
            return false;
        }
    }

    private void forceRemove() {
        try { runDocker("rm", "-f", name); } catch (RuntimeException ignored) { /* already gone */ }
    }

    private String inspectState() {
        try { return runDocker("inspect", "-f", "{{.State.Status}}", name); }
        catch (RuntimeException e) { return null; }
    }

    private String tailLogs() {
        return runDockerQuiet("logs", "--tail", "40", name);
    }

    private static String runDockerQuiet(String... args) {
        try { return runDocker(args); }
        catch (RuntimeException e) { return "(docker " + args[0] + " unavailable: " + e.getMessage() + ")"; }
    }

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
            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) out.append(line).append('\n');
            }
            int exit = p.waitFor();
            if (exit != 0) {
                throw new RuntimeException("docker " + String.join(" ", args)
                    + " failed (exit=" + exit + "): " + out);
            }
            return out.toString().trim();
        } catch (IOException | InterruptedException e) {
            throw new RuntimeException("docker " + String.join(" ", args) + " threw", e);
        }
    }
}
