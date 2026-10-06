const fs = require("fs");
const path = require("path");

exports.assetFor = ({ platform, arch, version }) => {
  const system = { win32: "windows", linux: "linux", darwin: "mac" }[platform];
  if (!system || arch !== "x64") return null;
  return `clangd-${system}-${version}.zip`;
};

exports.installServer = async ({
  storagePath,
  api,
  version,
  platform = process.platform,
  arch = process.arch,
}) => {
  api.setServerInstallationStatus("checking");
  const release = version
    ? await api.githubReleaseByTag("clangd/clangd", version)
    : await api.latestGithubRelease("clangd/clangd");
  const assetName = exports.assetFor({
    platform,
    arch,
    version: release.version,
  });
  const asset = assetName && release.assets.find(({ name }) => name === assetName);
  if (!asset)
    throw new Error(
      `No clangd release is available for ${platform}/${arch}. Use Server Path to select a locally installed clangd.`,
    );
  if (!asset.digest) throw new Error("The clangd release has no checksum for its archive.");
  api.setServerInstallationStatus("downloading");
  await api.downloadFile(asset.url, storagePath, { type: "zip", digest: asset.digest });
  const binary = path.join(
    `clangd_${release.version}`,
    "bin",
    platform === "win32" ? "clangd.exe" : "clangd",
  );
  await fs.promises.access(path.join(storagePath, binary));
  await api.makeFileExecutable(path.join(storagePath, binary));
  // Keep lib/clang beside the executable: its builtin headers are part of the server.
  return { version: release.version, binary };
};

exports.latestServerVersion = async (api) =>
  (await api.latestGithubRelease("clangd/clangd")).version;

exports.resolveServer = async (context, configuredPath = "") => {
  const selection = await context.resolver.select({
    kind: "executable",
    configuredPath,
    managedPath: context.managedServer?.binaryPath,
    managedVersion: context.managedServer?.version,
    env: context.env,
    cwd: context.rootPath,
    names: ["clangd"],
    signal: context.signal,
  });
  return selection
    ? context.resolver.launch(selection, { signal: context.signal, args: [] })
    : null;
};
