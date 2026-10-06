const { resolver, serverContext, installContext } = require("./helpers/server-resolver");
const fs = require("fs");
const os = require("os");
const path = require("path");

describe("ide-clangd adapter", () => {
  let main, adapter, registration;
  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("ide-clangd")).mainModule;
    registration = { dispose: jasmine.createSpy("dispose") };
    main.consumeIde({
      registerAdapter(value) {
        adapter = value;
        return registration;
      },
      reportMissingServer() {},
    });
  });
  afterEach(async () => {
    registration.dispose();
    await lumine.packages.deactivatePackage("ide-clangd");
  });

  it("registers all four supported grammars and releases its service edge", () => {
    expect(adapter.grammarScopes).toEqual([
      "source.c",
      "source.cpp",
      "source.objc",
      "source.objcpp",
    ]);
    expect(adapter.languageIdForScope("source.cpp")).toBe("cpp");
    expect(adapter.languageIdForScope("source.objcpp")).toBe("objective-cpp");
    expect(main.consumeIde({ registerAdapter: () => registration })).toBe(registration);
  });

  it("passes compiler flags and resolves the compilation database against the project", async () => {
    lumine.config.set("ide-clangd.serverPath", process.execPath);
    lumine.config.set("ide-clangd.arguments", ["--background-index", "--log=error"]);
    lumine.config.set("ide-clangd.compileCommandsPath", "build debug");
    lumine.config.set("ide-clangd.fallbackFlags", ["-std=c++20", "-Iinclude"]);
    const launch = await adapter.resolveServer(serverContext({ rootPath: __dirname }));
    expect(launch.command).toBe(process.execPath);
    expect(launch.cwd).toBe(__dirname);
    expect(launch.args).toEqual([
      "--background-index",
      "--log=error",
      `--compile-commands-dir=${path.join(__dirname, "build debug")}`,
    ]);
    expect(adapter.getInitializationOptions().fallbackFlags).toEqual(["-std=c++20", "-Iinclude"]);
  });

  it("does not mutate the configured argument list", async () => {
    lumine.config.set("ide-clangd.serverPath", process.execPath);
    lumine.config.set("ide-clangd.compileCommandsPath", "build");
    await adapter.resolveServer(serverContext({ rootPath: __dirname }));
    await adapter.resolveServer(serverContext({ rootPath: __dirname }));
    expect(lumine.config.get("ide-clangd.arguments")).toEqual([
      "--background-index",
      "--clang-tidy",
    ]);
  });

  it("reports a missing server through the hub", async () => {
    spyOn(resolver, "select").and.resolveTo(null);
    const reportMissingServer = jasmine.createSpy("missing");
    main.consumeIde({
      registerAdapter(value) {
        adapter = value;
        return registration;
      },
      reportMissingServer,
    });
    expect(await adapter.resolveServer(serverContext({ rootPath: __dirname }))).toBeNull();
    const [id, options] = reportMissingServer.calls.mostRecent().args;
    expect(id).toBe("ide-clangd");
    expect(typeof options.description).toBe("string");
  });

  it("selects only the official x64 archives", () => {
    const server = require("../lib/server");
    for (const [platform, system] of [
      ["win32", "windows"],
      ["linux", "linux"],
      ["darwin", "mac"],
    ]) {
      expect(server.assetFor({ platform, arch: "x64", version: "23.1.0" })).toBe(
        `clangd-${system}-23.1.0.zip`,
      );
      expect(server.assetFor({ platform, arch: "arm64", version: "23.1.0" })).toBeNull();
    }
    expect(server.assetFor({ platform: "freebsd", arch: "x64", version: "23.1.0" })).toBeNull();
  });

  for (const platform of ["win32", "linux", "darwin"]) {
    it(`installs the verified ${platform}/x64 archive with its builtin-header directory`, async () => {
      const server = require("../lib/server");
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ide-clangd-install-"));
      try {
        const binary = path.join(
          root,
          "clangd_23.1.0",
          "bin",
          platform === "win32" ? "clangd.exe" : "clangd",
        );
        const header = path.join(
          root,
          "clangd_23.1.0",
          "lib",
          "clang",
          "23",
          "include",
          "stddef.h",
        );
        const asset = {
          name: server.assetFor({ platform, arch: "x64", version: "23.1.0" }),
          url: "https://example.test/clangd.zip",
          digest: "sha256:abc",
        };
        const api = {
          setServerInstallationStatus: jasmine.createSpy("status"),
          latestGithubRelease: async () => ({ version: "23.1.0", assets: [asset] }),
          downloadFile: jasmine.createSpy("download").and.callFake(async () => {
            fs.mkdirSync(path.dirname(binary), { recursive: true });
            fs.writeFileSync(binary, "binary");
            fs.mkdirSync(path.dirname(header), { recursive: true });
            fs.writeFileSync(header, "header");
          }),
          makeFileExecutable: jasmine.createSpy("executable").and.resolveTo(),
        };
        const result = await server.installServer(
          installContext({
            storagePath: root,
            api,
            platform,
            arch: "x64",
          }),
        );
        expect(result.binary).toBe(path.relative(root, binary));
        expect(fs.existsSync(header)).toBe(true);
        expect(api.downloadFile).toHaveBeenCalledWith(asset.url, root, {
          type: "zip",
          digest: asset.digest,
        });
        expect(api.makeFileExecutable).toHaveBeenCalledWith(binary);
      } finally {
        if (root.startsWith(path.join(os.tmpdir(), "ide-clangd-install-")))
          fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("refuses an unsupported architecture before downloading", async () => {
    const server = require("../lib/server");
    const api = {
      setServerInstallationStatus() {},
      latestGithubRelease: async () => ({
        version: "23.1.0",
        assets: [{ name: "clangd-mac-23.1.0.zip", digest: "sha256:abc" }],
      }),
      downloadFile: jasmine.createSpy("download"),
    };
    await expectAsync(
      server.installServer(
        installContext({ storagePath: __dirname, api, platform: "darwin", arch: "arm64" }),
      ),
    ).toBeRejectedWithError(/No clangd release is available for darwin\/arm64/);
    expect(api.downloadFile).not.toHaveBeenCalled();
  });

  it("refuses a release without a checksum before downloading", async () => {
    const server = require("../lib/server");
    const api = {
      setServerInstallationStatus() {},
      latestGithubRelease: async () => ({
        version: "23.1.0",
        assets: [
          {
            name: server.assetFor({
              platform: "linux",
              arch: "x64",
              version: "23.1.0",
            }),
            url: "https://example.test/clangd.zip",
          },
        ],
      }),
      downloadFile: jasmine.createSpy("download"),
    };
    await expectAsync(
      server.installServer(
        installContext({ storagePath: __dirname, api, platform: "linux", arch: "x64" }),
      ),
    ).toBeRejectedWithError(/checksum/);
    expect(api.downloadFile).not.toHaveBeenCalled();
  });

  it("exposes every verified feature without unsupported code lenses", () => {
    const manifest = require("../package.json");
    expect(manifest.configSchema.features.properties.codeLens).toBeUndefined();
    expect(manifest.configSchema.features.properties.typeHierarchy).toBeDefined();
    expect(main.provideBackgroundTips().packageName).toBe(manifest.name);
  });
});
