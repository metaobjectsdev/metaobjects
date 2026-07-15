// ValueObjectValidator — recursive DataAnnotations validation for value-object
// (field.object @storage:jsonb) graphs. Generated CRUD handlers call
// ValueObjectValidator.Validate(<vo-or-collection-or-null>) on POST create and on
// each present VO column in a PATCH merge, returning a 400 {error:"validation"}
// when it reports false.
//
// Program D — the load-bearing correction (design §0): System.ComponentModel.
// DataAnnotations.Validator.TryValidateObject(vo, ctx, results, validateAllProperties:
// true) is NON-recursive — it validates the VO's OWN members' attributes ([Required],
// [StringLength], [Range], ...) but does NOT descend into a nested-VO member. This
// helper validates each present VO element AND recurses manually into nested-VO
// members so a depth ≥ 2 constraint violation is still caught, matching the TS
// reference (z.array(<Ref>InsertSchema) validates recursively).
//
// Recursion is scoped to value-object types (those declared in the SAME assembly as
// the top-level VO — the generated code assembly): framework/primitive members are
// already covered by their owner's attributes, and scoping avoids cycling through a
// framework object graph.

using System.Collections;
using System.ComponentModel.DataAnnotations;
using System.Reflection;

namespace MetaObjects.Codegen.Runtime;

/// <summary>
/// Recursive value-object graph validator for generated CRUD handlers (Program D).
/// </summary>
public static class ValueObjectValidator
{
    /// <summary>
    /// Validates a value-object graph — a single VO, a collection of VOs, or null —
    /// against its members' DataAnnotations, recursing into nested-VO members
    /// (<see cref="Validator.TryValidateObject(object, ValidationContext, ICollection{ValidationResult}, bool)"/>
    /// is non-recursive). Returns true when the whole graph is valid; a null / empty
    /// graph is vacuously valid (a required-null column is enforced by the caller, not here).
    /// </summary>
    public static bool Validate(object? value)
    {
        var voAssembly = ValueObjectAssembly(value);
        return voAssembly is null || ValidateGraph(value, voAssembly);
    }

    // The assembly the value objects in this graph live in — used to scope recursion to
    // generated VO types (a single VO's own type, or a collection's first element type).
    // null when the graph carries no VO instance (null / string / empty collection).
    private static Assembly? ValueObjectAssembly(object? value)
    {
        switch (value)
        {
            case null:
            case string:
                return null;
            case IEnumerable seq:
                foreach (var item in seq)
                    if (ValueObjectAssembly(item) is { } a)
                        return a;
                return null;
            default:
                return value.GetType().Assembly;
        }
    }

    private static bool ValidateGraph(object? value, Assembly voAssembly)
    {
        if (value is null || value is string) return true;
        if (value is IEnumerable seq)
        {
            foreach (var item in seq)
                if (!ValidateGraph(item, voAssembly)) return false;
            return true;
        }
        var type = value.GetType();
        // Only validate + recurse into value-object instances (declared in the generated
        // assembly). A framework/primitive member is covered by its owner's attributes;
        // skipping it also prevents recursing (and cycling) through a framework graph.
        if (type.Assembly != voAssembly) return true;

        var results = new List<ValidationResult>();
        if (!Validator.TryValidateObject(value, new ValidationContext(value), results, validateAllProperties: true))
            return false;

        // Non-recursive TryValidateObject — descend into nested-VO members explicitly.
        foreach (var prop in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (prop.GetIndexParameters().Length != 0 || !prop.CanRead) continue;
            if (!ValidateGraph(prop.GetValue(value), voAssembly)) return false;
        }
        return true;
    }
}
