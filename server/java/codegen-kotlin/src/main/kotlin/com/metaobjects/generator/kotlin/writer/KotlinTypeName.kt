package com.metaobjects.generator.kotlin.writer

import com.metaobjects.generator.writer.WriterException

/**
 * A Kotlin type reference: a class ([KotlinClassName]) or a class with type arguments
 * ([KotlinParameterizedTypeName]), either of which may be nullable. It is what
 * `KotlinTypeMapper` answers and what a generator hands to [KotlinWriter] through [write].
 *
 * It replaces KotlinPoet's `TypeName` (ADR-0063): [toString] spells the type fully qualified,
 * exactly as KotlinPoet's `TypeName.toString()` did (`kotlin.collections.List<kotlin.String>?`),
 * so text built from it is unchanged; [write] is the form a generator writes into a file.
 */
sealed class KotlinTypeName {

    /** Whether the type is written with a trailing `?`. */
    abstract val isNullable: Boolean

    /** This type with its nullability set to [nullable]. */
    abstract fun copy(nullable: Boolean): KotlinTypeName

    /**
     * The type as [w] writes it: each class by its simple name, imported through [KotlinWriter.use].
     * A class whose simple name another import already holds is written fully qualified instead,
     * so two types with one simple name can share a file.
     */
    abstract fun write(w: KotlinWriter): String

    protected fun suffix(): String = if (isNullable) "?" else ""
}

/**
 * A class, by package and simple names (more than one for a nested class: `MetaDecimalWire`,
 * `Serializer`). An empty [packageName] is the root package.
 */
class KotlinClassName(
    val packageName: String,
    val simpleNames: List<String>,
    override val isNullable: Boolean = false,
) : KotlinTypeName() {

    constructor(packageName: String, vararg simpleNames: String) : this(packageName, simpleNames.toList())

    init {
        require(simpleNames.isNotEmpty()) { "a class name needs at least one simple name" }
    }

    /** The innermost simple name. */
    val simpleName: String get() = simpleNames.last()

    /** The dotted name: package, then each simple name. */
    val canonicalName: String
        get() = if (packageName.isEmpty()) simpleNames.joinToString(".") else packageName + "." + simpleNames.joinToString(".")

    /** The outermost class this one is nested in, or this class when it is top level. */
    fun topLevelClassName(): KotlinClassName =
        if (simpleNames.size == 1 && !isNullable) this else KotlinClassName(packageName, listOf(simpleNames[0]))

    /** A class nested in this one. */
    fun nestedClass(name: String): KotlinClassName = KotlinClassName(packageName, simpleNames + name)

    /** This class with [arguments] as its type arguments: `Map<String, Any>`. */
    fun parameterizedBy(vararg arguments: KotlinTypeName): KotlinParameterizedTypeName =
        KotlinParameterizedTypeName(this, arguments.toList())

    override fun copy(nullable: Boolean): KotlinClassName = KotlinClassName(packageName, simpleNames, nullable)

    override fun write(w: KotlinWriter): String {
        val top = topLevelClassName()
        val head = if (packageName.isEmpty()) {
            top.simpleName
        } else {
            try {
                w.use(top.canonicalName)
            } catch (e: WriterException) {
                if (e.code() != WriterException.IMPORT_CONFLICT) throw e
                KotlinWriter.escapeName(top.canonicalName)
            }
        }
        val nested = simpleNames.drop(1).joinToString("") { "." + KotlinWriter.escapeName(it) }
        return head + nested + suffix()
    }

    override fun toString(): String = canonicalName + suffix()

    override fun equals(other: Any?): Boolean =
        other is KotlinClassName && other.packageName == packageName && other.simpleNames == simpleNames &&
            other.isNullable == isNullable

    override fun hashCode(): Int = (packageName.hashCode() * 31 + simpleNames.hashCode()) * 31 + isNullable.hashCode()
}

/** A class with type arguments: `List<UUID>`, `Map<String, Address>`. */
class KotlinParameterizedTypeName(
    val rawType: KotlinClassName,
    val typeArguments: List<KotlinTypeName>,
    override val isNullable: Boolean = false,
) : KotlinTypeName() {

    override fun copy(nullable: Boolean): KotlinParameterizedTypeName =
        KotlinParameterizedTypeName(rawType, typeArguments, nullable)

    override fun write(w: KotlinWriter): String =
        rawType.write(w) + typeArguments.joinToString(", ", "<", ">") { it.write(w) } + suffix()

    override fun toString(): String = rawType.toString() + typeArguments.joinToString(", ", "<", ">") + suffix()

    override fun equals(other: Any?): Boolean =
        other is KotlinParameterizedTypeName && other.rawType == rawType && other.typeArguments == typeArguments &&
            other.isNullable == isNullable

    override fun hashCode(): Int = (rawType.hashCode() * 31 + typeArguments.hashCode()) * 31 + isNullable.hashCode()
}

/** The Kotlin types the generators name most, as KotlinPoet's constants of the same names did. */
object KotlinTypes {
    @JvmField val ANY = KotlinClassName("kotlin", "Any")
    @JvmField val BOOLEAN = KotlinClassName("kotlin", "Boolean")
    @JvmField val DOUBLE = KotlinClassName("kotlin", "Double")
    @JvmField val FLOAT = KotlinClassName("kotlin", "Float")
    @JvmField val INT = KotlinClassName("kotlin", "Int")
    @JvmField val LONG = KotlinClassName("kotlin", "Long")
    @JvmField val STRING = KotlinClassName("kotlin", "String")
    @JvmField val UNIT = KotlinClassName("kotlin", "Unit")
    @JvmField val LIST = KotlinClassName("kotlin.collections", "List")
    @JvmField val MAP = KotlinClassName("kotlin.collections", "Map")
}
