// ApiContractCredentialHostVariantsTest — the live proof that a credential never leaves, and a
// write-denied field is never written, whatever the host does to a property's JSON key.
//
// The generated routes serialize an entity with the host's JsonOptions. A property's key is the host's
// naming policy applied to the property name, and the property name is whatever GenConfig.PropertyNaming
// made of the field. The credential omit list and the PATCH/PUT key lookup read the serializer's own key
// (SerializerKeys), so these variants must all hold:
//   1. a property renamed beyond case, default (camelCase) host;
//   2. the same rename under JsonNamingPolicy.SnakeCaseLower;
//   3. no rename under SnakeCaseLower (the leak that predates the resolver: pinHash -> pin_hash).
// Plus a credential declared on a TPH SUBTYPE, through the polymorphic list and the per-subtype routes.
//
// A response may not carry the credential under any key; a PATCH or PUT body naming it under any
// spelling is ignored (200) and the stored column stays; a POST stores null; and a multi-word ordinary
// field IS applied by PATCH under a snake policy (the key lookup is the serializer's).

using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.Codegen;
using MetaObjects.IntegrationTests.Runner;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.IntegrationTests.Api;

public sealed class ApiContractCredentialHostVariantsTest
{
    // pinHash is the credential (view.password); tokenHash is @formExclude (write-denied, still returned).
    // displayName is an ordinary multi-word field that PATCH must apply under every policy.
    private static string AccountMeta() => File.ReadAllText(ApiContractCorpusPaths.SecretFieldsMetaJson).Replace(
        "{ \"field.string\":     { \"name\": \"role\"",
        "{ \"field.string\":     { \"name\": \"displayName\", \"@maxLength\": 100 } },\n          { \"field.string\":     { \"name\": \"role\"");

    private const string AccountDdl = "ALTER TABLE \"accounts\" ADD COLUMN \"displayName\" VARCHAR(100) NULL;";

    private static string AccountSpelling(MetaField f) => f.Name switch
    {
        "pinHash" => "PinSecret",
        "tokenHash" => "ApiToken",
        "displayName" => "ShownAs",
        _ => CSharpNaming.Pascal(f.Name),
    };

    public static IEnumerable<object[]> Hosts() =>
    [
        ["rename", "camel"],
        ["rename", "snake"],
        ["plain", "snake"],
    ];

    private static SecretFieldsHost AccountHost(string naming, string policy) => new(
        PropertyNaming: naming == "rename" ? AccountSpelling : null,
        JsonPolicy: policy == "snake" ? JsonNamingPolicy.SnakeCaseLower : JsonNamingPolicy.CamelCase,
        MetaJson: AccountMeta(), ExtraDdl: AccountDdl);

    // A key is a credential key iff it spells the credential (or its resolved name) ignoring case and `_`/`-`.
    private static readonly string[] CredentialKeys = ["pinhash", "pinsecret", "permitsecret"];

    // The credential VALUES seeded by the corpus and the TPH test: they may appear in no response body, under any key.
    private static readonly string[] CredentialValues = ["pin-hash-1", "pin-hash-2", "permit-secret"];

    private static string Normalize(string key) => key.Replace("_", "").Replace("-", "").ToLowerInvariant();

    private static void AssertNoCredential(JsonNode? node, string where)
    {
        switch (node)
        {
            case JsonObject o:
                foreach (var kv in o)
                {
                    Assert.False(CredentialKeys.Contains(Normalize(kv.Key)), $"{where}: credential key \"{kv.Key}\" in {o.ToJsonString()}");
                    AssertNoCredential(kv.Value, where);
                }
                break;
            case JsonArray a:
                foreach (var e in a) AssertNoCredential(e, where);
                break;
        }
    }

    private static async Task<(int Status, JsonNode? Body)> SendAsync(HttpClient c, string method, string path, object? body = null)
    {
        var req = new HttpRequestMessage(new HttpMethod(method), path);
        if (body is not null) req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        var res = await c.SendAsync(req);
        var text = await res.Content.ReadAsStringAsync();
        foreach (var v in CredentialValues)
            Assert.DoesNotContain(v, text);   // by value: no key spelling can hide it
        return ((int)res.StatusCode, string.IsNullOrEmpty(text) ? null : JsonNode.Parse(text));
    }

    private static async Task<List<Dictionary<string, string?>>> ReadAccountsAsync(string connString)
    {
        await using var c = new Npgsql.NpgsqlConnection(connString);
        await c.OpenAsync();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT \"id\", \"name\", \"tokenHash\", \"pinHash\", \"displayName\" FROM \"accounts\" ORDER BY \"id\"";
        await using var r = await cmd.ExecuteReaderAsync();
        var rows = new List<Dictionary<string, string?>>();
        while (await r.ReadAsync())
        {
            string? S(int i) => r.IsDBNull(i) ? null : Convert.ToString(r.GetValue(i));
            rows.Add(new() { ["id"] = S(0), ["name"] = S(1), ["tokenHash"] = S(2), ["pinHash"] = S(3), ["displayName"] = S(4) });
        }
        return rows;
    }

    // Every spelling a client could send for the denied fields: the field name, the resolved property name
    // under the camel and the snake host, and their capitalized forms.
    private static Dictionary<string, object?> ForgedBody(string name) => new()
    {
        ["name"] = name,
        ["pinHash"] = "forged", ["tokenHash"] = "forged", ["role"] = "admin",
        ["pinSecret"] = "forged", ["PinSecret"] = "forged", ["pin_secret"] = "forged", ["apiToken"] = "forged", ["ApiToken"] = "forged",
        ["pin_hash"] = "forged", ["token_hash"] = "forged", ["api_token"] = "forged",
    };

    [Theory]
    [MemberData(nameof(Hosts))]
    public async Task A_credential_is_never_returned_and_never_written_whatever_the_host_does_to_keys(string naming, string policy)
    {
        await using var pg = await PostgresContainer.StartAsync();
        await using var server = await SecretFieldsGeneratedServerFactory.StartAsync(pg, AccountHost(naming, policy));
        await server.ApplySeedAsync();
        using var client = new HttpClient { BaseAddress = new Uri(server.BaseUrl) };

        // Reads: item, list, list with count. No credential key under any spelling; the form-excluded token stays.
        var item = await SendAsync(client, "GET", "/api/accounts/1");
        Assert.Equal(200, item.Status);
        AssertNoCredential(item.Body, "GET item");
        Assert.Contains(item.Body!.AsObject(), kv => Normalize(kv.Key) is "tokenhash" or "apitoken");
        var list = await SendAsync(client, "GET", "/api/accounts?sort=id:asc");
        Assert.Equal(200, list.Status);
        AssertNoCredential(list.Body, "GET list");
        Assert.Equal(2, list.Body!.AsArray().Count);
        var counted = await SendAsync(client, "GET", "/api/accounts?withCount=1&sort=id:asc");
        Assert.Equal(200, counted.Status);
        AssertNoCredential(counted.Body, "GET list withCount");
        Assert.Equal(2, counted.Body!["rows"]!.AsArray().Count);

        // Writes: PATCH and PUT with the denied fields under every spelling are ignored; the multi-word
        // ordinary field is applied under the host's own key for it.
        // The key a client echoes is the serializer's: the policy over the (possibly renamed) property.
        var displayKey = (naming, policy) switch
        {
            ("rename", "snake") => "shown_as", ("rename", _) => "shownAs",
            (_, "snake") => "display_name", _ => "displayName",
        };
        foreach (var (method, id) in new[] { ("PATCH", 1), ("PUT", 2) })
        {
            var body = ForgedBody($"{method}-probe");
            body[displayKey] = $"{method}-shown";
            var res = await SendAsync(client, method, $"/api/accounts/{id}", body);
            Assert.Equal(200, res.Status);
            AssertNoCredential(res.Body, method);
            Assert.Equal($"{method}-probe", res.Body!["name"]!.GetValue<string>());
        }

        // Creates: the denied fields are ignored (stored null), the response carries no credential.
        var created = await SendAsync(client, "POST", "/api/accounts", ForgedBody("Grace Hopper"));
        Assert.Equal(201, created.Status);
        AssertNoCredential(created.Body, "POST");

        var stored = await ReadAccountsAsync(pg.ConnectionString);
        Assert.Equal(3, stored.Count);
        Assert.Equal("pin-hash-1", stored[0]["pinHash"]);
        Assert.Equal("token-hash-1", stored[0]["tokenHash"]);
        Assert.Equal("pin-hash-2", stored[1]["pinHash"]);
        Assert.Equal("token-hash-2", stored[1]["tokenHash"]);
        Assert.Equal("PATCH-shown", stored[0]["displayName"]);   // N3: a multi-word key is applied under the policy
        Assert.Equal("PUT-shown", stored[1]["displayName"]);
        Assert.Null(stored[2]["pinHash"]);
        Assert.Null(stored[2]["tokenHash"]);
    }

    // ---- a credential declared on a TPH subtype ----

    private static string TphMeta() => File.ReadAllText(ApiContractCorpusPaths.TphMetaJson).Replace(
        "{ \"field.string\": { \"name\": \"approver\", \"@maxLength\": 80, \"@filterable\": true, \"@sortable\": true } }",
        "{ \"field.string\": { \"name\": \"approver\", \"@maxLength\": 80, \"@filterable\": true, \"@sortable\": true } },\n" +
        "          { \"field.string\": { \"name\": \"pinHash\", \"@maxLength\": 80, \"children\": [ { \"view.password\": {} } ] } },\n" +
        "          { \"field.string\": { \"name\": \"permitNote\", \"@maxLength\": 80 } }");

    private const string TphDdl = "ALTER TABLE \"auths\" ADD COLUMN \"pinHash\" VARCHAR(80) NULL;\nALTER TABLE \"auths\" ADD COLUMN \"permitNote\" VARCHAR(80) NULL;";

    private static string TphSpelling(MetaField f) => f.Name switch
    {
        "pinHash" => "PermitSecret",
        "permitNote" => "PermitMemo",
        _ => CSharpNaming.Pascal(f.Name),
    };

    public static IEnumerable<object[]> TphHosts() =>
    [
        ["rename", "snake"],
        ["plain", "snake"],
        ["rename", "camel"],
    ];

    [Theory]
    [MemberData(nameof(TphHosts))]
    public async Task A_subtype_credential_is_never_returned_or_written_on_the_polymorphic_and_subtype_routes(string naming, string policy)
    {
        await using var pg = await PostgresContainer.StartAsync();
        var host = new TphHost(
            PropertyNaming: naming == "rename" ? TphSpelling : null,
            JsonPolicy: policy == "snake" ? JsonNamingPolicy.SnakeCaseLower : JsonNamingPolicy.CamelCase,
            MetaJson: TphMeta(), ExtraDdl: TphDdl);
        await using var server = await TphGeneratedServerFactory.StartAsync(pg, host);
        await server.ApplySeedAsync();
        await using (var c = new Npgsql.NpgsqlConnection(pg.ConnectionString))
        {
            await c.OpenAsync();
            await using var cmd = c.CreateCommand();
            cmd.CommandText = "UPDATE \"auths\" SET \"pinHash\" = 'permit-secret' WHERE \"id\" = 3";
            await cmd.ExecuteNonQueryAsync();
        }
        using var client = new HttpClient { BaseAddress = new Uri(server.BaseUrl) };

        foreach (var path in new[] { "/api/auths?sort=id:asc", "/api/auths?withCount=1&sort=id:asc", "/api/auths/permit?sort=id:asc", "/api/auths/permit?withCount=1&sort=id:asc", "/api/auths/permit/3", "/api/auths/3" })
        {
            var res = await SendAsync(client, "GET", path);
            Assert.Equal(200, res.Status);
            AssertNoCredential(res.Body, "GET " + path);
        }
        Assert.DoesNotContain("permit-secret", (await SendAsync(client, "GET", "/api/auths")).Body!.ToJsonString());

        var noteKey = (naming, policy) switch
        {
            ("rename", "snake") => "permit_memo", ("rename", _) => "permitMemo",
            (_, "snake") => "permit_note", _ => "permitNote",
        };
        foreach (var method in new[] { "PATCH", "PUT" })
        {
            var res = await SendAsync(client, method, "/api/auths/permit/3", new Dictionary<string, object?>
            {
                ["approver"] = $"{method}-approver", [noteKey] = $"{method}-note",
                ["pinHash"] = "forged", ["pin_hash"] = "forged", ["permitSecret"] = "forged", ["PermitSecret"] = "forged", ["permit_secret"] = "forged",
            });
            Assert.Equal(200, res.Status);
            AssertNoCredential(res.Body, method + " permit");
            Assert.Equal($"{method}-approver", res.Body!["approver"]!.GetValue<string>());
        }
        var created = await SendAsync(client, "POST", "/api/auths/permit", new Dictionary<string, object?>
        {
            ["reference"] = "REF-NEW", ["approver"] = "Dr. New", ["pinHash"] = "forged", ["pin_hash"] = "forged", ["permitSecret"] = "forged", ["permit_secret"] = "forged",
        });
        Assert.Equal(201, created.Status);
        AssertNoCredential(created.Body, "POST permit");

        await using var conn = new Npgsql.NpgsqlConnection(pg.ConnectionString);
        await conn.OpenAsync();
        await using var q = conn.CreateCommand();
        q.CommandText = "SELECT \"id\", \"pinHash\", \"permitNote\" FROM \"auths\" ORDER BY \"id\"";
        await using var r = await q.ExecuteReaderAsync();
        var rows = new List<(long Id, string? Pin, string? Note)>();
        while (await r.ReadAsync()) rows.Add((r.GetInt64(0), r.IsDBNull(1) ? null : r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2)));
        Assert.Equal("permit-secret", rows.Single(x => x.Id == 3).Pin);
        Assert.Equal("PUT-note", rows.Single(x => x.Id == 3).Note);   // a multi-word subtype field is applied under the policy
        Assert.Null(rows.Single(x => x.Id > 3).Pin);
    }

    // ---- a host whose serializer contract cannot be read must be refused, never leak ----

    // Every property loses its reflection member: what a custom type-info resolver, a modifier that rebuilds
    // properties, or a source-generated context that does not carry it can do.
    private static void NoReflectionMembers(JsonSerializerOptions o)
    {
        var resolver = new System.Text.Json.Serialization.Metadata.DefaultJsonTypeInfoResolver();
        resolver.Modifiers.Add(ti => { foreach (var p in ti.Properties) p.AttributeProvider = null; });
        o.TypeInfoResolver = resolver;
    }

    private static bool Refused(Exception e)
    {
        for (var x = e; x is not null; x = x.InnerException!)
            if (x.Message.Contains("cannot strip the credential", StringComparison.Ordinal)) return true;
        return false;
    }

    [Fact]
    public async Task A_host_whose_contract_cannot_be_read_refuses_to_start_instead_of_leaking_the_account_credential()
    {
        await using var pg = await PostgresContainer.StartAsync();
        var host = AccountHost("rename", "snake") with { ConfigureJson = NoReflectionMembers };
        var ex = await Assert.ThrowsAnyAsync<Exception>(async () =>
        {
            await using var server = await SecretFieldsGeneratedServerFactory.StartAsync(pg, host);
        });
        Assert.True(Refused(ex), ex.ToString());
        Assert.DoesNotContain("pin-hash", ex.ToString());
    }

    [Fact]
    public async Task A_host_whose_contract_cannot_be_read_refuses_to_start_instead_of_leaking_the_subtype_credential()
    {
        await using var pg = await PostgresContainer.StartAsync();
        var host = new TphHost(PropertyNaming: TphSpelling, JsonPolicy: JsonNamingPolicy.SnakeCaseLower,
            MetaJson: TphMeta(), ExtraDdl: TphDdl, ConfigureJson: NoReflectionMembers);
        var ex = await Assert.ThrowsAnyAsync<Exception>(async () =>
        {
            await using var server = await TphGeneratedServerFactory.StartAsync(pg, host);
        });
        Assert.True(Refused(ex), ex.ToString());
    }
}
