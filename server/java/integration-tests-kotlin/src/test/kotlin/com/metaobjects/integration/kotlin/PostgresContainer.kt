package com.metaobjects.integration.kotlin

import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.ServerSocket
import java.net.URI
import java.nio.charset.StandardCharsets
import java.sql.DriverManager
import java.util.UUID

/**
 * Obtain a fresh, isolated Postgres database per scenario.
 *
 * Two modes, mirroring the TS/Java/Python/C# suites:
 *  1. **Shared sidecar (CI)**: if `METAOBJECTS_TEST_PG_URL` is set, connect to
 *     that already-running Postgres and `CREATE DATABASE` a uniquely-named
 *     database per instance (dropping it on close). No container boot / image
 *     pull on the hot path — the point of the shared `services: postgres` CI
 *     sidecar. Each scenario still gets a pristine empty database, so isolation
 *     is identical to the per-container path.
 *  2. **Per-container (local dev)**: with no env var, boot a fresh container via
 *     the `docker` CLI, exactly as before.
 *
 * Implementation note (mode 2): testcontainers-java 1.21.x bundles docker-java
 * 3.4.x which hardcodes a client API version (1.32-class) below the minimum
 * supported by recent Docker daemons. The hand-managed CLI path here is small,
 * fast (~3s incl. pg_isready), and avoids the version-negotiation issue
 * entirely. Mirrors the Java port's `PostgresContainer.java` and the TS port's
 * `postgres-container.ts`. The shared sidecar mode sidesteps this entirely.
 */
class PostgresContainer : AutoCloseable {
    private val shared: Boolean
    private val name: String?          // null in shared mode
    private val adminUrl: String?      // JDBC admin URL, null in per-container mode
    private val createdDb: String?     // created database name, null in per-container mode
    val jdbcUrl: String
    val username: String
    val password: String

    init {
        val sharedUri = System.getenv(SHARED_PG_URL_ENV)
        if (!sharedUri.isNullOrBlank()) {
            shared = true
            name = null
            val u = URI.create(sharedUri)
            val userInfo = (u.userInfo ?: "").split(":", limit = 2)
            username = userInfo.getOrElse(0) { PG_USER }
            password = userInfo.getOrElse(1) { "" }
            val port = if (u.port == -1) 5432 else u.port
            val adminDb = if (u.path.isNullOrEmpty() || u.path.length <= 1) "postgres" else u.path.substring(1)
            adminUrl = "jdbc:postgresql://${u.host}:$port/$adminDb"
            createdDb = "mo_test_kt_" + UUID.randomUUID().toString().replace("-", "")
            execAdmin("CREATE DATABASE \"$createdDb\"") // generated name — no user input
            jdbcUrl = "jdbc:postgresql://${u.host}:$port/$createdDb"
        } else {
            shared = false
            adminUrl = null
            createdDb = null
            username = PG_USER
            password = PG_PASSWORD
            name = "metaobjects-test-kt-" + UUID.randomUUID().toString().substring(0, 8)
            // PORT RACE. pickFreePort() closes its probe socket and hands the number to
            // docker, which binds it LATER -- a check-then-act gap. Alone it never bites;
            // under a full CI run several ports start containers at once and two can be
            // handed the same number. The loser's container is created and then dies, and
            // a readiness probe that only asks `docker exec` cannot tell that from a slow
            // boot. Retry on a FRESH port.
            //
            // Deliberately NOT `--rm`: an auto-removed container takes its logs with it,
            // so the one artefact explaining the failure vanishes exactly when it is
            // needed. close() force-removes, so nothing leaks.
            var startedUrl: String? = null
            var lastFailure: RuntimeException? = null
            for (attempt in 1..START_ATTEMPTS) {
                if (startedUrl != null) break
                val port = pickFreePort()
                try {
                    runDocker(
                        "run", "-d",
                        "--name", name,
                        "-e", "POSTGRES_PASSWORD=$PG_PASSWORD",
                        "-p", "$port:5432",
                        IMAGE,
                    )
                } catch (e: RuntimeException) {
                    lastFailure = e   // docker refused the bind outright
                    forceRemove()
                    continue
                }
                val candidate = "jdbc:postgresql://localhost:$port/postgres"
                try {
                    waitForReady(candidate)
                    startedUrl = candidate
                } catch (e: RuntimeException) {
                    lastFailure = e
                    forceRemove()
                }
            }
            jdbcUrl = startedUrl ?: throw RuntimeException(
                "postgres container '$name' failed to start in $START_ATTEMPTS attempts", lastFailure,
            )
        }
    }

    override fun close() {
        if (shared) {
            try {
                execAdmin("DROP DATABASE IF EXISTS \"$createdDb\" WITH (FORCE)")
            } catch (_: RuntimeException) {
                // Best-effort cleanup.
            }
            return
        }
        try {
            runDocker("rm", "-f", name!!) // non-null in per-container mode
        } catch (_: RuntimeException) {
            // Container may already be gone; ignore.
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /** Run a statement against the shared sidecar's admin database (auto-commit). */
    private fun execAdmin(sql: String) {
        DriverManager.getConnection(adminUrl, username, password).use { c ->
            c.createStatement().use { s -> s.execute(sql) }
        }
    }

    private fun waitForReady(url: String) {
        // READINESS WINDOW. 30s was too tight: under a FULL local-CI run several ports
        // spin their own Postgres concurrently, and a container that is merely slow to
        // boot produces a red gate indistinguishable from a real failure -- it fires
        // BEFORE any test logic. Raising the bound costs nothing when the container is
        // ready quickly (this polls every 250ms and returns immediately).
        val deadline = System.currentTimeMillis() + (READY_TIMEOUT_S * 1000L)
        while (System.currentTimeMillis() < deadline) {
            // FAIL FAST ON A DEAD CONTAINER -- `docker exec` alone cannot tell "still
            // booting" from "exited seconds ago", so a dead container used to burn the
            // whole window and report a TIMEOUT, which reads as slowness and is not.
            val state = inspectState()
            if (state != "running") {
                throw RuntimeException(
                    "postgres container '$name' is '$state', not running -- it died during " +
                        "startup rather than being slow. docker logs:\n" + tailLogs(),
                )
            }
            try {
                val p = ProcessBuilder("docker", "exec", name, "pg_isready", "-U", PG_USER)
                    .redirectErrorStream(true)
                    .start()
                if (p.waitFor() == 0 && canConnect(url)) return
            } catch (_: Exception) {
                // Try again.
            }
            try {
                Thread.sleep(250)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }
        }
        throw RuntimeException(
            "postgres container '$name' did not become ready within ${READY_TIMEOUT_S}s " +
                "(state=${inspectState()}). docker logs:\n" + tailLogs(),
        )
    }

    private fun canConnect(url: String): Boolean = try {
        DriverManager.getConnection(url, PG_USER, PG_PASSWORD).use { c -> c.isValid(2) }
    } catch (_: Exception) {
        false
    }

    /** Best-effort teardown between start attempts. */
    private fun forceRemove() {
        try { runDocker("rm", "-f", name!!) } catch (_: RuntimeException) { /* already gone */ }  // non-null in per-container mode
    }

    /** The container's docker state, or "gone" when it cannot be determined. */
    private fun inspectState(): String = try {
        runDocker("inspect", "-f", "{{.State.Status}}", name!!)  // non-null in per-container mode
    } catch (_: RuntimeException) {
        "gone"
    }

    /** Last few log lines, for an error that would otherwise name only a symptom. */
    private fun tailLogs(): String = try {
        runDocker("logs", "--tail", "40", name!!)  // non-null in per-container mode
    } catch (e: RuntimeException) {
        "(docker logs unavailable: ${e.message})"
    }

    companion object {
        /** Env var naming the shared CI Postgres sidecar (admin URL). Unset = per-container fallback. */
        private const val SHARED_PG_URL_ENV = "METAOBJECTS_TEST_PG_URL"
        private const val IMAGE = "postgres:16-alpine"
        private const val PG_USER = "postgres"
        private const val PG_PASSWORD = "test"

        /** Fresh-port retries before giving up -- see the port-race note above. */
        private const val START_ATTEMPTS = 3

        /** Container readiness bound, seconds. Overridable so a loaded CI box can widen it. */
        private val READY_TIMEOUT_S: Int =
            (System.getenv("MO_PG_READY_TIMEOUT_S") ?: "120").toInt()

        private fun pickFreePort(): Int = ServerSocket(0).use { it.localPort }

        private fun runDocker(vararg args: String): String {
            val cmd = arrayOf("docker", *args)
            val p = ProcessBuilder(*cmd).redirectErrorStream(true).start()
            val out = StringBuilder()
            BufferedReader(InputStreamReader(p.inputStream, StandardCharsets.UTF_8)).use { r ->
                r.forEachLine { out.append(it).append('\n') }
            }
            val exit = p.waitFor()
            if (exit != 0) {
                throw RuntimeException("docker ${args.joinToString(" ")} failed (exit=$exit): $out")
            }
            return out.toString().trim()
        }
    }
}
