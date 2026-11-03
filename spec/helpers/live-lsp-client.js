const { serverContext } = require("./server-resolver");
const childProcess = require("child_process");
const path = require("path");
const { configurationContext, workspaceConfiguration } = require(
  path.join(lumine.packages.resolvePackagePath("ide"), "lib", "workspace-configuration"),
);
const { pathToFileURL } = require("url");
const {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} = require("vscode-jsonrpc/node");

const withTimeout = (promise, label, timeout = 10000) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `${typeof label === "function" ? label() : label} timed out after ${timeout}ms`,
            ),
          ),
        timeout,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

class LiveLspClient {
  constructor(adapter, rootPath) {
    this.adapter = adapter;
    this.rootPath = rootPath;
    this.notifications = [];
    this.stderr = "";
  }

  configurationContext() {
    return configurationContext(this.rootPath, this.launch, this.session, serverContext().resolver);
  }

  configuration(items) {
    return workspaceConfiguration(this.adapter, items, this.configurationContext());
  }

  async start() {
    this.startupDeadline = Date.now() + 30000;
    const launch = await this.adapter.resolveServer(serverContext({ rootPath: this.rootPath }));
    this.launch = launch;
    this.child = childProcess.spawn(launch.command, launch.args || [], {
      cwd: launch.cwd || this.rootPath,
      env: { ...process.env, ...(launch.env || {}) },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk) => (this.stderr += chunk.toString()));
    this.connection = createMessageConnection(
      new StreamMessageReader(this.child.stdout),
      new StreamMessageWriter(this.child.stdin),
      {
        error: (message) => (this.stderr += `${message}\n`),
        warn: (message) => (this.stderr += `${message}\n`),
        info() {},
        log() {},
      },
    );
    this.connection.onNotification((method, params) => this.notifications.push({ method, params }));
    this.connection.onRequest("workspace/configuration", ({ items }) => this.configuration(items));
    this.connection.onRequest("workspace/applyEdit", () => ({ applied: true }));
    this.connection.onRequest("workspace/workspaceFolders", () => this.workspaceFolders);
    this.connection.onRequest("client/registerCapability", () => null);
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.listen();

    const rootUri = pathToFileURL(this.rootPath).href;
    this.workspaceFolders = [{ uri: rootUri, name: path.basename(this.rootPath) }];
    // Starting a cold native executable has a different budget from requests
    // sent to an initialized server. Keep ordinary protocol requests at 10s.
    const result = await this.request(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: "Lumine adapter integration specs", version: "1.0.0" },
        rootUri,
        initializationOptions: {
          ...(await this.adapter.getInitializationOptions?.({
            ...serverContext({ rootPath: this.rootPath }),
            rootUri,
          })),
          clangdFileStatus: true,
        },
        workspaceFolders: this.workspaceFolders,
        capabilities: {
          workspace: { applyEdit: true, configuration: true, workspaceFolders: true },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: true },
            publishDiagnostics: {
              relatedInformation: true,
              versionSupport: true,
              tagSupport: { valueSet: [1, 2] },
            },
            completion: {
              dynamicRegistration: true,
              completionItem: {
                snippetSupport: true,
                documentationFormat: ["markdown", "plaintext"],
              },
            },
            hover: { dynamicRegistration: true, contentFormat: ["markdown", "plaintext"] },
            definition: { dynamicRegistration: true, linkSupport: true },
            references: { dynamicRegistration: true },
            documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true },
            formatting: { dynamicRegistration: true },
            rename: { dynamicRegistration: true, prepareSupport: true },
            inlayHint: { dynamicRegistration: true },
            codeAction: {
              codeActionLiteralSupport: {
                codeActionKind: { valueSet: ["quickfix", "refactor", "source"] },
              },
              resolveSupport: { properties: ["edit"] },
            },
            semanticTokens: {
              requests: { full: true, range: true },
              tokenTypes: [
                "namespace",
                "type",
                "class",
                "struct",
                "function",
                "method",
                "parameter",
                "variable",
                "property",
                "enumMember",
                "macro",
                "keyword",
                "comment",
                "string",
                "number",
                "operator",
              ],
              tokenModifiers: [
                "declaration",
                "definition",
                "readonly",
                "static",
                "deprecated",
                "abstract",
                "async",
                "modification",
                "documentation",
                "defaultLibrary",
              ],
              formats: ["relative"],
              overlappingTokenSupport: false,
              multilineTokenSupport: false,
            },
            callHierarchy: { dynamicRegistration: false },
            typeHierarchy: { dynamicRegistration: false },
          },
          window: { workDoneProgress: true },
          general: { positionEncodings: ["utf-16"] },
        },
      },
      Math.max(1, this.startupDeadline - Date.now()),
    );
    this.connection.sendNotification("initialized", {});
    this.connection.sendNotification("workspace/didChangeConfiguration", {
      settings: (await this.adapter.getSettings?.(this.configurationContext())) ?? {},
    });
    return result;
  }

  request(method, params, timeout) {
    return withTimeout(
      this.connection.sendRequest(method, params),
      () => `${this.adapter.displayName} ${method}; stderr: ${this.stderr}`,
      timeout,
    );
  }

  async open(uri, languageId, text) {
    const connection = this.connection;
    const timeout = this.startupDeadline ? this.startupDeadline - Date.now() : 10000;
    if (timeout <= 0) throw new Error("clangd startup timed out before opening its document.");
    let subscription;
    try {
      await withTimeout(
        new Promise((resolve, reject) => {
          // clangd's file-status extension reports idle only when both its
          // preamble and AST workers are idle. Subscribe before didOpen so an
          // immediate response is causal and cannot be missed. Each test uses
          // a fresh connection and a unique URI; diagnostics are not this ack.
          // https://clangd.llvm.org/extensions#file-status
          subscription = connection.onNotification("textDocument/clangd.fileStatus", (params) => {
            if (this.connection !== connection)
              reject(new Error("clangd connection changed while opening its document."));
            else if (params.uri === uri && params.state === "idle") resolve(params);
          });
          Promise.resolve(
            connection.sendNotification("textDocument/didOpen", {
              textDocument: { uri, languageId, version: 1, text },
            }),
          ).catch(reject);
        }),
        () => `clangd initial document readiness; stderr: ${this.stderr}`,
        timeout,
      );
      this.startupDeadline = null;
    } finally {
      subscription?.dispose();
    }
  }

  change(uri, text, version = 2) {
    this.connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  messages(method) {
    return this.notifications.filter((message) => message.method === method);
  }

  async waitFor(check, label, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = await check();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${label} timed out; stderr: ${this.stderr}`);
  }

  async stop() {
    if (!this.connection) return;
    try {
      await withTimeout(this.connection.sendRequest("shutdown"), "shutdown", 2500);
      this.connection.sendNotification("exit");
    } catch {
      this.child?.kill();
    }
    await Promise.race([
      new Promise((resolve) => this.child.once("exit", resolve)),
      new Promise((resolve) =>
        setTimeout(() => {
          this.child.kill();
          resolve();
        }, 1000),
      ),
    ]);
    this.connection.dispose();
  }
}

exports.LiveLspClient = LiveLspClient;
exports.fileUri = (filePath) => pathToFileURL(filePath).href;
