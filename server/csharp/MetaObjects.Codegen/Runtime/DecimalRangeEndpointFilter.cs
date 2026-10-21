// DecimalRangeEndpointFilter — ADR-0019 Amendment 1 (W3), the READ side.
//
// C#'s `decimal` holds 28 to 29 significant digits; Postgres `numeric` holds 131072. A stored
// value past C#'s range makes the driver throw OverflowException while a row is read, which
// ASP.NET Core's default handler turns into a bare 500 with a stack trace in development.
// The value cannot be returned without rounding it, and a rounded decimal is a wrong answer,
// so the route answers with a NAMED error instead. It is a 500, not a 4xx: the caller did
// nothing wrong, the stored data is outside what this port can represent.
//
// The generated `Map<Entity>Routes` mounts its routes on a group carrying this filter, so
// every read and write handler of the entity is covered by one registration.

using Microsoft.AspNetCore.Http;

namespace MetaObjects.Codegen.Runtime;

/// <summary>Turns a driver's decimal-overflow-on-read into <c>500 {"error":"decimal_out_of_range"}</c>.</summary>
public sealed class DecimalRangeEndpointFilter : IEndpointFilter
{
    /// <summary>The cross-port-style error code of the named error.</summary>
    public const string ErrorCode = "decimal_out_of_range";

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        try
        {
            return await next(context);
        }
        catch (Exception ex) when (IsDecimalOverflow(ex))
        {
            return Results.Json(
                new
                {
                    error = ErrorCode,
                    message = "a stored decimal is outside the range this server's decimal type can hold "
                        + "(28 to 29 significant digits); it is not returned rounded",
                },
                statusCode: StatusCodes.Status500InternalServerError);
        }
    }

    /// <summary>True iff the exception chain holds the OverflowException a driver throws when a
    /// numeric does not fit <c>decimal</c> (Npgsql: "Value was either too large or too small for a Decimal").</summary>
    public static bool IsDecimalOverflow(Exception? ex)
    {
        for (var e = ex; e is not null; e = e.InnerException)
            if (e is OverflowException && e.Message.Contains("Decimal", StringComparison.OrdinalIgnoreCase))
                return true;
        return false;
    }
}
