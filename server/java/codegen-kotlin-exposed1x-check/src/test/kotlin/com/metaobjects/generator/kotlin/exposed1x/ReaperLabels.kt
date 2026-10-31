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
 * run's. `TESTCONTAINERS_RYUK_DISABLED=true` turns the reaper off, as it does everywhere else.
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
}
