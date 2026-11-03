package com.metaobjects.integration.kotlin

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertDoesNotThrow
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path
import kotlin.test.assertEquals

/**
 * field.duration orders on every engine (port-local scenario `duration-ordering/`): a range
 * filter, an equality across spellings and a sort, through Exposed, on Postgres (native interval)
 * and SQLite (a 64-bit microsecond count).
 */
internal class DurationOrderingScenarioTest {

    private fun scenario(): Scenarios.QueryScenario {
        val dir = Path.of(DurationOrderingScenarioTest::class.java.getResource("/duration-ordering")!!.toURI())
        val all = ScenarioLoader.loadQueries(dir)
        assertEquals(1, all.size)
        return all[0]
    }

    @Test
    fun `orders on SQLite`(@TempDir dir: Path) {
        val s = scenario()
        assertDoesNotThrow {
            QueryScenarioRunner.run(s, "jdbc:sqlite:${dir.resolve("duration.db")}", "", "", ScenarioEngine.SQLITE)
        }
    }

    @Test
    fun `orders on Postgres`() {
        val s = scenario()
        assertDoesNotThrow {
            PostgresContainer().use { pg -> QueryScenarioRunner.run(s, pg) }
        }
    }
}
