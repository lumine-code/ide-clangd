const { LiveLspClient } = require("./helpers/live-lsp-client");

const fakeConnection = () => {
  const handlers = new Map();
  const connection = {
    onNotification(method, handler) {
      handlers.set(method, handler);
      return { dispose: () => handlers.delete(method) };
    },
    sendNotification: jasmine.createSpy("sendNotification").and.resolveTo(),
    sendRequest: jasmine.createSpy("sendRequest").and.returnValue(new Promise(() => {})),
  };
  return {
    connection,
    handlers,
    emit(method, params) {
      handlers.get(method)?.(params);
    },
  };
};

describe("clangd initial document readiness", () => {
  const uri = "file:///fixture/main.cpp";
  const method = "textDocument/clangd.fileStatus";
  let client, fake;
  beforeEach(() => {
    fake = fakeConnection();
    client = new LiveLspClient({ displayName: "clangd" }, "/fixture");
    client.connection = fake.connection;
    client.startupDeadline = Date.now() + 30000;
  });
  afterEach(() => jasmine.useRealClock());

  it("requires this document's idle notification after didOpen", async () => {
    client.notifications.push({ method, params: { uri, state: "idle" } });
    let ready = false;
    const pending = client.open(uri, "cpp", "int main() {}").then(() => (ready = true));
    fake.emit("textDocument/publishDiagnostics", { uri, diagnostics: [] });
    fake.emit(method, { uri: "file:///fixture/other.cpp", state: "idle" });
    fake.emit(method, { uri, state: "parsing main file" });
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(fake.connection.sendNotification.calls.count()).toBe(1);
    expect(fake.connection.sendNotification.calls.mostRecent().args[0]).toBe(
      "textDocument/didOpen",
    );
    fake.emit(method, { uri, state: "idle" });
    await pending;
    expect(ready).toBe(true);
    expect(fake.handlers.size).toBe(0);
  });

  it("subscribes before sending didOpen so an immediate acknowledgement is retained", async () => {
    fake.connection.sendNotification.and.callFake(() => {
      expect(fake.handlers.has(method)).toBe(true);
      fake.emit(method, { uri, state: "idle" });
      return Promise.resolve();
    });
    await client.open(uri, "cpp", "int main() {}");
    expect(fake.handlers.size).toBe(0);
  });

  it("does not reuse readiness from a previous connection generation", async () => {
    const previous = client.open(uri, "cpp", "int main() {}");
    const rejected = expectAsync(previous).toBeRejectedWithError(/connection changed/);
    const next = fakeConnection();
    client.connection = next.connection;
    let ready = false;
    const pending = client.open(uri, "cpp", "int main() {}").then(() => (ready = true));
    fake.emit(method, { uri, state: "idle" });
    await rejected;
    expect(ready).toBe(false);
    next.emit(method, { uri, state: "idle" });
    await pending;
    expect(ready).toBe(true);
  });

  it("uses only the remaining startup budget and keeps ordinary requests at 10 seconds", async () => {
    client.startupDeadline = Date.now() + 1000;
    const startup = expectAsync(client.open(uri, "cpp", "int main() {}")).toBeRejectedWithError(
      /timed out after 1000ms/,
    );
    advanceClock(1000);
    await startup;
    expect(fake.handlers.size).toBe(0);
    let failed = false;
    const request = client.request("textDocument/definition", {}).catch((error) => {
      failed = true;
      expect(error.message).toContain("timed out after 10000ms");
    });
    advanceClock(9999);
    await Promise.resolve();
    expect(failed).toBe(false);
    advanceClock(1);
    await request;
    expect(failed).toBe(true);
    expect(fake.connection.sendRequest.calls.count()).toBe(1);
  });
});
