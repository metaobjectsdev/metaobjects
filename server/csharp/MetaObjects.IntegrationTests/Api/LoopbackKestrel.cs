// LoopbackKestrel — how every api-contract server in this project gets its address.
//
// Kestrel binds 127.0.0.1:0 and the OS assigns the port at bind time; the server reports the
// address it actually bound. The previous pattern — open a probe socket on port 0, read the
// number, close it, hand the number to the server — is a check-then-act race: between the
// probe's close and the server's bind, another process can take the port. Alone it never
// bites; with parallel CI lanes starting servers at once it fails as
// "Failed to bind to address ...: address already in use".

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;

namespace MetaObjects.IntegrationTests.Api;

internal static class LoopbackKestrel
{
    /// <summary>Bind the host to a loopback port the OS assigns.</summary>
    public static void BindAnyPort(WebApplicationBuilder builder) =>
        builder.WebHost.UseUrls("http://127.0.0.1:0");

    /// <summary>The address Kestrel actually bound. Valid only after <c>StartAsync</c>.</summary>
    public static string BoundUrl(WebApplication app) =>
        app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!
            .Addresses.Single().TrimEnd('/');
}
