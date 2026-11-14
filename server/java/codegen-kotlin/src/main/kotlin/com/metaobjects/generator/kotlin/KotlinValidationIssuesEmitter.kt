package com.metaobjects.generator.kotlin

import com.metaobjects.generator.util.GeneratedFileWriter
import java.nio.file.Path

/**
 * Writes the per-package `MetaValidationIssues.kt` support file: the cross-port validation answer
 * `400 {"error": "validation", "issues": [{"code", "path", "message"}]}` a generated controller
 * collects into. `code` uses Zod's names (`invalid_type`, `too_small`, `too_big`, `invalid_format`,
 * `invalid_value`, `custom`), `path` is the field's wire name (nested members and indexes as further
 * elements, empty when the body as a whole cannot be read), `message` is this port's own wording.
 *
 * Generated source, so the generated controller imports nothing from MetaObjects at runtime; the
 * only dependencies are the jakarta validation API the controller already uses and the package's
 * generated `MetaDecimalWire` (which classifies a binding failure). Written by the controller
 * generator into every package it emits a controller into; the content is fixed.
 */
object KotlinValidationIssuesEmitter {

    /** File name (sans `.kt`) and the name of the `internal object` it declares. */
    const val FILE_NAME = "MetaValidationIssues"

    /** Write `MetaValidationIssues.kt` into [pkg] under [outRoot]. */
    fun write(pkg: String, outRoot: Path) {
        val header = if (pkg.isEmpty()) "" else "package $pkg\n\n"
        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("$FILE_NAME.kt")
        GeneratedFileWriter.write(outFile, header + BODY + "\n")
    }

    /** The fixed body. No Kotlin string templates, so this raw string needs no `$` escaping. */
    val BODY: String = """
        |import com.fasterxml.jackson.databind.JsonMappingException
        |import jakarta.validation.ConstraintViolation
        |import jakarta.validation.Path
        |
        |/**
        | * GENERATED — do not hand-edit. The validation envelope a controller collects every issue into
        | * before answering `400 {"error": "validation", "issues": [...]}`.
        | */
        |internal object MetaValidationIssues {
        |    /** Collects issues; [body] is the response body. */
        |    class Collector {
        |        private val issues = ArrayList<Map<String, Any>>()
        |
        |        fun isEmpty(): Boolean = issues.isEmpty()
        |
        |        fun add(code: String, path: List<Any>, message: String): Collector {
        |            issues.add(linkedMapOf("code" to code, "path" to ArrayList(path), "message" to message))
        |            return this
        |        }
        |
        |        /** Every violation of a whole-bean validate, its path read from the violation after [prefix]. */
        |        fun addViolations(violations: Collection<ConstraintViolation<*>>, vararg prefix: Any): Collector {
        |            for (v in violations) add(codeOf(v), prefix.toList() + pathOf(v.propertyPath), v.message)
        |            return this
        |        }
        |
        |        /** Every violation of a single-property validateValue, at exactly [path]. */
        |        fun addAt(violations: Collection<ConstraintViolation<*>>, vararg path: Any): Collector {
        |            for (v in violations) add(codeOf(v), path.toList(), v.message)
        |            return this
        |        }
        |
        |        /** Run [read]; a failure becomes an issue at [field] and yields null. */
        |        fun <T> bind(field: String, read: () -> T): T? =
        |            try {
        |                read()
        |            } catch (e: Exception) {
        |                add(MetaDecimalWire.failureCode(e), listOf(field), "field '" + field + "' is not a valid value")
        |                null
        |            }
        |
        |        /** A body that could not be bound as a whole: an issue at the field it names (skipped if already listed). */
        |        fun addFailure(failure: Throwable): Collector {
        |            val path = ArrayList<Any>()
        |            var t: Throwable? = failure
        |            while (t != null) {
        |                if (t is JsonMappingException && t.path.isNotEmpty()) {
        |                    for (ref in t.path) {
        |                        if (ref.fieldName != null) path.add(ref.fieldName) else if (ref.index >= 0) path.add(ref.index)
        |                    }
        |                    break
        |                }
        |                t = if (t.cause === t) null else t.cause
        |            }
        |            if (issues.any { it["path"] == path }) return this
        |            val message = if (path.isEmpty()) "request body is not readable" else "field '" + path[path.size - 1] + "' is not a valid value"
        |            return add(MetaDecimalWire.failureCode(failure), path, message)
        |        }
        |
        |        fun body(): Map<String, Any> = linkedMapOf("error" to "validation", "issues" to issues)
        |    }
        |
        |    /** A path as wire elements: property names, with array indexes and map keys. */
        |    fun pathOf(path: Path): List<Any> {
        |        val out = ArrayList<Any>()
        |        for (node in path) {
        |            if (node.isInIterable) {
        |                val index = node.index
        |                val key = node.key
        |                if (index != null) out.add(index) else if (key != null) out.add(key.toString())
        |            }
        |            val name = node.name
        |            if (name != null) out.add(name)
        |        }
        |        return out
        |    }
        |
        |    /** The Zod-style code for a Bean Validation violation, from the constraint's annotation. */
        |    fun codeOf(v: ConstraintViolation<*>): String {
        |        val descriptor = v.constraintDescriptor
        |        val value = v.invalidValue
        |        val attrs = descriptor.attributes
        |        return when (descriptor.annotation.annotationClass.java.simpleName) {
        |            "NotNull" -> "invalid_type"
        |            "NotBlank", "NotEmpty" -> if (value == null) "invalid_type" else "too_small"
        |            "Size", "Length" -> {
        |                val max = attrs["max"] as? Number
        |                val length: Long? = when (value) {
        |                    is CharSequence -> value.length.toLong()
        |                    is Collection<*> -> value.size.toLong()
        |                    is Map<*, *> -> value.size.toLong()
        |                    else -> null
        |                }
        |                if (max != null && length != null && length > max.toLong()) "too_big" else "too_small"
        |            }
        |            "Max", "DecimalMax", "Digits", "Negative", "NegativeOrZero" -> "too_big"
        |            "Min", "DecimalMin", "Positive", "PositiveOrZero" -> "too_small"
        |            "Pattern", "Email", "URL" -> "invalid_format"
        |            else -> "custom"
        |        }
        |    }
        |}
        |""".trimMargin()
}
