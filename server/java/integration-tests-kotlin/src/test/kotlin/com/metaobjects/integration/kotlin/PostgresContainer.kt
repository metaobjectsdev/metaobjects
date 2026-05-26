package com.metaobjects.integration.kotlin

import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
import java.sql.DriverManager
import java.util.UUID

/**
 * Start a fresh Postgres container by shelling out to the `docker` CLI directly.
 *
 * Implementation note: testcontainers-java 1.21.x bundles docker-java 3.4.x
 * which hardcodes a client API version (1.32-class) below the minimum
 * supported by recent Docker daemons. The hand-managed CLI path here is small,
 * fast (~3s incl. pg_isready), and avoids the version-negotiation issue
 * entirely. Mirrors the Java port's `PostgresContainer.java` and the TS port's
 * `postgres-container.ts`.
 */
class PostgresContainer : AutoCloseable {
    private val name: String = "metaobjects-test-kt-" + UUID.randomUUID().toString().substring(0, 8)
    private val port: Int = pickFreePort()
    val jdbcUrl: String

    val username: String = PG_USER
    val password: String = PG_PASSWORD

    init {
        runDocker(
            "run", "-d", "--rm",
            "--name", name,
            "-e", "POSTGRES_PASSWORD=$PG_PASSWORD",
            "-p", "$port:5432",
            IMAGE,
        )
        jdbcUrl = "jdbc:postgresql://localhost:$port/postgres"
        waitForReady()
    }

    override fun close() {
        try {
            runDocker("rm", "-f", name)
        } catch (_: RuntimeException) {
            // Container may already be gone; ignore.
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private fun waitForReady() {
        val deadline = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < deadline) {
            try {
                val p = ProcessBuilder("docker", "exec", name, "pg_isready", "-U", PG_USER)
                    .redirectErrorStream(true)
                    .start()
                if (p.waitFor() == 0 && canConnect()) return
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
        throw RuntimeException("postgres container '$name' did not become ready within 30s")
    }

    private fun canConnect(): Boolean = try {
        DriverManager.getConnection(jdbcUrl, PG_USER, PG_PASSWORD).use { c -> c.isValid(2) }
    } catch (_: Exception) {
        false
    }

    companion object {
        private const val IMAGE = "postgres:16-alpine"
        private const val PG_USER = "postgres"
        private const val PG_PASSWORD = "test"

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
