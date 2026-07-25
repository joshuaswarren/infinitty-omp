import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import extension, {
  encodeCommand,
  extractPhases,
  resolveTarget,
  sendCommand,
  toInfinittyTodos,
  type ExtensionAPI,
  type ToolResultEvent,
} from "../index.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempSocket(): string {
  const dir = mkdtempSync(join(tmpdir(), "infinitty-omp-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "app.sock");
}

interface FakeInfinitty {
  server: Server;
  /** Resolves with the next command the terminal receives. */
  next(): Promise<string>;
}

/**
 * Stands in for infinitty's control socket: one newline-terminated command
 * per connection, `ok` back, connection closed.
 */
async function fakeInfinitty(socketPath: string): Promise<FakeInfinitty> {
  const delivered: string[] = [];
  const waiters: Array<(command: string) => void> = [];

  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const command = buffer.slice(0, newline);
      const waiter = waiters.shift();
      if (waiter) waiter(command);
      else delivered.push(command);
      socket.end("ok\n");
    });
  });

  const listening = Promise.withResolvers<void>();
  server.listen(socketPath, () => listening.resolve());
  await listening.promise;
  cleanups.push(() => server.close());

  return {
    server,
    next() {
      const queued = delivered.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      const { promise, resolve } = Promise.withResolvers<string>();
      waiters.push(resolve);
      return promise;
    },
  };
}

function withEnv(key: string, value: string): void {
  const previous = process.env[key];
  process.env[key] = value;
  cleanups.push(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

describe("resolveTarget", () => {
  test("pane socket when no pane id is exported", () => {
    expect(resolveTarget({ INFINITTY_SOCKET: "/tmp/pane.sock" })).toEqual({
      socketPath: "/tmp/pane.sock",
    });
  });

  test("app socket addressing once a pane id exists", () => {
    expect(
      resolveTarget({
        INFINITTY_APP_SOCKET: "/tmp/app.sock",
        INFINITTY_PANE_ID: "7",
      }),
    ).toEqual({ socketPath: "/tmp/app.sock", paneId: "7" });
  });

  test("override wins, and carries a pane id when one is set", () => {
    expect(
      resolveTarget({
        INFINITTY_SOCKET: "/tmp/pane.sock",
        INFINITTY_OMP_SOCKET: "/tmp/forwarded.sock",
      }),
    ).toEqual({ socketPath: "/tmp/forwarded.sock" });

    expect(
      resolveTarget({
        INFINITTY_OMP_SOCKET: "/tmp/forwarded.sock",
        INFINITTY_OMP_PANE_ID: "3",
      }),
    ).toEqual({ socketPath: "/tmp/forwarded.sock", paneId: "3" });
  });

  test("inert with no socket, and with a pane id but no app socket", () => {
    expect(resolveTarget({})).toBeUndefined();
    expect(resolveTarget({ INFINITTY_PANE_ID: "7" })).toBeUndefined();
  });
});

describe("toInfinittyTodos", () => {
  test("single phase stays unprefixed", () => {
    expect(
      toInfinittyTodos([
        {
          name: "Build",
          tasks: [
            { content: "write it", status: "completed" },
            { content: "test it", status: "in_progress" },
          ],
        },
      ]),
    ).toEqual([
      { content: "write it", status: "completed" },
      { content: "test it", status: "in_progress" },
    ]);
  });

  test("multiple phases prefix each task with its phase", () => {
    expect(
      toInfinittyTodos([
        { name: "Build", tasks: [{ content: "write it", status: "completed" }] },
        { name: "Ship", tasks: [{ content: "push it", status: "pending" }] },
      ]),
    ).toEqual([
      { content: "Build: write it", status: "completed" },
      { content: "Ship: push it", status: "pending" },
    ]);
  });

  test("abandoned tasks are dropped, and a fully abandoned phase stops counting", () => {
    expect(
      toInfinittyTodos([
        {
          name: "Build",
          tasks: [
            { content: "keep", status: "pending" },
            { content: "drop", status: "abandoned" },
          ],
        },
        { name: "Dead", tasks: [{ content: "gone", status: "abandoned" }] },
      ]),
    ).toEqual([{ content: "keep", status: "pending" }]);
  });
});

describe("extractPhases", () => {
  test("accepts a well-formed todo tool result", () => {
    const phases = [
      { name: "Build", tasks: [{ content: "a", status: "pending" as const }] },
    ];
    expect(extractPhases({ phases, storage: "session" })).toEqual(phases);
  });

  test("rejects malformed shapes instead of publishing them", () => {
    expect(extractPhases(undefined)).toBeUndefined();
    expect(extractPhases({})).toBeUndefined();
    expect(extractPhases({ phases: "nope" })).toBeUndefined();
    expect(extractPhases({ phases: [{ name: "x" }] })).toBeUndefined();
    expect(
      extractPhases({
        phases: [{ name: "x", tasks: [{ content: "a", status: "??" }] }],
      }),
    ).toBeUndefined();
  });
});

describe("encodeCommand", () => {
  test("pane form omits the id; app form includes it", () => {
    const todos = [{ content: "a", status: "pending" as const }];
    expect(encodeCommand(todos)).toBe('todos [{"content":"a","status":"pending"}]\n');
    expect(encodeCommand(todos, "7")).toBe(
      'todos 7 [{"content":"a","status":"pending"}]\n',
    );
  });
});

describe("sendCommand", () => {
  test("delivers the command and returns the reply", async () => {
    const path = tempSocket();
    const terminal = await fakeInfinitty(path);

    const [reply, received] = await Promise.all([
      sendCommand(path, "todos []\n"),
      terminal.next(),
    ]);

    expect(received).toBe("todos []");
    expect(reply).toBe("ok");
  });

  test("resolves undefined instead of throwing when nothing is listening", async () => {
    expect(await sendCommand(tempSocket(), "todos []\n")).toBeUndefined();
  });
});

describe("extension", () => {
  test("publishes on a todo result, skips repeats, and clears on shutdown", async () => {
    const path = tempSocket();
    const terminal = await fakeInfinitty(path);
    withEnv("INFINITTY_OMP_SOCKET", path);

    const handlers: Record<string, (event: ToolResultEvent) => void> = {};
    const pi: ExtensionAPI = {
      on: (event, handler) => {
        handlers[event] = handler;
      },
    };
    extension(pi);

    const todoResult = (status: string): ToolResultEvent => ({
      toolName: "todo",
      isError: false,
      details: { phases: [{ name: "Build", tasks: [{ content: "a", status }] }] },
    });

    handlers.tool_result?.(todoResult("in_progress"));
    expect(await terminal.next()).toBe('todos [{"content":"a","status":"in_progress"}]');

    // Three writes that must never reach the wire:
    handlers.tool_result?.(todoResult("in_progress")); // byte-identical repeat
    handlers.tool_result?.({
      toolName: "todo",
      isError: true,
      details: { phases: [] },
    }); // failed todo call
    handlers.tool_result?.({ toolName: "bash", details: { phases: [] } }); // other tool

    // The next command observed proves the three above were suppressed: had any
    // been sent, it would arrive here instead.
    handlers.tool_result?.(todoResult("completed"));
    expect(await terminal.next()).toBe('todos [{"content":"a","status":"completed"}]');

    handlers.session_shutdown?.({ toolName: "", details: undefined });
    expect(await terminal.next()).toBe("todos []");
  });
});
