package com.metaobjects.generator.kotlin

import com.metaobjects.MetaData
import com.metaobjects.database.CoreDBMetaDataProvider
import com.metaobjects.field.BooleanField
import com.metaobjects.field.CurrencyField
import com.metaobjects.field.DateField
import com.metaobjects.field.DecimalField
import com.metaobjects.field.DoubleField
import com.metaobjects.field.DurationField
import com.metaobjects.field.DurationWire
import com.metaobjects.field.EnumField
import com.metaobjects.field.FloatField
import com.metaobjects.field.InetField
import com.metaobjects.field.IntegerField
import com.metaobjects.field.LongField
import com.metaobjects.field.MetaField
import com.metaobjects.field.StringField
import com.metaobjects.field.TimeField
import com.metaobjects.field.TimestampField
import com.metaobjects.field.UriField
import com.metaobjects.field.UuidField
import com.metaobjects.`object`.MetaObject
import com.metaobjects.validator.AtLeastOneValidator
import com.metaobjects.validator.ComparisonValidator
import com.metaobjects.validator.ExactlyOneValidator
import com.metaobjects.validator.MetaValidator
import com.metaobjects.validator.PresentIffValidator
import com.metaobjects.validator.RequiredWhenValidator
import com.squareup.kotlinpoet.CodeBlock

/**
 * Entity-scoped cross-field validators (comparison / requiredWhen / presentIff / atLeastOne /
 * exactlyOne, each with an optional `@condition`) as Kotlin boolean expressions. Read by the entity data class's `isXxxValid` properties and by the
 * TPH per-subtype create handler, which validates the union body rather than the subtype class.
 */
object KotlinCrossFieldRules {
    private enum class CompareKind { NUMBER, DURATION, PLAIN }

    private fun compareKind(f: MetaField<*>?): CompareKind = when {
        f == null -> CompareKind.PLAIN
        isNumericCross(f) -> CompareKind.NUMBER
        f is DurationField -> CompareKind.DURATION
        else -> CompareKind.PLAIN
    }

    /** The field a value node compares as: itself, or a coalesce's first field. */
    private fun nodeField(node: Any?, fields: Map<String, MetaField<*>>): MetaField<*>? {
        val n = node as? Map<*, *> ?: return null
        (n["field"] as? String)?.let { return fields[it] }
        if (n["fn"] == "coalesce") {
            for (a in (n["args"] as? Collection<*>).orEmpty()) nodeField(a, fields)?.let { return it }
        }
        return null
    }

    /** Every field a value node reads: the field itself, or each field among a coalesce's arguments. */
    private fun nodeFields(node: Any?, fields: Map<String, MetaField<*>>): List<MetaField<*>> {
        val n = node as? Map<*, *> ?: return emptyList()
        (n["field"] as? String)?.let { return listOfNotNull(fields[it]) }
        if (n["fn"] == "coalesce") return (n["args"] as? Collection<*>).orEmpty().flatMap { nodeFields(it, fields) }
        return emptyList()
    }

    /** A comparison inside a condition follows the validator rule: every pair of fields it reads
     *  must be comparable, or the whole rule is left to the database. */
    private fun conditionComparable(left: Any?, right: Any?, op: String, fields: Map<String, MetaField<*>>): Boolean {
        val all = nodeFields(left, fields) + nodeFields(right, fields)
        return all.indices.all { i -> (i + 1 until all.size).all { j -> comparable(all[i], all[j], op) } }
    }

    /** A value node (field, literal, coalesce) as a Kotlin expression compared as [kind], or null. */
    private fun conditionValue(
        node: Any?, kind: CompareKind, fields: Map<String, MetaField<*>>, ref: (MetaField<*>) -> String,
    ): CodeBlock? {
        val n = node as? Map<*, *> ?: return null
        (n["field"] as? String)?.let { name ->
            val f = fields[name] ?: return null
            if (f.isArrayType) return null
            val r = ref(f)
            return when (kind) {
                CompareKind.NUMBER -> CodeBlock.of("(%L?.let·{·java.math.BigDecimal(it.toString())·})", r)
                CompareKind.DURATION -> CodeBlock.of("%L", r)
                CompareKind.PLAIN -> CodeBlock.of("(%L?.toString())", r)
            }
        }
        if (n.containsKey("value")) {
            val text = n["value"]?.toString() ?: return null
            return when (kind) {
                CompareKind.NUMBER -> CodeBlock.of("java.math.BigDecimal(%S)", text)
                CompareKind.DURATION -> try {
                    val d = DurationWire.parse(text)
                    CodeBlock.of("java.time.Duration.ofSeconds(%LL,·%LL)", d.seconds, d.nano)
                } catch (e: RuntimeException) {
                    null
                }
                CompareKind.PLAIN -> CodeBlock.of("%S", text)
            }
        }
        if (n["fn"] == "coalesce") {
            val args = (n["args"] as? Collection<*>).orEmpty().map { conditionValue(it, kind, fields, ref) ?: return null }
            return CodeBlock.builder().apply {
                add("listOf<Any?>(")
                args.forEachIndexed { i, a -> if (i > 0) add(",·"); add("%L", a) }
                add(").firstOrNull·{·it·!=·null·}")
            }.build()
        }
        return null
    }

    /** A condition node as a Kotlin `Boolean?` expression (null = SQL unknown), or null when unresolvable. */
    private fun conditionExpr(
        node: Any?, fields: Map<String, MetaField<*>>, ref: (MetaField<*>) -> String,
    ): CodeBlock? {
        val n = node as? Map<*, *> ?: return null
        val op = n["op"] as? String ?: return null
        val kop = when (op) {
            "gt" -> ">"; "gte" -> ">="; "lt" -> "<"; "lte" -> "<="; "ne" -> "!="; "eq" -> "=="
            else -> null
        }
        if (kop != null) {
            if (!conditionComparable(n["left"], n["right"], op, fields)) return null
            val kind = compareKind(nodeField(n["left"], fields) ?: nodeField(n["right"], fields))
            val l = conditionValue(n["left"], kind, fields, ref) ?: return null
            val r = conditionValue(n["right"], kind, fields, ref) ?: return null
            return CodeBlock.of(
                "((%L)·as·Comparable<Any>?)?.let·{·l_·->·(%L)?.let·{·r_·->·l_.compareTo(r_)·$kop·0·}·}", l, r,
            )
        }
        when (op) {
            "isNull", "isNotNull" -> {
                val a = conditionValue(n["arg"], CompareKind.PLAIN, fields, ref) ?: return null
                return CodeBlock.of("(%L·${if (op == "isNull") "==" else "!="}·null)", a)
            }
            "not" -> {
                val a = conditionExpr(n["arg"], fields, ref) ?: return null
                return CodeBlock.of("(%L)?.not()", a)
            }
            "and", "or" -> {
                val args = (n["args"] as? Collection<*>).orEmpty().map { conditionExpr(it, fields, ref) ?: return null }
                val decisive = if (op == "and") "false" else "true"
                val other = if (op == "and") "true" else "false"
                return CodeBlock.builder().apply {
                    add("listOf<Boolean?>(")
                    args.forEachIndexed { i, a -> if (i > 0) add(",·"); add("%L", a) }
                    add(").let·{·v_·->·if·($decisive·in·v_)·$decisive·else·if·(null·in·v_)·null·else·$other·}")
                }.build()
            }
        }
        return null
    }

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
     * generator: numerics compare with each other, strings, temporals and durations only with their own
     * subtype and Kotlin type (a date has no ordering against a timestamp, nor an Instant against a
     * `@localTime` LocalDateTime, and casting both to Comparable throws
     * ClassCastException inside the validity property, turning a create into a 500), and
     * boolean, enum, uuid, uri and inet fields only test equality. Anything else is skipped, like every other port.
     */
    private fun orderableCross(f: MetaField<*>): Boolean =
        isNumericCross(f) || f is StringField || isTemporalCross(f) || f is DurationField

    private fun equatableCross(f: MetaField<*>): Boolean =
        f is BooleanField || f is EnumField || f is UuidField || f is UriField || f is InetField

    /** Whether the pair has a sound comparison (see [comparison]); emits nothing. */
    private fun comparable(l: MetaField<*>, r: MetaField<*>, op: String): Boolean {
        val ordering = op == "gt" || op == "gte" || op == "lt" || op == "lte"
        val same = l.subType == r.subType
        if (isNumericCross(l) && isNumericCross(r) && !same) return true
        if (!same) return false
        if (!orderableCross(l) && !(!ordering && equatableCross(l))) return false
        return nativeShape(l) == nativeShape(r)
    }

    private fun comparison(l: MetaField<*>, r: MetaField<*>, op: String, kop: String, ref: (MetaField<*>) -> String): CodeBlock? {
        if (!comparable(l, r, op)) return null
        if (isNumericCross(l) && isNumericCross(r) && l.subType != r.subType) {
            return CodeBlock.of("java.math.BigDecimal(%L.toString()).compareTo(java.math.BigDecimal(%L.toString())) $kop 0", ref(l), ref(r))
        }
        if (orderableCross(l)) {
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
                is AtLeastOneValidator, is ExactlyOneValidator -> {
                    // atLeastOne and exactlyOne both name @fields; they differ only in the count they allow.
                    val raw = if (v.hasMetaAttr(AtLeastOneValidator.ATTR_FIELDS))
                        v.getMetaAttr(AtLeastOneValidator.ATTR_FIELDS).value else null
                    val names = when (raw) {
                        is Collection<*> -> raw.map { it.toString() }
                        null -> emptyList()
                        else -> listOf(raw.toString())
                    }
                    if (names.isEmpty() || names.any { it !in fields }) continue
                    CodeBlock.builder().apply {
                        if (v is AtLeastOneValidator) {
                            names.forEachIndexed { i, n -> if (i > 0) add(" || "); add("%L != null", ref(fields.getValue(n))) }
                        } else {
                            add("listOf(")
                            names.forEachIndexed { i, n -> if (i > 0) add(", "); add("%L", ref(fields.getValue(n))) }
                            add(").count·{·it·!=·null·}·==·1")
                        }
                    }.build()
                }
                else -> continue
            }
            // The CHECK is NOT (condition) OR (rule): the rule binds only when the condition is TRUE under SQL
            // three-valued logic; FALSE and NULL (unknown) let the record through.
            if (v.hasMetaAttr(MetaValidator.ATTR_CONDITION)) {
                val cond = conditionExpr(v.getMetaAttr(MetaValidator.ATTR_CONDITION).value, fields, ref) ?: continue
                out.add(v to CodeBlock.of("(%L)·!=·true·||·(%L)", cond, expr))
            } else {
                out.add(v to expr)
            }
        }
        return out
    }
}
