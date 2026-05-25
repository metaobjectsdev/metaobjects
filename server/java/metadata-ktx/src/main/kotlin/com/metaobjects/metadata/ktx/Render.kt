package com.metaobjects.metadata.ktx

import com.metaobjects.render.Escapers
import com.metaobjects.render.PayloadField
import com.metaobjects.render.Provider
import com.metaobjects.render.RenderRequest
import com.metaobjects.render.Renderer
import com.metaobjects.render.Verify
import com.metaobjects.render.VerifyError
import com.metaobjects.render.VerifyOptions

/**
 * FR-004 render + verify shortcuts.
 *
 * The Java side exposes [Renderer.render]/`new RenderRequest(...)`/`Verify.check(...)`.
 * The Kotlin builder is the one concession to DSL ergonomics — a property bag
 * that materializes a [RenderRequest] record so callers don't have to remember
 * the positional argument order.
 */

/** Render via an explicit Java [RenderRequest]. */
fun render(request: RenderRequest): String = Renderer().render(request)

/** Property-bag builder for [RenderRequest]; assignments by reference + sensible defaults. */
class RenderBuilder {
    var template: String? = null
    var ref: String? = null
    var payload: Any? = null
    var provider: Provider? = null
    var format: String = Escapers.FORMAT_TEXT
    var verify: List<PayloadField>? = null
    var maxChars: Int? = null

    /** Materialize a [RenderRequest] record from the current builder state. */
    fun build(): RenderRequest = RenderRequest(
        template, ref, payload, provider, format, verify, maxChars,
    )
}

/** Render via the Kotlin builder — `render { template = ...; payload = ...; provider = ... }`. */
inline fun render(block: RenderBuilder.() -> Unit): String =
    render(RenderBuilder().apply(block).build())

/** Verify shortcut over [Verify.check]. */
fun verify(
    templateText: String,
    fields: List<PayloadField>,
    options: VerifyOptions = VerifyOptions.empty(),
): List<VerifyError> = Verify.check(templateText, fields, options)
