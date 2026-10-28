// ADR-0034 Amendment 3 — the ONE real end-to-end eject test (task's own allowance:
// "keep one e2e test that uses a ProjectReference instead of the PackageReference" when
// a `dotnet run` e2e is too slow/network-bound for every test). Everything else in this
// port's eject coverage runs in-process (EjectCommandTests, OwnedCopyTests,
// EjectedGeneratorCompileTests' in-memory Roslyn compile-and-invoke). This test is the
// one that actually shells out to `dotnet run` against a SEPARATE, freshly-scaffolded
// console project — proving proof (b): "an edited copy's change appears in `gen` output
// and `verify --codegen` passes" — which requires a REAL compile of the edited file,
// something no in-process technique can substitute for.
//
// SUBSTITUTION, documented per the task instructions: `dotnet meta eject` scaffolds
// codegen/Codegen.csproj with a `<PackageReference Include="MetaObjects.Codegen" .../>`
// pinned to the tool's own version — correct for a real adopter, who installs it from
// NuGet. This repo's MetaObjects.Codegen has never been published (it is mid-development
// in this very session), so after ejecting, this test REWRITES that one line to a
// `<ProjectReference>` pointing at this checkout's own MetaObjects.Codegen.csproj before
// running `dotnet run`. That is the only difference from what a real adopter's
// codegen/Codegen.csproj looks like; everything else (the ejected generator copy,
// Program.cs, the `dotnet run --project codegen -- gen/verify` invocations) is exactly
// what ships.
//
// SLOW ON PURPOSE: two `dotnet run` invocations, each restoring + building the
// MetaObjects/MetaObjects.Render/MetaObjects.Codegen/Codegen chain. Kept to ONE test.

using System.Diagnostics;
using MetaObjects.Cli;
using MetaObjects.Codegen;
using Xunit;

namespace MetaObjects.Cli.Tests;

public sealed class EjectEndToEndTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "meta-eject-e2e-" + Guid.NewGuid().ToString("N"));
    private string CodegenCsproj => Path.Combine(_root, "codegen", "Codegen.csproj");
    private string GeneratorCopy => Path.Combine(_root, "codegen", "generators", "EntityGenerator.cs");
    private string MetadataDir => Path.Combine(_root, "metaobjects");
    private string OutDir => Path.Combine(_root, "out");

    public EjectEndToEndTests() => Directory.CreateDirectory(_root);
    public void Dispose() { try { Directory.Delete(_root, recursive: true); } catch { } }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "fixtures", "persistence-conformance")) &&
                Directory.Exists(Path.Combine(dir.FullName, "server", "csharp")))
                return dir.FullName;
            dir = dir.Parent;
        }
        throw new InvalidOperationException("could not locate the repo root from " + AppContext.BaseDirectory);
    }

    /// <summary>Run <paramref name="args"/> against the ejected codegen project and
    /// return (exitCode, combined stdout+stderr).</summary>
    private (int ExitCode, string Output) RunCodegenProject(params string[] args) =>
        RunProject(Path.Combine(_root, "codegen"), args);

    /// <summary><c>dotnet run --project <paramref name="project"/> -- args</c>, returning
    /// (exitCode, combined stdout+stderr).</summary>
    private (int ExitCode, string Output) RunProject(string project, params string[] args)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = _root,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        // No long-lived build processes. `dotnet run` otherwise leaves MSBuild worker nodes
        // (node reuse), the MSBuild server and the VBCSCompiler server running after it
        // exits, and they inherit the redirected stdout/stderr — so ReadToEndAsync never sees
        // EOF and the test hangs with the child already gone.
        psi.Environment["MSBUILDDISABLENODEREUSE"] = "1";
        psi.Environment["DOTNET_CLI_USE_MSBUILD_SERVER"] = "0";
        psi.Environment["UseSharedCompilation"] = "false";
        // The generated web app's default host builder watches appsettings.json with an inotify
        // instance, and the per-user limit (128 by default) is shared with every other process the
        // user runs, including other test lanes. When it is spent the app dies in
        // WebApplication.CreateBuilder with an IOException (exit 134) that has nothing to do with
        // the code under test; polling needs no inotify instance.
        psi.Environment["DOTNET_USE_POLLING_FILE_WATCHER"] = "1";
        psi.ArgumentList.Add("run");
        psi.ArgumentList.Add("--project");
        psi.ArgumentList.Add(project);
        psi.ArgumentList.Add("--");
        foreach (var a in args) psi.ArgumentList.Add(a);

        using var proc = Process.Start(psi)!;
        // Read stdout AND stderr CONCURRENTLY. `dotnet run` builds a 4-project chain
        // (MetaObjects -> MetaObjects.Render -> MetaObjects.Codegen -> Codegen) and can
        // write well past the ~64KB OS pipe buffer on either stream; reading one to
        // completion before starting the other is the textbook Process deadlock — the
        // child blocks writing to the unread stream while this method blocks reading the
        // other one. Awaiting both tasks together is the fix.
        var stdoutTask = proc.StandardOutput.ReadToEndAsync();
        var stderrTask = proc.StandardError.ReadToEndAsync();
        var exited = proc.WaitForExit(TimeSpan.FromMinutes(5));
        var output = Task.WhenAll(stdoutTask, stderrTask).GetAwaiter().GetResult();
        if (!exited)
        {
            try { proc.Kill(entireProcessTree: true); } catch { /* best effort */ }
            throw new TimeoutException($"`dotnet run --project {project} -- {string.Join(' ', args)}` did not exit within 5 minutes.");
        }
        return (proc.ExitCode, output[0] + output[1]);
    }

    [Fact]
    public void Edited_ejected_copy_changes_gen_output_and_verify_codegen_passes()
    {
        var repoRoot = RepoRoot();

        // A small, self-contained metadata source — copied rather than pointed at the
        // shared fixtures/ corpus directly, so every write this test makes (gen output,
        // .metaobjects/.gen-state/) lands under the temp root and never touches the
        // checked-in repo tree.
        Directory.CreateDirectory(MetadataDir);
        File.WriteAllText(Path.Combine(MetadataDir, "meta.acme.json"), """
        { "metadata.root": { "package": "acme::widgets", "children": [
          { "object.entity": { "name": "Widget", "children": [
            { "source.rdb": { "@table": "widgets" } },
            { "field.uuid":   { "name": "id", "@required": true } },
            { "field.string": { "name": "label", "@required": true, "@maxLength": 80 } },
            { "field.uuid":   { "name": "ownerId" } },
            { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "uuid" } },
            { "identity.reference": { "name": "ownerRef", "@fields": "ownerId", "@references": "metaobjects::iam::User" } }
          ]}}
        ]}}
        """);
        // The project opts into a library and references into it, as a real estate does.
        // The owned runner used to load a bare directory, lose `libraries`, and fail
        // ERR_INVALID_REFERENCE on this model before running a single generator.
        Directory.CreateDirectory(Path.Combine(_root, ".metaobjects"));
        File.WriteAllText(Path.Combine(_root, ".metaobjects", "config.json"), """
        { "schema_version": 1, "sources": [], "libraries": ["iam", "iam/db"] }
        """);

        // 1. Eject — writes codegen/generators/EntityGenerator.cs, codegen/Codegen.csproj,
        //    codegen/Program.cs and codegen/Generators.cs listing the copy (this is real
        //    `dotnet meta eject entity` behavior).
        var eject = EjectCommand.Run(["entity"], _root, force: false);
        Assert.Equal(0, eject.ExitCode);
        Assert.True(File.Exists(CodegenCsproj));
        Assert.True(File.Exists(GeneratorCopy));

        // The project's list declares the owned copy beside a packaged generator (ADR-0034
        // Amendment 9): ejecting one generator must not drop the others the project runs.
        var listPath = Path.Combine(_root, "codegen", "Generators.cs");
        var list = File.ReadAllText(listPath);
        const string ownedEntry = "            new Codegen.Generators.EntityGenerator(),\n";
        Assert.Contains(ownedEntry, list);
        File.WriteAllText(listPath, list.Replace(
            ownedEntry, ownedEntry + "            new MetaObjects.Codegen.Generators.NamesGenerator(),\n"));

        // 2. Substitute PackageReference -> ProjectReference (see header comment).
        var codegenProjPath = Path.Combine(repoRoot, "server", "csharp", "MetaObjects.Codegen", "MetaObjects.Codegen.csproj");
        Assert.True(File.Exists(codegenProjPath), $"expected {codegenProjPath} to exist");
        var csprojText = File.ReadAllText(CodegenCsproj);
        Assert.Contains("<PackageReference Include=\"MetaObjects.Codegen\"", csprojText);
        var rewrittenCsproj = System.Text.RegularExpressions.Regex.Replace(
            csprojText,
            "<PackageReference Include=\"MetaObjects.Codegen\"[^/]*/>",
            $"<ProjectReference Include=\"{codegenProjPath}\" />");
        Assert.DoesNotContain("PackageReference", rewrittenCsproj);
        File.WriteAllText(CodegenCsproj, rewrittenCsproj);

        // 3. Edit the ejected copy — one line, injecting a marker into every emitted
        //    file's header, proving CUSTOM LOGIC (not just the unmodified reference)
        //    flows through a real compile into real output.
        var original = File.ReadAllText(GeneratorCopy);
        Assert.Contains("sb.AppendLine(\"// <auto-generated/>\");", original);
        var edited = original.Replace(
            "sb.AppendLine(\"// <auto-generated/>\");",
            "sb.AppendLine(\"// <auto-generated/>\");\n        sb.AppendLine(\"// EJECTED-E2E-MARKER\");");
        Assert.NotEqual(original, edited);
        File.WriteAllText(GeneratorCopy, edited);

        // 4. `dotnet run --project codegen -- gen ...` — a REAL compile of the edited copy.
        //    The selection names the owned `entity` (by its registry name) AND the packaged
        //    `names`, both declared in the list.
        var (genExit, genOutput) = RunCodegenProject(
            "gen", MetadataDir, "--out", OutDir, "--namespace", "Acme.Generated", "--generators", "entity,names");
        Assert.True(genExit == 0, $"gen failed (exit {genExit}):\n{genOutput}");

        var generated = Directory.GetFiles(OutDir, "*.cs", SearchOption.AllDirectories);
        Assert.NotEmpty(generated);
        Assert.Contains(generated, f => File.ReadAllText(f).Contains("EJECTED-E2E-MARKER"));
        Assert.Contains(generated, f => Path.GetFileName(f) == "WidgetNames.g.cs");

        // 5. `dotnet run --project codegen -- verify --codegen ...` — the committed output
        //    (produced by the SAME edited copy) must read as in sync with a fresh regen.
        var (verifyExit, verifyOutput) = RunCodegenProject(
            "verify", "--codegen", MetadataDir, "--out", OutDir, "--namespace", "Acme.Generated",
            "--generators", "entity,names");
        Assert.True(verifyExit == 0, $"verify --codegen failed (exit {verifyExit}):\n{verifyOutput}");
        Assert.Contains("OK", verifyOutput);
    }

    /// <summary>Swap the scaffold's MetaObjects.Codegen PackageReference for a
    /// ProjectReference to this checkout (see the header comment).</summary>
    private void PointScaffoldAtThisCheckout(string repoRoot)
    {
        var codegenProjPath = Path.Combine(repoRoot, "server", "csharp", "MetaObjects.Codegen", "MetaObjects.Codegen.csproj");
        var rewritten = System.Text.RegularExpressions.Regex.Replace(
            File.ReadAllText(CodegenCsproj),
            "<PackageReference Include=\"MetaObjects.Codegen\"[^/]*/>",
            $"<ProjectReference Include=\"{codegenProjPath}\" />");
        Assert.DoesNotContain("PackageReference", rewritten);
        File.WriteAllText(CodegenCsproj, rewritten);
    }

    /// <summary>
    /// An owned api-docs generator, run for real (ADR-0034 Amendment 9): eject `routes` and `api-docs`,
    /// give the listed api-docs entry its own OutDir, add a page to the owned copy, and run the owned
    /// project's `gen`. The reference is written by the OWNED api-docs copy into its own directory, beside
    /// the code under --out; `--generators api-docs` writes the documentation alone; and `docs` is gone.
    /// </summary>
    [Fact]
    public void Owned_api_docs_writes_the_reference()
    {
        var repoRoot = RepoRoot();
        Directory.CreateDirectory(MetadataDir);
        File.WriteAllText(Path.Combine(MetadataDir, "meta.acme.json"), """
        { "metadata.root": { "package": "acme::widgets", "children": [
          { "object.entity": { "name": "Widget", "children": [
            { "source.rdb": { "@table": "widgets" } },
            { "field.uuid":   { "name": "id", "@required": true } },
            { "field.string": { "name": "label", "@required": true, "@maxLength": 80 } },
            { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "uuid" } }
          ]}}
        ]}}
        """);

        var eject = EjectCommand.Run(["routes", "api-docs"], _root, force: false);
        Assert.Equal(0, eject.ExitCode);
        Assert.True(CodegenHandoff.HasGeneratorList(_root));
        PointScaffoldAtThisCheckout(repoRoot);

        // The api-docs entry gets its own directory, as an adopter's list would give it.
        var listPath = Path.Combine(_root, "codegen", "Generators.cs");
        var list = File.ReadAllText(listPath);
        Assert.Contains("new Codegen.Generators.ApiDocsGenerator(),", list);
        File.WriteAllText(listPath, list.Replace(
            "new Codegen.Generators.ApiDocsGenerator(),",
            "new Codegen.Generators.ApiDocsGenerator { OutDir = \"docs\" },"));

        // The project's own edit: its reference carries a page the packaged generator does not write.
        var apiDocsPath = Path.Combine(_root, "codegen", "generators", "ApiDocsGenerator.cs");
        var apiDocs = File.ReadAllText(apiDocsPath);
        const string lastPage = "yield return Page(\"AGENT-API.md\", renderer.RenderAgentApi(model));";
        Assert.Contains(lastPage, apiDocs);
        File.WriteAllText(apiDocsPath, apiDocs.Replace(
            lastPage,
            lastPage + "\n        yield return Page(\"OWNED.md\", \"written by the owned api-docs\");"));

        var docsOut = Path.Combine(_root, "docs");
        var (genExit, genOutput) = RunCodegenProject("gen", MetadataDir, "--out", OutDir, "--namespace", "Acme.Generated");
        Assert.True(genExit == 0, $"gen failed (exit {genExit}):\n{genOutput}");

        var widget = File.ReadAllText(Directory.GetFiles(docsOut, "Widget.md", SearchOption.AllDirectories).Single());
        Assert.Contains("DbSet<Widget>", widget);
        Assert.Equal(
            "written by the owned api-docs",
            File.ReadAllText(Directory.GetFiles(docsOut, "OWNED.md", SearchOption.AllDirectories).Single()));
        Assert.NotEmpty(Directory.GetFiles(OutDir, "*.cs", SearchOption.AllDirectories));
        Assert.Empty(Directory.GetFiles(OutDir, "*.md", SearchOption.AllDirectories));

        // Documentation alone: the selection narrows the list to the api-docs entry.
        Directory.Delete(docsOut, recursive: true);
        var codeBefore = Directory.GetFiles(OutDir, "*", SearchOption.AllDirectories).ToDictionary(f => f, File.ReadAllText);
        var (namedExit, namedOutput) = RunCodegenProject(
            "gen", MetadataDir, "--out", OutDir, "--namespace", "Acme.Generated", "--generators", "api-docs");
        Assert.True(namedExit == 0, $"gen failed (exit {namedExit}):\n{namedOutput}");
        Assert.NotEmpty(Directory.GetFiles(docsOut, "*.md", SearchOption.AllDirectories));
        Assert.DoesNotContain(namedOutput.Split('\n'), l => l.Contains(".cs", StringComparison.Ordinal) && l.TrimStart().StartsWith("written:", StringComparison.Ordinal));
        Assert.Equal(codeBefore.Keys.Order(), Directory.GetFiles(OutDir, "*", SearchOption.AllDirectories).Order());

        // The docs command is gone from the owned runner too.
        var (docsExit, docsOutput) = RunCodegenProject("docs", MetadataDir, "--out", docsOut);
        Assert.Equal(2, docsExit);
        Assert.Contains(CodegenCli.DocsCommandRemoved, docsOutput);
    }

    /// <summary>
    /// The helper runtime an ejected routes generator brings with it (ADR-0034 Amendment 3):
    /// eject routes, generate through the owned project, and build + RUN a real ASP.NET Core
    /// app that compiles the generated output together with codegen/runtime/ and references
    /// NO MetaObjects package at all. Then prove the copy is the code that runs: an edit to
    /// the owned FilterParser changes the error body a live request gets back. Also proves
    /// `verify --codegen` reads the owned runtime as owned code, not as drift.
    /// </summary>
    [Fact]
    public void Ejected_routes_run_on_the_owned_helper_runtime_with_no_MetaObjects_reference()
    {
        var repoRoot = RepoRoot();
        Directory.CreateDirectory(MetadataDir);
        File.WriteAllText(Path.Combine(MetadataDir, "meta.acme.json"), """
        { "metadata.root": { "package": "acme::widgets", "children": [
          { "object.entity": { "name": "Widget", "children": [
            { "source.rdb": { "@table": "widgets" } },
            { "field.uuid":   { "name": "id", "@required": true } },
            { "field.string": { "name": "label", "@required": true, "@maxLength": 80 } },
            { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "uuid" } }
          ]}}
        ]}}
        """);

        const string selection = "entity,names,db-context,filter-allowlist,routes";
        var eject = EjectCommand.Run(["entity", "names", "db-context", "filter-allowlist", "routes"], _root, force: false);
        Assert.Equal(0, eject.ExitCode);
        var runtimeDir = Path.Combine(_root, "codegen", "runtime");
        Assert.True(File.Exists(Path.Combine(runtimeDir, "FilterParser.cs")));
        PointScaffoldAtThisCheckout(repoRoot);

        var (genExit, genOutput) = RunCodegenProject(
            "gen", MetadataDir, "--out", OutDir, "--namespace", "Acme.Generated", "--generators", selection);
        Assert.True(genExit == 0, $"gen failed (exit {genExit}):\n{genOutput}");

        var generated = Directory.GetFiles(OutDir, "*.cs", SearchOption.AllDirectories);
        var routesFile = Assert.Single(generated, f => File.ReadAllText(f).Contains("MapWidgetRoutes"));
        var routesText = File.ReadAllText(routesFile);
        Assert.Contains("using Codegen.Runtime;", routesText);
        Assert.DoesNotContain(generated, f => File.ReadAllText(f).Contains("MetaObjects.Codegen"));

        // verify --codegen: the owned runtime lives outside --out and is never drift.
        var (verifyExit, verifyOutput) = RunCodegenProject(
            "verify", "--codegen", MetadataDir, "--out", OutDir, "--namespace", "Acme.Generated", "--generators", selection);
        Assert.True(verifyExit == 0, $"verify --codegen failed (exit {verifyExit}):\n{verifyOutput}");

        // The adopter's fix, made in their own copy.
        var parserPath = Path.Combine(runtimeDir, "FilterParser.cs");
        var parser = File.ReadAllText(parserPath);
        Assert.Contains("\"invalid_filter_field\"", parser);
        File.WriteAllText(parserPath, parser.Replace("\"invalid_filter_field\"", "\"invalid_filter_field_OWNED_EDIT\""));

        // The same verify stays clean after the edit: the runtime copy is owned code.
        var (verify2Exit, verify2Output) = RunCodegenProject(
            "verify", "--codegen", MetadataDir, "--out", OutDir, "--namespace", "Acme.Generated", "--generators", selection);
        Assert.True(verify2Exit == 0, $"verify --codegen after a runtime edit failed (exit {verify2Exit}):\n{verify2Output}");

        // A real web app: generated output + the owned runtime, EF Core + SQLite, and no
        // MetaObjects reference of any kind.
        var appDir = Path.Combine(_root, "app");
        Directory.CreateDirectory(appDir);
        File.WriteAllText(Path.Combine(appDir, "App.csproj"), """
        <Project Sdk="Microsoft.NET.Sdk.Web">
          <PropertyGroup>
            <TargetFramework>net8.0</TargetFramework>
            <ImplicitUsings>enable</ImplicitUsings>
            <Nullable>enable</Nullable>
          </PropertyGroup>
          <ItemGroup>
            <Compile Include="../out/**/*.cs" />
            <Compile Include="../codegen/runtime/**/*.cs" />
          </ItemGroup>
          <ItemGroup>
            <PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.10" />
            <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="8.0.10" />
          </ItemGroup>
        </Project>
        """);
        var route = System.Text.RegularExpressions.Regex.Match(routesText, "prefix \\+ \"(/[^\"/{]+)\"").Groups[1].Value;
        Assert.False(string.IsNullOrEmpty(route), "could not find the collection route in the generated routes file");
        File.WriteAllText(Path.Combine(appDir, "Program.cs"), $$"""
        using Acme.Generated;
        using Codegen.Runtime;
        using Microsoft.EntityFrameworkCore;

        var builder = WebApplication.CreateBuilder(args);
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        builder.Services.AddDbContext<AppDbContext>(o => o.UseSqlite("Data Source=:memory:"));
        builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.Converters.Add(new Iso8601TimestampConverter()));
        var app = builder.Build();
        app.MapWidgetRoutes();
        await app.StartAsync();
        using var http = new HttpClient { BaseAddress = new Uri(app.Urls.First()) };
        var resp = await http.GetAsync("/api{{route}}?filter[nope][eq]=1");
        Console.WriteLine($"STATUS={(int)resp.StatusCode}");
        Console.WriteLine($"BODY={await resp.Content.ReadAsStringAsync()}");
        await app.StopAsync();
        """);

        var (appExit, appOutput) = RunProject(appDir);
        Assert.True(appExit == 0, $"the app did not build or run (exit {appExit}):\n{appOutput}");
        Assert.DoesNotContain("MetaObjects", File.ReadAllText(Path.Combine(appDir, "App.csproj")));
        Assert.Contains("STATUS=400", appOutput);
        Assert.Contains("invalid_filter_field_OWNED_EDIT", appOutput);
    }
}
