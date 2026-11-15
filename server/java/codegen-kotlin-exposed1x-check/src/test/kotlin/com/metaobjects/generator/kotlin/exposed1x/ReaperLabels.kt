package com.metaobjects.generator.kotlin.exposed1x

import org.testcontainers.DockerClientFactory
import org.testcontainers.utility.ResourceReaper

/**
 * Puts a `docker` CLI test container under Ryuk, the Testcontainers reaper.
 *
 * `close()` and an `@AfterAll` cannot run in a killed JVM: SIGKILL, the kernel OOM killer and
 * earlyoom all skip them, and SIGTERM runs shutdown hooks but no test teardown. Ryuk closes that
 * gap from outside the process. It runs in its own container and holds one TCP connection per
 * session. When that connection closes, for any reason, it waits ten seconds and removes everything
 * carrying all of the session's labels. The operating system closes the socket of a killed process,
 * so no code in the dying JVM has to run.
 *
 * Each JVM gets its own session, so one fork's death reaps that fork's containers and no other
 * run's. `TESTCONTAINERS_RYUK_DISABLED=true` turns the reaper off.
 *
 * [removeAtExit] covers what Ryuk does not: a run with Ryuk disabled, and a SIGTERM, which runs
 * shutdown hooks. [ramVolume] keeps a database's data directory in RAM: an image's `VOLUME` with no
 * mount becomes an anonymous volume on disk.
 *
 * Duplicated from `integration-tests-kotlin` for the reason [PostgresContainer] gives.
 */
internal object ReaperLabels {
    private val labelArgs: List<String> by lazy {
        DockerClientFactory.instance().client() // starts Ryuk and registers the session
        (DockerClientFactory.DEFAULT_LABELS + ResourceReaper.instance().labels).toSortedMap()
            .flatMap { (key, value) -> listOf("--label", "$key=$value") }
    }

    /**
     * `docker run -d <labels> <rest>`. The first call starts Ryuk, and finishes before the
     * container starts, so a JVM killed at any later moment is covered.
     */
    fun dockerRun(vararg rest: String): Array<String> =
        (listOf("run", "-d") + labelArgs + rest).toTypedArray()

    /** Upper bound for one database's data directory; tmpfs takes RAM only for what is written. */
    const val TMPFS_SIZE = "2g"

    /** `postgres` server options for a database whose contents may be lost at any moment. */
    val POSTGRES_DURABILITY_OFF: Array<String> =
        arrayOf("-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off")

    private val started: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()
    private val shutdownHook: Unit by lazy {
        Runtime.getRuntime().addShutdownHook(Thread(::removeAll, "remove-test-containers"))
    }

    /** `docker run` flags mounting a size-capped tmpfs at [path], the image's VOLUME. */
    fun ramVolume(path: String): Array<String> = arrayOf("--tmpfs", "$path:rw,size=$TMPFS_SIZE")

    /** Remove container [name] when the JVM shuts down, unless [forget] says it is gone. */
    fun removeAtExit(name: String) {
        started.add(name)
        shutdownHook
    }

    /** The launcher removed [name] itself. */
    fun forget(name: String) {
        started.remove(name)
    }

    private fun removeAll() {
        for (name in started) {
            try {
                ProcessBuilder("docker", "rm", "-f", "-v", name)
                    .redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .start().waitFor(60, java.util.concurrent.TimeUnit.SECONDS)
            } catch (_: Exception) {
                // Best effort: Ryuk still removes a labelled container.
            }
        }
    }
}
