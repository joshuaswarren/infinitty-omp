import { createConnection } from "node:net";

/**
 * Publishes the omp session todo list to an infinitty pane, so the pane
 * header's checklist icon tracks the agent's plan.
 *
 * Wire format is infinitty's control socket: one newline-terminated command
 * per connection, response read until EOF.
 *
 *   pane socket  ->  todos <json>
 *   app socket   ->  todos <pane-id> <json>
 *
 * Inert unless a socket is resolvable, so it costs nothing outside infinitty.
 */

const TODO_STATUSES = ["pending", "in_progress", "completed", "abandoned"] as const;

type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export interface TodoPhase {
  name: string;
  tasks: TodoItem[];
}

export interface ToolResultEvent {
  toolName: string;
  isError?: boolean;
  details?: unknown;
}

/** The subset of omp's extension API this extension uses. */
export interface ExtensionAPI {
  on(
    event: "tool_result" | "session_shutdown",
    handler: (event: ToolResultEvent) => void,
  ): void;
}

interface Target {
  socketPath: string;
  paneId?: string;
}

const WRITE_TIMEOUT_MS = 700;

function debug(message: string): void {
  if (process.env.INFINITTY_OMP_DEBUG === "1") {
    process.stderr.write(`[infinitty-omp] ${message}\n`);
  }
}

/**
 * Pane id present => app socket, which addresses panes explicitly.
 * Pane id absent => pane socket, whose protocol is already id-less.
 *
 * `INFINITTY_OMP_SOCKET` overrides either, and is how a remote agent points
 * at an ssh-forwarded socket. `INFINITTY_PANE_ID` / `INFINITTY_APP_SOCKET`
 * are not exported into panes by infinitty today; they are read so this
 * keeps working unchanged once they are.
 */
export function resolveTarget(env: NodeJS.ProcessEnv): Target | undefined {
  const override = env.INFINITTY_OMP_SOCKET?.trim();
  const paneId = (env.INFINITTY_OMP_PANE_ID ?? env.INFINITTY_PANE_ID)?.trim();

  if (paneId) {
    const socketPath = override || env.INFINITTY_APP_SOCKET?.trim();
    return socketPath ? { socketPath, paneId } : undefined;
  }

  const socketPath = override || env.INFINITTY_SOCKET?.trim();
  return socketPath ? { socketPath } : undefined;
}

/**
 * Flatten omp's phase tree into infinitty's flat checklist.
 *
 * `abandoned` tasks are dropped rather than mapped: infinitty renders only
 * done / active / neither, so an abandoned task would sit as an unchecked
 * circle the list can never complete. omp itself strips them on resume.
 *
 * Phase names survive as a prefix only when there is more than one phase —
 * the popover is 300pt wide, so a single-phase list stays unprefixed.
 */
export function toInfinittyTodos(phases: TodoPhase[]): TodoItem[] {
  const live = phases.filter((phase) =>
    phase.tasks.some((task) => task.status !== "abandoned"),
  );
  const prefix = live.length > 1;

  return live.flatMap((phase) =>
    phase.tasks
      .filter((task) => task.status !== "abandoned")
      .map((task) => ({
        content: prefix ? `${phase.name}: ${task.content}` : task.content,
        status: task.status,
      })),
  );
}

export function encodeCommand(todos: TodoItem[], paneId?: string): string {
  const json = JSON.stringify(todos);
  return paneId ? `todos ${paneId} ${json}\n` : `todos ${json}\n`;
}

/**
 * Best-effort single-shot write. Never rejects and never outlives
 * WRITE_TIMEOUT_MS: a stalled or absent terminal must not stall the agent.
 */
export function sendCommand(
  socketPath: string,
  command: string,
): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  let settled = false;
  let response = "";

  const socket = createConnection(socketPath);
  socket.setEncoding("utf8");

  const finish = (result?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    resolve(result);
  };

  const timer = setTimeout(() => {
    debug(`timed out after ${WRITE_TIMEOUT_MS}ms`);
    finish(undefined);
  }, WRITE_TIMEOUT_MS);
  timer.unref?.();

  socket.on("connect", () => socket.write(command));
  socket.on("data", (chunk: string) => {
    response += chunk;
  });
  socket.on("end", () => finish(response.trim()));
  socket.on("close", () => finish(response.trim()));
  socket.on("error", (error: Error) => {
    debug(`socket error: ${error.message}`);
    finish(undefined);
  });

  return promise;
}

function isTodoItem(value: unknown): value is TodoItem {
  if (typeof value !== "object" || value === null) return false;
  if (!("content" in value) || typeof value.content !== "string") return false;
  if (!("status" in value) || typeof value.status !== "string") return false;
  return TODO_STATUSES.some((status) => status === value.status);
}

function isTodoPhase(value: unknown): value is TodoPhase {
  if (typeof value !== "object" || value === null) return false;
  if (!("name" in value) || typeof value.name !== "string") return false;
  if (!("tasks" in value) || !Array.isArray(value.tasks)) return false;
  return value.tasks.every(isTodoItem);
}

/** Validate rather than assert: malformed details are ignored, not published. */
export function extractPhases(details: unknown): TodoPhase[] | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  if (!("phases" in details)) return undefined;
  const { phases } = details;
  if (!Array.isArray(phases)) return undefined;
  return phases.every(isTodoPhase) ? phases : undefined;
}

export default function (pi: ExtensionAPI): void {
  const target = resolveTarget(process.env);
  if (!target) {
    debug("no infinitty socket in env; inert");
    return;
  }
  debug(
    `publishing to ${target.socketPath}` +
      (target.paneId ? ` pane ${target.paneId}` : " (pane socket)"),
  );

  // Serialize writes so a slow connection cannot reorder list versions, and
  // skip byte-identical repeats (a `view` op republishes unchanged state).
  let queue: Promise<unknown> = Promise.resolve();
  let lastCommand: string | undefined;

  const publish = (todos: TodoItem[]) => {
    const command = encodeCommand(todos, target.paneId);
    if (command === lastCommand) return;
    lastCommand = command;
    queue = queue
      .catch(() => undefined)
      .then(async () => {
        const response = await sendCommand(target.socketPath, command);
        if (response?.startsWith("error:")) {
          debug(`infinitty rejected: ${response}`);
        }
      });
  };

  pi.on("tool_result", (event) => {
    if (event.toolName !== "todo" || event.isError) return;
    const phases = extractPhases(event.details);
    if (!phases) return;
    publish(toInfinittyTodos(phases));
  });

  // Leave no stale checklist behind on a pane that outlives the session.
  pi.on("session_shutdown", () => publish([]));
}
