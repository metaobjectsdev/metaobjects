package com.metaobjects.generator.kotlin.apidocs

/**
 * Doc-page path math, byte-parity with the TS `docs-paths.ts` contract (SP-1 apiSurfaces) and the
 * Java `com.metaobjects.generator.apidocs.DocsPaths`. Cross-links computed here must match what the
 * other ports emit for the same layout.
 *
 * **Why ported, not reused.** The Java `DocsPaths` lives in `codegen-spring`, a Spring-heavy module
 * `codegen-kotlin` does not (and should not) depend on — pulling it in to reach ~50 lines of pure
 * string math would make Kotlin's own SDK surface transitively depend on the Java Spring generators
 * (semantically wrong + a heavy classpath cost). The C# and Python ports each carry their own
 * `DocsPaths` for the same reason. The path math is tiny and is byte-gated against the shared
 * `expected-paths.json` manifest by the cross-port conformance runner, so a divergence is caught.
 */
object DocsPaths {

    enum class Layout { FLAT, PACKAGE }

    /** `"acme::shop"` or `"acme.shop"` -> `"acme/shop"`; null/`""` -> `""`. */
    fun packageToPath(pkg: String?): String {
        if (pkg.isNullOrEmpty()) return ""
        return pkg.replace("::", "/").replace(".", "/")
    }

    /** Flat -> `"<name>.md"`; Package -> `"<pkg-folded>/<name>.md"`. */
    fun docPageOutputPath(layout: Layout, pkg: String?, name: String): String {
        val file = "$name.md"
        if (layout == Layout.FLAT) return file
        val dir = packageToPath(pkg)
        return if (dir.isEmpty()) file else "$dir/$file"
    }

    /** Relative posix href from [fromOutputPath]'s directory to [toOutputPath] (mirrors TS surfaceCrossHref). */
    fun surfaceCrossHref(fromOutputPath: String, toOutputPath: String): String {
        val fromDir = if (fromOutputPath.contains("/"))
            fromOutputPath.substring(0, fromOutputPath.lastIndexOf('/')) else ""
        val rel = posixRelative(fromDir, toOutputPath)
        return if (rel.startsWith(".")) rel else "./$rel"
    }

    /** From an api page to its model page: relative by default, absolute when [modelBaseUrl] is set (federated). */
    fun modelCrossHref(apiPagePath: String, modelPagePath: String, modelBaseUrl: String?): String {
        if (!modelBaseUrl.isNullOrEmpty())
            return modelBaseUrl.replace(Regex("/+$"), "") + "/" + modelPagePath
        return surfaceCrossHref(apiPagePath, modelPagePath)
    }

    /**
     * node:path/posix `relative(fromDir, toPath)`: drop common prefix, `".."` per remaining
     * fromDir segment, then remaining toPath segments. `""` fromDir -> toPath; identical -> `"."`.
     */
    private fun posixRelative(fromDir: String, toPath: String): String {
        if (fromDir.isEmpty()) return toPath
        val from = fromDir.split("/")
        val to = toPath.split("/")
        var common = 0
        val max = minOf(from.size, to.size)
        while (common < max && from[common] == to[common]) common++
        val rel = StringBuilder()
        for (i in common until from.size) {
            if (rel.isNotEmpty()) rel.append('/')
            rel.append("..")
        }
        for (i in common until to.size) {
            if (rel.isNotEmpty()) rel.append('/')
            rel.append(to[i])
        }
        return if (rel.isEmpty()) "." else rel.toString()
    }
}
