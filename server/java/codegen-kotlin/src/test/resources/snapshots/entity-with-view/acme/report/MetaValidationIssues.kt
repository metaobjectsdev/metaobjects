package acme.report

import com.fasterxml.jackson.databind.JsonMappingException
import jakarta.validation.ConstraintViolation
import jakarta.validation.Path

/**
 * GENERATED — do not hand-edit. The validation envelope a controller collects every issue into
 * before answering `400 {"error": "validation", "issues": [...]}`.
 */
internal object MetaValidationIssues {
    /** Collects issues; [body] is the response body. */
    class Collector {
        private val issues = ArrayList<Map<String, Any>>()

        fun isEmpty(): Boolean = issues.isEmpty()

        fun add(code: String, path: List<Any>, message: String): Collector {
            issues.add(linkedMapOf("code" to code, "path" to ArrayList(path), "message" to message))
            return this
        }

        /** Every violation of a whole-bean validate, its path read from the violation after [prefix]. */
        fun addViolations(violations: Collection<ConstraintViolation<*>>, vararg prefix: Any): Collector {
            for (v in violations) add(codeOf(v), prefix.toList() + pathOf(v.propertyPath), v.message)
            return this
        }

        /** Every violation of a single-property validateValue, at exactly [path]. */
        fun addAt(violations: Collection<ConstraintViolation<*>>, vararg path: Any): Collector {
            for (v in violations) add(codeOf(v), path.toList(), v.message)
            return this
        }

        /** Run [read]; a failure becomes an issue at [field] and yields null. */
        fun <T> bind(field: String, read: () -> T): T? =
            try {
                read()
            } catch (e: Exception) {
                add(MetaDecimalWire.failureCode(e), listOf(field), "field '" + field + "' is not a valid value")
                null
            }

        /** A body that could not be bound as a whole: an issue at the field it names (skipped if already listed). */
        fun addFailure(failure: Throwable): Collector {
            val path = ArrayList<Any>()
            var t: Throwable? = failure
            while (t != null) {
                if (t is JsonMappingException && t.path.isNotEmpty()) {
                    for (ref in t.path) {
                        if (ref.fieldName != null) path.add(ref.fieldName) else if (ref.index >= 0) path.add(ref.index)
                    }
                    break
                }
                t = if (t.cause === t) null else t.cause
            }
            if (issues.any { it["path"] == path }) return this
            val message = if (path.isEmpty()) "request body is not readable" else "field '" + path[path.size - 1] + "' is not a valid value"
            return add(MetaDecimalWire.failureCode(failure), path, message)
        }

        fun body(): Map<String, Any> = linkedMapOf("error" to "validation", "issues" to issues)
    }

    /** A path as wire elements: property names, with array indexes and map keys. */
    fun pathOf(path: Path): List<Any> {
        val out = ArrayList<Any>()
        for (node in path) {
            if (node.isInIterable) {
                val index = node.index
                val key = node.key
                if (index != null) out.add(index) else if (key != null) out.add(key.toString())
            }
            val name = node.name
            if (name != null) out.add(name)
        }
        return out
    }

    /** The Zod-style code for a Bean Validation violation, from the constraint's annotation. */
    fun codeOf(v: ConstraintViolation<*>): String {
        val descriptor = v.constraintDescriptor
        val value = v.invalidValue
        val attrs = descriptor.attributes
        return when (descriptor.annotation.annotationClass.java.simpleName) {
            "NotNull" -> "invalid_type"
            "NotBlank", "NotEmpty" -> if (value == null) "invalid_type" else "too_small"
            "Size", "Length" -> {
                val max = attrs["max"] as? Number
                val length: Long? = when (value) {
                    is CharSequence -> value.length.toLong()
                    is Collection<*> -> value.size.toLong()
                    is Map<*, *> -> value.size.toLong()
                    else -> null
                }
                if (max != null && length != null && length > max.toLong()) "too_big" else "too_small"
            }
            "Max", "DecimalMax", "Digits", "Negative", "NegativeOrZero" -> "too_big"
            "Min", "DecimalMin", "Positive", "PositiveOrZero" -> "too_small"
            "Pattern", "Email", "URL" -> "invalid_format"
            else -> "custom"
        }
    }
}

