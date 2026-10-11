package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * ONE registry mapping each FR-044 report's name to the hand-written reference Exposed Table
 * that reads its view. It lives in the tables package because both consumers must read the
 * same set: the persistence lane resolves a scenario's entity to a table through it
 * (`QueryScenarioRunner.tableFor`), and the codegen cross-check iterates it to hold every
 * reference table to the same column expectations as the generator (`KotlinCodegenMatchesReferenceTest`).
 * Restating the names in both leaves drift caught only by a runtime
 * `else -> error(...)` in the OTHER lane's test.
 *
 * A report has no primary key, so only `list` and `count` reach these.
 */
internal object ReportViews {
    val BY_NAME: Map<String, Table> = mapOf(
        "ProgramMinutes" to ProgramMinutesView,
        "FitnessTotals" to FitnessTotalsView,
        "ProgramsByMonth" to ProgramsByMonthView,
        "ProgramsByWeek" to ProgramsByWeekView,
        "RecentPrograms" to RecentProgramsView,
        "AssetActivity" to AssetActivityView,
        // A @spine report (rows from the spine entity) and a report of defaulted measures.
        "ProgramRoster" to ProgramRosterView,
        "ProgramLongWeeks" to ProgramLongWeeksView,
        // Boolean `any` / `all` measures, with and without @spine.
        "ProgramFlags" to ProgramFlagsView,
        "ProgramFlagRoster" to ProgramFlagRosterView,
        "FitnessTotalsFilled" to FitnessTotalsFilledView,
        // Reports for the vocabulary the first nine do not reach: numeric, temporal, boolean/
        // uuid/int-enum dimensions, multi-hop and self-reference paths, an empty scope.
        "MeasurementStats" to MeasurementStatsView,
        "MeasurementStatsFilled" to MeasurementStatsFilledView,
        "AssetDays" to AssetDaysView,
        "AllTypesBreakdown" to AllTypesBreakdownView,
        "ProgramsOverTime" to ProgramsOverTimeView,
        "LiveIntroPrograms" to LiveIntroProgramsView,
        "ProgramsEmptyScope" to ProgramsEmptyScopeView,
        "WeekShapes" to WeekShapesView,
        "SessionsByProgram" to SessionsByProgramView,
        "ProgramSessions" to ProgramSessionsView,
        "NodesByParent" to NodesByParentView,
        "AuthsByKind" to AuthsByKindView,
    )
}
