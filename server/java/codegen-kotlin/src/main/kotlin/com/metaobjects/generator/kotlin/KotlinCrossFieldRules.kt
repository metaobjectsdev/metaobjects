package com.metaobjects.generator.kotlin

import com.metaobjects.MetaData
import com.metaobjects.database.CoreDBMetaDataProvider
import com.metaobjects.field.BooleanField
import com.metaobjects.field.CurrencyField
import com.metaobjects.field.DateField
import com.metaobjects.field.DecimalField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.FloatField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.EnumField
import com.metaobjects.field.MetaField
import com.metaobjects.field.StringField
import com.metaobjects.field.InetField
import com.metaobjects.field.TimeField
import com.metaobjects.field.TimestampField
import com.metaobjects.field.UriField
import com.metaobjects.field.UuidField
import com.metaobjects.`object`.MetaObject
import com.metaobjects.validator.AtLeastOneValidator
import com.metaobjects.validator.ComparisonValidator
import com.metaobjects.validator.MetaValidator
import com.metaobjects.validator.PresentIffValidator
import com.metaobjects.validator.RequiredWhenValidator
import com.squareup.kotlinpoet.CodeBlock

/**
 * Entity-scoped cross-field validators (comparison / requiredWhen / presentIff / atLeastOne) as
 * Kotlin boolean expressions. Read by the entity data class's `isXxxValid` properties and by the
 * TPH per-subtype create handler, which validates the union body rather than the subtype class.
 */
object KotlinCrossFieldRules {
    private fun isNumericCross(f: MetaField<*>): Boolean =
        f is IntegerField || f is LongField || f is DoubleField || f is FloatField ||
            f is DecimalField || f is CurrencyField

    private fun isTemporalCross(f: MetaField<*>): Boolean =
        f is DateField || f is TimeField || f is TimestampField

    private fun flag(f: MetaField<*>, attr: String): Boolean =
        f.hasMetaAttr(attr, true) &&
            runCatching { f.getMetaAttr(attr, true).value }.getOrNull()?.toString()?.trim().toBoolean()

    /**
     * What decides the Kotlin type of a field beyond its subtype: a timestamp is an Instant unless
     * `@localTime`, and a uri/inet is a native type unless `@lenient` (then a String). Read from the
     * attributes rather than the type mapper so an ejected copy of this file stands alone.
     */
    private fun nativeShape(f: MetaField<*>): Pair<Boolean, Boolean> =
        Pair(f is TimestampField && flag(f, CoreDBMetaDataProvider.LOCAL_TIME), (f is UriField || f is InetField) && flag(f, UriField.ATTR_LENIENT))

    /**
     * The comparison for two fields, or null when the pair has no sound one. Mirrors the C#
     * generator: numerics compare with each other, strings and temporals only with their own
     * subtype and Kotlin type (a date has no ordering against a timestamp, nor an Instant against a
     * `@localTime` LocalDateTime, and casting both to Comparable throws
     * ClassCastException inside the validity property, turning a create into a 500), and
     * boolean, enum, uuid, uri and inet fields only test equality. Anything else is skipped, like every other port.
     */
    private fun comparison(l: MetaField<*>, r: MetaField<*>, op: String, kop: String, ref: (MetaField<*>) -> String): CodeBlock? {
        val ordering = op == "gt" || op == "gte" || op == "lt" || op == "lte"
        val same = l.subType == r.subType
        if (isNumericCross(l) && isNumericCross(r) && !same) {
            return CodeBlock.of("java.math.BigDecimal(%L.toString()).compareTo(java.math.BigDecimal(%L.toString())) $kop 0", ref(l), ref(r))
        }
        if (!same) return null
        val comparable = isNumericCross(l) || l is StringField || isTemporalCross(l)
        val equatable = !ordering && (l is BooleanField || l is EnumField || l is UuidField || l is UriField || l is InetField)
        if (!comparable && !equatable) return null
        if (nativeShape(l) != nativeShape(r)) return null
        if (comparable) {
            return CodeBlock.of("(%L as Comparable<Any>).compareTo(%L) $kop 0", ref(l), ref(r))
        }
        return CodeBlock.of("(%L %L %L)", ref(l), if (op == "eq") "==" else "!=", ref(r))
    }

    private fun crossAttr(v: MetaData, attr: String): String? =
        if (v.hasMetaAttr(attr)) v.getMetaAttr(attr).value?.toString() else null

    /** Kotlin boolean expression: does the gating property equal the @equals literal (null gate = false)? */
    private fun crossEquals(w: MetaField<*>, wr: String, raw: String?): CodeBlock {
        val s = raw ?: ""
        if (w is BooleanField) {
            val truthy = s == "true" || s == "1" || s == "TRUE"
            return CodeBlock.of("(%L == %L)", wr, truthy)
        }
        if (isNumericCross(w) && Regex("-?\\d+(\\.\\d+)?").matches(s)) {
            return CodeBlock.of(
                "(%L != null && java.math.BigDecimal(%L.toString()).compareTo(java.math.BigDecimal(%S)) == 0)",
                wr, wr, s,
            )
        }
        return CodeBlock.of("(%L?.toString() == %S)", wr, s)
    }

    /**
     * The entity-scoped cross-field validators as Kotlin boolean expressions (true = satisfied),
     * in declaration order. [ref] renders a field reference: the bare property inside the data
     * class, or a body accessor / pinned literal in a controller that validates a different bean.
     */
    fun rules(obj: MetaObject, ref: (MetaField<*>) -> String): List<Pair<MetaValidator, CodeBlock>> {
        val pk = obj.primaryIdentity
        val fields = obj.metaFields.filterNot { f ->
            f.isReadOnlyMutability || f.isDerived ||
                (pk != null && pk.isAutoGenerated && pk.fields.contains(f.name))
        }.associateBy { it.name }
        val out = mutableListOf<Pair<MetaValidator, CodeBlock>>()
        for (v in obj.getChildren(MetaValidator::class.java)) {
            val expr: CodeBlock = when (v) {
                is ComparisonValidator -> {
                    val l = fields[crossAttr(v, ComparisonValidator.ATTR_LEFT)] ?: continue
                    val r = fields[crossAttr(v, ComparisonValidator.ATTR_RIGHT)] ?: continue
                    val opName = crossAttr(v, ComparisonValidator.ATTR_OP)
                    val op = when (opName) {
                        "gt" -> ">"; "gte" -> ">="; "lt" -> "<"; "lte" -> "<="; "ne" -> "!="; "eq" -> "=="
                        else -> continue
                    }
                    if (l.isArrayType || r.isArrayType) continue
                    val cmp = comparison(l, r, opName!!, op, ref) ?: continue
                    CodeBlock.of("%L == null || %L == null || %L", ref(l), ref(r), cmp)
                }
                is RequiredWhenValidator, is PresentIffValidator -> {
                    val t = fields[crossAttr(v, RequiredWhenValidator.ATTR_FIELD)] ?: continue
                    val w = fields[crossAttr(v, RequiredWhenValidator.ATTR_WHEN)] ?: continue
                    if (w.isArrayType) continue
                    val gate = crossEquals(w, ref(w), crossAttr(v, RequiredWhenValidator.ATTR_EQUALS))
                    if (v is RequiredWhenValidator) CodeBlock.of("!%L || %L != null", gate, ref(t))
                    else CodeBlock.of("(%L != null) == %L", ref(t), gate)
                }
                is AtLeastOneValidator -> {
                    val raw = if (v.hasMetaAttr(AtLeastOneValidator.ATTR_FIELDS))
                        v.getMetaAttr(AtLeastOneValidator.ATTR_FIELDS).value else null
                    val names = when (raw) {
                        is Collection<*> -> raw.map { it.toString() }
                        null -> emptyList()
                        else -> listOf(raw.toString())
                    }
                    if (names.isEmpty() || names.any { it !in fields }) continue
                    CodeBlock.builder().apply {
                        names.forEachIndexed { i, n -> if (i > 0) add(" || "); add("%L != null", ref(fields.getValue(n))) }
                    }.build()
                }
                else -> continue
            }
            out.add(v to expr)
        }
        return out
    }
}
