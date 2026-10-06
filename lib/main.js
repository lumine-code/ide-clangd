const path = require("path");
const { resolveServer, installServer, latestServerVersion } = require("./server");

const setting = (key) => lumine.config.get(`ide-clangd.${key}`);

module.exports = {
  consumeIdeClient(service) {
    return service.registerAdapter({
      id: "ide-clangd",
      displayName: "clangd",
      grammarScopes: ["source.c", "source.cpp", "source.objc", "source.objcpp"],
      languageIdForScope(scope) {
        return {
          "source.c": "c",
          "source.cpp": "cpp",
          "source.objc": "objective-c",
          "source.objcpp": "objective-cpp",
        }[scope];
      },
      sessionScope: "project-root",
      settingsKeyPaths: ["ide-clangd"],
      restartKeyPaths: [
        "ide-clangd.serverPath",
        "ide-clangd.arguments",
        "ide-clangd.compileCommandsPath",
        "ide-clangd.fallbackFlags",
      ],
      installServer,
      latestServerVersion,
      async resolveServer(context) {
        const launch = await resolveServer(context, setting("serverPath"));
        if (!launch) {
          service.reportMissingServer("ide-clangd", {
            description:
              "Install [clangd](https://clangd.llvm.org/installation), select its executable in Server Path, or let the editor download it.",
          });
          return null;
        }
        const args = [...(setting("arguments") || [])];
        const database = setting("compileCommandsPath");
        if (database)
          args.push(`--compile-commands-dir=${path.resolve(context.rootPath, database)}`);
        return { ...launch, args, cwd: context.rootPath, transport: "stdio" };
      },
      getInitializationOptions() {
        return { fallbackFlags: setting("fallbackFlags") || [] };
      },
    });
  },

  provideBackgroundTips() {
    return {
      packageName: "ide-clangd",
      tips: [
        "For accurate C and C++ navigation, give clangd your project's compile_commands.json; CMake can generate it with CMAKE_EXPORT_COMPILE_COMMANDS.",
      ],
    };
  },
};
