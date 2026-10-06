const fs = require("fs");
const os = require("os");
const path = require("path");
const { findOnPath } = require("./helpers/server-resolver");
const { LiveLspClient, fileUri } = require("./helpers/live-lsp-client");

const executable = process.env.CLANGD_PATH || findOnPath("clangd");
if (process.env.REQUIRE_CLANGD && !executable)
  throw new Error("CLANGD_PATH is required for the live server suite.");
const liveSuite = executable ? describe : xdescribe;
const position = (text, token, occurrence = 0) => {
  let index = -1;
  for (let count = 0; count <= occurrence; count++) index = text.indexOf(token, index + 1);
  if (index < 0) throw new Error(`Missing fixture token: ${token}`);
  const prefix = text.slice(0, index);
  return {
    line: prefix.split("\n").length - 1,
    character: prefix.length - prefix.lastIndexOf("\n") - 1,
  };
};
const applyEdits = (text, edits) => {
  const offset = ({ line, character }) =>
    text
      .split("\n")
      .slice(0, line)
      .reduce((sum, row) => sum + row.length + 1, 0) + character;
  for (const edit of [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start)))
    text =
      text.slice(0, offset(edit.range.start)) + edit.newText + text.slice(offset(edit.range.end));
  return text;
};

liveSuite("ide-clangd official server", () => {
  let main, adapter, client, root, uri, text, originalTimeout;
  beforeAll(() => {
    originalTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 30000;
  });
  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout;
  });
  beforeEach(async () => {
    jasmine.useRealClock();
    root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ide-clangd-live-"));
    main = (await lumine.packages.activatePackage("ide-clangd")).mainModule;
    lumine.config.set("ide-clangd.serverPath", executable);
    lumine.config.set("ide-clangd.arguments", [
      "--background-index",
      "--clang-tidy",
      "--log=error",
    ]);
    main.consumeIde({
      registerAdapter(value) {
        adapter = value;
        return { dispose() {} };
      },
      reportMissingServer() {},
    });
    client = new LiveLspClient(adapter, root);
    await client.start();
    text =
      "int add(int left, int right) {return left+right;}\nint main() { int result = add(1, 2); return result; }\n";
    const file = path.join(root, "main.cpp");
    fs.writeFileSync(file, text);
    uri = fileUri(file);
    client.open(uri, "cpp", text);
    await client.waitFor(
      () =>
        client.messages("textDocument/publishDiagnostics").some(({ params }) => params.uri === uri),
      "initial diagnostics",
    );
  });
  afterEach(async () => {
    await client?.stop();
    await lumine.packages.deactivatePackage("ide-clangd");
    if (!root.startsWith(path.join(fs.realpathSync.native(os.tmpdir()), "ide-clangd-live-")))
      throw new Error("Unexpected scratch path");
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const requestAt = (method, token, occurrence = 0, extra = {}) =>
    client.request(method, {
      textDocument: { uri },
      position: position(text, token, occurrence),
      ...extra,
    });

  it("returns definitions, references, hover and document symbols", async () => {
    const definition = await requestAt("textDocument/definition", "add", 1);
    expect(definition[0].range.start).toEqual({ line: 0, character: 4 });
    expect(
      (
        await requestAt("textDocument/references", "add", 1, {
          context: { includeDeclaration: true },
        })
      ).length,
    ).toBe(2);
    expect((await requestAt("textDocument/hover", "add", 1)).contents.value).toContain("int add");
    expect(
      (await client.request("textDocument/documentSymbol", { textDocument: { uri } })).map(
        ({ name }) => name,
      ),
    ).toEqual(["add", "main"]);
  });

  it("completes project symbols and shows parameter signatures", async () => {
    const completion = await client.request("textDocument/completion", {
      textDocument: { uri },
      position: { ...position(text, "add", 1), character: position(text, "add", 1).character + 2 },
    });
    expect(
      completion.items.some(({ label, filterText }) => (filterText || label).startsWith("add")),
    ).toBe(true);
    const at = position(text, "1, 2");
    at.character += 3;
    const signature = await client.request("textDocument/signatureHelp", {
      textDocument: { uri },
      position: at,
    });
    expect(signature.signatures[0].label).toContain("add");
    expect(signature.activeParameter).toBe(1);
  });

  it("renames both occurrences after a non-BMP character using UTF-16 positions", async () => {
    text =
      "int add(int left, int right) {return left+right;}\nint main() { /* 🌟 */ return add(1, 2); }\n";
    client.change(uri, text);
    const edit = await requestAt("textDocument/rename", "add", 1, { newName: "sum" });
    const edits =
      edit.changes?.[uri] || edit.documentChanges?.flatMap(({ edits: items }) => items) || [];
    const renamed = applyEdits(text, edits);
    expect(renamed).toContain("/* 🌟 */ return sum(1, 2)");
    expect(renamed).toContain("int sum(");
    expect(renamed).not.toContain("add(");
  });

  it("formats source and returns standard inlay hints and semantic tokens", async () => {
    const edits = await client.request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    });
    expect(applyEdits(text, edits)).toContain("left + right");
    const hints = await client.request("textDocument/inlayHint", {
      textDocument: { uri },
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
    });
    expect(JSON.stringify(hints)).toContain("left:");
    const tokens = await client.request("textDocument/semanticTokens/full", {
      textDocument: { uri },
    });
    expect(tokens.data.length).toBeGreaterThan(0);
    expect(tokens.data.length % 5).toBe(0);
  });

  it("reports and clears diagnostics as the unsaved buffer changes", async () => {
    const changed = "int main() { return missing_name; }\n";
    client.change(uri, changed, 2);
    await client.waitFor(
      () =>
        client
          .messages("textDocument/publishDiagnostics")
          .find(
            ({ params }) =>
              params.uri === uri &&
              params.version === 2 &&
              params.diagnostics.some(({ message }) => message.includes("missing_name")),
          ),
      "undefined name diagnostic",
    );
    client.change(uri, text, 3);
    const cleared = await client.waitFor(
      () =>
        client
          .messages("textDocument/publishDiagnostics")
          .find(({ params }) => params.uri === uri && params.version === 3),
      "cleared diagnostics",
    );
    expect(cleared.params.diagnostics.some(({ message }) => message.includes("missing_name"))).toBe(
      false,
    );
  });

  it("returns call and type hierarchies", async () => {
    const items = await requestAt("textDocument/prepareCallHierarchy", "add", 1);
    const incoming = await client.request("callHierarchy/incomingCalls", { item: items[0] });
    expect(incoming.some(({ from }) => from.name === "main")).toBe(true);
    text = "struct Base {};\nstruct Child : Base {};\n";
    client.change(uri, text);
    const types = await requestAt("textDocument/prepareTypeHierarchy", "Child");
    expect(types[0].name).toBe("Child");
    const parents = await client.request("typeHierarchy/supertypes", { item: types[0] });
    expect(parents.some(({ name }) => name === "Base")).toBe(true);
  });

  it("offers a working quick fix for a missing semicolon", async () => {
    text = "int main() { return 0 }\n";
    client.change(uri, text, 2);
    const message = await client.waitFor(
      () =>
        client
          .messages("textDocument/publishDiagnostics")
          .find(
            ({ params }) =>
              params.uri === uri &&
              params.version === 2 &&
              params.diagnostics.some(({ message }) => /expected.*;/i.test(message)),
          ),
      "semicolon diagnostic",
    );
    const diagnostic = message.params.diagnostics.find(({ message }) =>
      /expected.*;/i.test(message),
    );
    const actions = await client.request("textDocument/codeAction", {
      textDocument: { uri },
      range: diagnostic.range,
      context: { diagnostics: [diagnostic] },
    });
    const fix = actions.find(({ edit }) => edit);
    expect(fix).toBeDefined();
    const edits =
      fix.edit.changes?.[uri] ||
      fix.edit.documentChanges?.flatMap(({ edits: items }) => items) ||
      [];
    expect(applyEdits(text, edits)).toContain("return 0;");
  });
});
