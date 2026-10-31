package com.metaobjects.integration.kotlin

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit

/**
 * A killed JVM removes its container.
 *
 * Public behaviour: once a JVM that started a helper container dies without running any teardown,
 * Docker stops listing that container. The oracle is Docker itself, queried from outside the
 * killed JVM. A helper that labels nothing, or a reaper that accepts the label and removes nothing,
 * fails on the deadline.
 */
class ReaperKillTest {
    @Test
    fun `killed JVM removes its container`() {
        val output = Files.createTempFile("reaper-child", ".log")
        val builder = ProcessBuilder(
            Path.of(System.getProperty("java.home"), "bin", "java").toString(),
            "-cp", System.getProperty("java.class.path"), ReaperKillTest::class.java.name,
        ).redirectErrorStream(true).redirectOutput(output.toFile())
        builder.environment().remove("METAOBJECTS_TEST_PG_URL")
        val child = builder.start()
        var container = ""
        try {
            val port = awaitPort(child, output)
            container = docker("ps", "--filter", "publish=$port/tcp", "--format", "{{.Names}}")
            assertFalse(container.isEmpty(), "no container publishes port $port")

            child.destroyForcibly()
            assertTrue(child.waitFor(30, TimeUnit.SECONDS), "the child outlived SIGKILL")

            val deadline = System.currentTimeMillis() + REMOVAL_BOUND_MS
            while (exists(container) && System.currentTimeMillis() < deadline) Thread.sleep(250)
            assertFalse(exists(container), "$container outlived its killed JVM (${status(container)})")
        } finally {
            child.destroyForcibly()
            if (container.isNotEmpty()) docker("rm", "-f", "-v", container)
            Files.deleteIfExists(output)
        }
    }

    private fun awaitPort(child: Process, output: Path): String {
        val deadline = System.currentTimeMillis() + CHILD_READY_MS
        while (System.currentTimeMillis() < deadline && child.isAlive) {
            READY.find(Files.readString(output))?.let { return it.groupValues[1] }
            Thread.sleep(250)
        }
        throw AssertionError("reaper child never reported its container:\n" + Files.readString(output))
    }

    private fun exists(container: String): Boolean =
        docker("ps", "-a", "--filter", "name=^$container$", "--format", "{{.Names}}").isNotEmpty()

    private fun status(container: String): String =
        docker("ps", "-a", "--filter", "name=^$container$", "--format", "{{.Status}}")

    private fun docker(vararg args: String): String {
        val p = ProcessBuilder("docker", *args).redirectErrorStream(true).start()
        if (!p.waitFor(30, TimeUnit.SECONDS)) {
            p.destroyForcibly()
            throw AssertionError("docker ${args.joinToString(" ")} did not finish")
        }
        val out = p.inputStream.readAllBytes().toString(Charsets.UTF_8).trim()
        assertEquals(0, p.exitValue(), "docker ${args.joinToString(" ")}: $out")
        return out
    }

    companion object {
        private val READY = Regex("^READY (\\d+)$", RegexOption.MULTILINE)
        private const val CHILD_READY_MS = 60_000L
        // Ryuk waits 10s, then Docker has to finish the container's exit, and it cannot until the
        // overlay unmount has flushed the host filesystem's dirty pages. A busy disk makes removal
        // slow, not wrong. Measured with a 256 MiB backlog: 34-38s at 12 MB/s and 67-76s at 6 MB/s,
        // against under 11s at 6 MB/s with no backlog. Every removal succeeded.
        private const val REMOVAL_BOUND_MS = 120_000L

        /** The killed JVM: it starts a real helper container, reports the port and waits. */
        @JvmStatic
        fun main(args: Array<String>) {
            val pg = PostgresContainer()
            println("READY " + URI.create(pg.jdbcUrl.removePrefix("jdbc:")).port)
            Thread.sleep(600_000)
        }
    }
}
