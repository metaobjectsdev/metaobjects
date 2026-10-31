package com.metaobjects.generator.kotlin.exposed1x

import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.URI
import java.nio.charset.StandardCharsets
import java.sql.DriverManager
import java.util.UUID

/**
 * Obtain a fresh, isolated Postgres database for the issue #390 round-trip test.
 *
 * Adapted verbatim from `integration-tests-kotlin`'s `PostgresContainer.kt` (same two modes,
 * same docker-CLI path, and Ryuk covers it through [ReaperLabels]). Duplicated rather than shared because
 * this module intentionally depends on NEITHER `integration-tests-kotlin` (which pins Exposed
 * 0.x) NOR a test-jar of it (none is published) — see this module's pom for why the two stay
 * independent.
 */
class PostgresContainer : AutoCloseable {
    private val shared: Boolean
    private val name: String?
    private val adminUrl: String?
    private val createdDb: String?
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
            createdDb = "mo_test_kt_exp1x_" + UUID.randomUUID().toString().replace("-", "")
            execAdmin("CREATE DATABASE \"$createdDb\"") // generated name — no user input
            jdbcUrl = "jdbc:postgresql://${u.host}:$port/$createdDb"
        } else {
            shared = false
            adminUrl = null
            createdDb = null
            username = PG_USER
            password = PG_PASSWORD
            name = "metaobjects-test-kt-exp1x-" + UUID.randomUUID().toString().substring(0, 8)
            // Docker assigns the host port at bind time (`-p 127.0.0.1::5432`, read back with
            // `docker port`): a port picked, released and handed to docker races parallel lanes.
            jdbcUrl = try {
                runDocker(
                    *ReaperLabels.dockerRun(
                        "--name", name,
                        "-e", "POSTGRES_PASSWORD=$PG_PASSWORD",
                        "-p", "127.0.0.1::5432",
                        IMAGE,
                    ),
                )
                val url = "jdbc:postgresql://127.0.0.1:${publishedPort(name, 5432)}/postgres"
                waitForReady(url)
                url
            } catch (e: RuntimeException) {
                forceRemove()
                throw e
            }
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
            runDocker("rm", "-f", "-v", name!!)
        } catch (_: RuntimeException) {
            // Container may already be gone; ignore.
        }
    }

    private fun execAdmin(sql: String) {
        DriverManager.getConnection(adminUrl, username, password).use { c ->
            c.createStatement().use { s -> s.execute(sql) }
        }
    }

    private fun waitForReady(url: String) {
        val deadline = System.currentTimeMillis() + (READY_TIMEOUT_S * 1000L)
        while (System.currentTimeMillis() < deadline) {
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

    private fun forceRemove() {
        try { runDocker("rm", "-f", "-v", name!!) } catch (_: RuntimeException) { /* already gone */ }
    }

    private fun inspectState(): String = try {
        runDocker("inspect", "-f", "{{.State.Status}}", name!!)
    } catch (_: RuntimeException) {
        "gone"
    }

    private fun tailLogs(): String = try {
        runDocker("logs", "--tail", "40", name!!)
    } catch (e: RuntimeException) {
        "(docker logs unavailable: ${e.message})"
    }

    companion object {
        private const val SHARED_PG_URL_ENV = "METAOBJECTS_TEST_PG_URL"
        private const val IMAGE = "postgres:16-alpine"
        private const val PG_USER = "postgres"
        private const val PG_PASSWORD = "test"
        private val READY_TIMEOUT_S: Int =
            (System.getenv("MO_PG_READY_TIMEOUT_S") ?: "120").toInt()

        /** True iff the `docker` CLI is on PATH and the daemon answers — used to SKIP (not
         *  silently omit) the round-trip test with an explicit, named reason when neither this
         *  nor [SHARED_PG_URL_ENV] is available. */
        fun dockerAvailable(): Boolean {
            if (!System.getenv(SHARED_PG_URL_ENV).isNullOrBlank()) return true
            return try {
                val p = ProcessBuilder("docker", "info").redirectErrorStream(true).start()
                p.waitFor() == 0
            } catch (_: Exception) {
                false
            }
        }

        /** The host port docker assigned to [containerPort] (`docker port` prints `127.0.0.1:<port>`). */
        private fun publishedPort(container: String, containerPort: Int): Int {
            val out = runDocker("port", container, "$containerPort/tcp")
            return out.lineSequence().firstOrNull()?.substringAfterLast(':')?.trim()?.toIntOrNull()
                ?: throw RuntimeException("docker port $container $containerPort/tcp printed no port: '$out'")
        }

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
