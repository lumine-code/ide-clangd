const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const executable = process.env.CLANGD_PATH;
const liveSuite = executable || process.env.REQUIRE_CLANGD ? describe : xdescribe;
const source =
  "int add(int left, int right) {return left+right;}\n" +
  "int caller() { /* 🌟 */ return add(1, 2); }\n" +
  "int main() {return caller();}\n";
const positionOf = (text, token, occurrence = 0) => {
  let index = -1;
  for (let count = 0; count <= occurrence; count += 1) index = text.indexOf(token, index + 1);
  if (index < 0) throw new Error(`Missing clangd fixture token: ${token}`);
  const prefix = text.slice(0, index).split("\n");
  return { line: prefix.length - 1, character: prefix.at(-1).length };
};
const applyFormatEdits = (editor, edits) => {
  const { Range } = require("lumine");
  const normalized = edits.map((edit) => ({ ...edit, range: Range.fromObject(edit.oldRange) }));
  editor.transact(() => {
    for (const edit of normalized.sort(
      (first, second) =>
        second.range.start.row - first.range.start.row ||
        second.range.start.column - first.range.start.column,
    ))
      editor.setTextInBufferRange(edit.range, edit.newText);
  });
};

liveSuite("ide-clangd through the real ide-client service", () => {
  let root, file, uri, editor, clientMain, service, registration, originalPaths, session;
  const changed = new Set();
  const scoped = new Set();
  const configure = (key, value, options) => {
    (options ? scoped : changed).add(key);
    lumine.config.set(`ide-clangd.${key}`, value, options);
  };
  const waitFor = async (check, label) => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try {
        const value = await check();
        if (value) return value;
      } catch (error) {
        if (![-32801, -32802].includes(error.code)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${label} timed out: ${JSON.stringify(service.getLog("ide-clangd"))}`);
  };
  const requestAt = (method, token, occurrence = 0, extra = {}) =>
    session.request(method, {
      textDocument: { uri },
      position: positionOf(editor.getText(), token, occurrence),
      ...extra,
    });

  beforeEach(async () => {
    jasmine.useRealClock();
    if (!executable) throw new Error("The live client suite requires CLANGD_PATH.");
    root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ide-clangd-client-"));
    file = path.join(root, "main.cpp");
    fs.writeFileSync(file, source);
    uri = pathToFileURL(file).href;
    originalPaths = lumine.project.getPaths();
    const clientPackage = await lumine.packages.activatePackage("ide-client");
    clientMain = clientPackage.mainModule;
    service = clientMain.provideIdeClient();
    const clangPackage = await lumine.packages.activatePackage("ide-clangd");
    configure("serverPath", executable);
    configure("arguments", ["--background-index", "--log=error"]);

    // Own this service edge explicitly, while exercising the real package's
    // consumption hook. Remove any bootstrap edge before registering ours.
    const bootstrap = clientMain.manager.adapters.get("ide-clangd");
    if (bootstrap) await clientMain.manager.unregisterAdapter(bootstrap);
    registration = clangPackage.mainModule.consumeIdeClient(service);

    await lumine.packages.activatePackage("language-c");
    lumine.project.setPaths([root]);
    editor = await lumine.workspace.open(file);
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.cpp"));
    editor.setSoftTabs(true);
    editor.setTabLength(2);
    session = await waitFor(
      () => service.activeSessionForFeature(editor, "textDocument/hover", "hover"),
      "clangd session startup",
    );
    await waitFor(() => requestAt("textDocument/hover", "add", 1), "clangd parse");
  }, 90000);

  afterEach(async () => {
    for (const key of scoped)
      lumine.config.unset(`ide-clangd.${key}`, { scopeSelector: ".source.cpp" });
    for (const key of changed) lumine.config.unset(`ide-clangd.${key}`);
    scoped.clear();
    changed.clear();
    registration?.dispose();
    for (const current of service?.getSessions() || [])
      if (current.adapter.id === "ide-clangd") await service.stop(current);
    for (const item of lumine.workspace.getTextEditors())
      if (root && item.getPath()?.startsWith(root)) item.destroy();
    if (originalPaths) lumine.project.setPaths(originalPaths);
    await lumine.packages.deactivatePackage("ide-clangd");
    await lumine.packages.deactivatePackage("ide-client");
    if (root) {
      const prefix = path.join(fs.realpathSync.native(os.tmpdir()), "ide-clangd-client-");
      if (!root.startsWith(prefix)) throw new Error("Unexpected clangd fixture cleanup path.");
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 30000);

  it("routes definitions and callers, formats the buffer and applies UTF-16 rename edits", async () => {
    expect(session.adapter.id).toBe("ide-clangd");
    expect(editor.getGrammar().scopeName).toBe("source.cpp");
    const callPosition = positionOf(source, "add", 1);
    const prefix = source.split("\n")[callPosition.line].slice(0, callPosition.character);
    expect(callPosition.character).toBe(Array.from(prefix).length + 1);

    const definitions = await requestAt("textDocument/definition", "add", 1);
    expect(definitions[0].targetSelectionRange?.start || definitions[0].range.start).toEqual({
      line: 0,
      character: 4,
    });
    const references = await requestAt("textDocument/references", "add", 1, {
      context: { includeDeclaration: true },
    });
    expect(references.length).toBe(2);
    expect(
      references.some(
        ({ range }) =>
          range.start.line === callPosition.line &&
          range.start.character === callPosition.character,
      ),
    ).toBe(true);
    const items = await requestAt("textDocument/prepareCallHierarchy", "add", 1);
    const callers = await session.request("callHierarchy/incomingCalls", { item: items[0] });
    expect(callers.some(({ from }) => from.name === "caller")).toBe(true);

    const fileProvider = clientMain.provideCodeFormatFile();
    const saveProvider = clientMain.provideCodeFormatOnSave();
    const edits = await fileProvider.formatEntireFile(editor);
    const saveEdits = await saveProvider.formatOnSave(editor);
    expect(edits.length).toBeGreaterThan(0);
    expect(saveEdits.length).toBeGreaterThan(0);
    expect(edits.every(({ oldRange, newText }) => oldRange && typeof newText === "string")).toBe(
      true,
    );
    applyFormatEdits(editor, edits);
    expect(editor.getText()).toContain("left + right");
    expect(editor.getText()).toContain("🌟");
    await waitFor(
      () => requestAt("textDocument/hover", "add", 1),
      "formatted-buffer synchronization",
    );

    const renamed = await requestAt("textDocument/rename", "add", 1, { newName: "sum" });
    const applied = await service.applyWorkspaceEdit(renamed, "Rename C++ function", session);
    if (!applied)
      throw new Error(
        `clangd rename was refused: ${lumine.notifications
          .getNotifications()
          .map((notification) => notification.getDetail())
          .join("; ")}`,
      );
    expect(editor.getText()).toContain("int sum(int left, int right)");
    expect(editor.getText()).toContain("return sum(1, 2);");
    expect(editor.getText()).not.toContain("add(");
    expect(editor.getText()).toContain("🌟");
    const hover = await waitFor(
      () => requestAt("textDocument/hover", "sum", 1),
      "renamed-buffer synchronization",
    );
    expect(hover.contents.value).toContain("int sum");
  }, 90000);

  it("honors scoped feature gates and releases routing and the native process on stop and unload", async () => {
    configure("features.hover", false);
    configure("features.format", false);
    expect(await service.activeSessionForFeature(editor, "textDocument/hover", "hover")).toBeNull();
    expect(await clientMain.provideCodeFormatFile().formatEntireFile(editor)).toEqual([]);
    expect(await clientMain.provideCodeFormatOnSave().formatOnSave(editor)).toEqual([]);

    configure("features.hover", true, { scopeSelector: ".source.cpp" });
    configure("features.format", true, { scopeSelector: ".source.cpp" });
    expect(await service.activeSessionForFeature(editor, "textDocument/hover", "hover")).toBe(
      session,
    );
    const cEditor = lumine.workspace.buildTextEditor();
    try {
      cEditor.setGrammar(lumine.grammars.grammarForScopeName("source.c"));
      expect(service.featureEnabled(session.adapter, "hover", cEditor)).toBe(false);
      expect(service.featureEnabled(session.adapter, "format", cEditor)).toBe(false);
    } finally {
      cEditor.destroy();
    }
    expect(
      (await clientMain.provideCodeFormatFile().formatEntireFile(editor)).length,
    ).toBeGreaterThan(0);
    expect((await requestAt("textDocument/hover", "add", 1)).contents.value).toContain("int add");

    await service.stop(session);
    expect(session.state).toBe("stopped");
    expect(session.processExited).toBe(true);
    expect(service.getSessions().includes(session)).toBe(false);
    registration.dispose();
    registration = null;
    await lumine.packages.deactivatePackage("ide-clangd");
    await lumine.packages.unloadPackage("ide-clangd");
    expect(service.adaptersForEditor(editor).some(({ id }) => id === "ide-clangd")).toBe(false);
    expect(await service.activeSessionForFeature(editor, "textDocument/hover", "hover")).toBeNull();
  }, 90000);
});
