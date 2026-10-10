package com.metaobjects.integration.kotlin

import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
import java.sql.DriverManager
import java.util.UUID

/**
 * A throwaway MySQL database for the report scenarios, started through the `docker` CLI.
 *
 * Same approach as [PostgresContainer] and the Java port's `MySqlContainer.java`: testcontainers-java's
 * bundled docker-java cannot negotiate with current Docker daemons. Only the per-container mode
 * exists; there is no shared CI sidecar for MySQL. Set `METAOBJECTS_TEST_MYSQL_URL`
 * (`jdbc:mysql://host:port/db`, with `METAOBJECTS_TEST_MYSQL_USER` / `_PASSWORD`) to run against an
 * existing server instead: the test then owns that database.
 */
class MySqlContainer : AutoCloseable {
    private val name: String?          // null when an existing server is used
    val jdbcUrl: String
    val username: String
    val password: String

    init {
        val existing = System.getenv(URL_ENV)
        if (!existing.isNullOrBlank()) {
            name = null
            jdbcUrl = existing
            username = System.getenv("METAOBJECTS_TEST_MYSQL_USER") ?: "root"
            password = System.getenv("METAOBJECTS_TEST_MYSQL_PASSWORD") ?: ""
        } else {
            name = "metaobjects-mysql-kt-" + UUID.randomUUID().toString().substring(0, 8)
            username = "root"
            password = PASSWORD
            var started: String? = null
            var last: RuntimeException? = null
            for (attempt in 1..START_ATTEMPTS) {
                if (started != null) break
                val port = ServerSocket(0).use { it.localPort }
                try {
                    runDocker(
                        "run", "-d", "--name", name,
                        "-e", "MYSQL_ROOT_PASSWORD=$PASSWORD",
                        "-e", "MYSQL_DATABASE=$DB",
                        "-p", "$port:3306",
                        IMAGE,
                    )
                } catch (e: RuntimeException) {
                    last = e
                    forceRemove()
                    continue
                }
                val candidate = "jdbc:mysql://localhost:$port/$DB"
                try {
                    waitForReady(candidate)
                    started = candidate
                } catch (e: RuntimeException) {
                    last = e
                    forceRemove()
                }
            }
            jdbcUrl = started ?: throw RuntimeException(
                "mysql container '$name' failed to start in $START_ATTEMPTS attempts", last,
            )
        }
    }

    override fun close() {
        if (name != null) forceRemove()
    }

    // MySQL's entrypoint runs a temporary server to initialise the data directory, stops it, then
    // starts the real one. Readiness needs both: the final server has logged its start, and a JDBC
    // connection to the created database succeeds.
    private fun waitForReady(url: String) {
        val deadline = System.currentTimeMillis() + READY_TIMEOUT_S * 1000L
        while (System.currentTimeMillis() < deadline) {
            val state = inspectState()
            if (state != "running") {
                throw RuntimeException("mysql container '$name' is '$state', not running. docker logs:\n" + tailLogs())
            }
            if (canConnect(url) && initComplete()) return
            try {
                Thread.sleep(500)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }
        }
        throw RuntimeException("mysql container '$name' did not become ready within ${READY_TIMEOUT_S}s. docker logs:\n" + tailLogs())
    }

    // The temporary server listens on "port: 0"; only the final server logs port 3306.
    private fun initComplete(): Boolean {
        val logs = runDockerQuiet("logs", name!!)
        return logs.contains("ready for connections") && logs.contains("port: 3306")
    }

    private fun canConnect(url: String): Boolean = try {
        DriverManager.getConnection(url, username, password).use { it.isValid(2) }
    } catch (_: Exception) {
        false
    }

    private fun forceRemove() {
        try { runDocker("rm", "-f", name!!) } catch (_: RuntimeException) { /* already gone */ }
    }

    private fun inspectState(): String = try {
        runDocker("inspect", "-f", "{{.State.Status}}", name!!)
    } catch (_: RuntimeException) {
        "gone"
    }

    private fun tailLogs(): String = runDockerQuiet("logs", "--tail", "40", name!!)

    companion object {
        private const val URL_ENV = "METAOBJECTS_TEST_MYSQL_URL"
        private const val IMAGE = "mysql:8.4"
        private const val DB = "mo_test"
        private const val PASSWORD = "test"
        private const val START_ATTEMPTS = 3
        private val READY_TIMEOUT_S: Int = (System.getenv("MO_MYSQL_READY_TIMEOUT_S") ?: "180").toInt()

        private fun runDockerQuiet(vararg args: String): String = try {
            runDocker(*args)
        } catch (e: RuntimeException) {
            "(docker ${args[0]} unavailable: ${e.message})"
        }

        private fun runDocker(vararg args: String): String {
            val p = ProcessBuilder("docker", *args).redirectErrorStream(true).start()
            val out = StringBuilder()
            BufferedReader(InputStreamReader(p.inputStream, StandardCharsets.UTF_8)).use { r ->
                r.forEachLine { out.append(it).append('\n') }
            }
            val exit = p.waitFor()
            if (exit != 0) throw RuntimeException("docker ${args.joinToString(" ")} failed (exit=$exit): $out")
            return out.toString().trim()
        }
    }
}
