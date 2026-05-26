package com.metaobjects.generator.kotlin

/** Translate metadata package syntax (`a::b::c`) to Kotlin package syntax (`a.b.c`). */
object PackageMapping {

    /** Convert metadata package separator "::" to Kotlin "." */
    fun toKotlin(metadataPackage: String): String =
        metadataPackage.replace("::", ".")

    /** Split a fully-qualified metadata name into Kotlin (packageName, shortName). */
    fun splitFqn(fqn: String): Pair<String, String> {
        val lastSep = fqn.lastIndexOf("::")
        return if (lastSep < 0) {
            "" to fqn
        } else {
            toKotlin(fqn.substring(0, lastSep)) to fqn.substring(lastSep + 2)
        }
    }
}
