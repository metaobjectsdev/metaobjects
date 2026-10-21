package com.metaobjects.integration.kotlin.tables

import org.jetbrains.exposed.sql.Table

/**
 * Hand-written reference Exposed Table mapping the `GadgetEventsByLabel` report from
 * `fixtures/persistence-conformance/canonical/meta.fitness.json`, backed by `v_gadget_events_by_label`.
 * `gadgetLabel` is an INTEGER: the dimension reaches `Labeled.label` through `@via`, and the entity
 * that `@via` reaches (`Gadget`) redeclares it as an int in column `gadget_code`, so the report groups
 * by that column and not by the base's string column.
 */
object GadgetEventsByLabelView : Table("v_gadget_events_by_label") {
    val gadgetLabel = integer("gadgetLabel")
    val gadgetEvents = long("gadgetEvents")
}
