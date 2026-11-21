/* mcp-dual:ignore-file */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isJsonRpcMessage } from "./http.js";
import type { JsonRpcMessage } from "./types.js";

export interface StdioConnectionOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Called for every server-to-client notification. */
  onNotification?: (message: JsonRpcMessage) => void;
}

export class StdioProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StdioProcessError";
  }
}

export class StdioTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for a response to ${method}`);
    this.name = "StdioTimeoutError";
  }
}

interface Pending {
  method: string;
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A line-delimited JSON-RPC 2.0 connection to a stdio MCP server.
 * Used both by the live stdio probe and by the shim's stdio upstream.
 */
export class StdioConnection {
  readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private pending = new Map<string | number, Pending>();
  private stderrBuffer = "";
  private nextId = 1;
  private closed = false;
  private readonly options: StdioConnectionOptions;

  private constructor(child: ChildProcessWithoutNullStreams, options: StdioConnectionOptions) {
    this.child = child;
    this.options = options;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-8_000);
    });
    child.on("exit", (code, signal) => {
      this.closed = true;
      const reason = new StdioProcessError(
        `stdio server exited (code=${code ?? "null"}, signal=${signal ?? "null"})${this.stderrTail() ? `\n${this.stderrTail()}` : ""}`,
      );
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(reason);
      }
      this.pending.clear();
    });
    child.on("error", (error) => {
      this.closed = true;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new StdioProcessError(`failed to run stdio server: ${error.message}`));
      }
      this.pending.clear();
    });
  }

  static start(command: string, options: StdioConnectionOptions = {}): StdioConnection {
    const child = spawn(command, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { ...process.env, ...(options.env ?? {}) },
    });
    return new StdioConnection(child, options);
  }

  stderrTail(): string {
    return this.stderrBuffer.trim();
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      for (const message of messages) {
        if (!isJsonRpcMessage(message)) continue;
        if (message.id !== undefined && message.id !== null && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          pending.resolve(message);
        } else if (message.method && (message.id === undefined || message.id === null)) {
          this.options.onNotification?.(message);
        }
      }
    }
  }

  send(message: JsonRpcMessage, timeoutMs = 10_000): Promise<JsonRpcMessage> {
    if (this.closed) return Promise.reject(new StdioProcessError("stdio server is not running"));
    if (message.id === undefined) {
      this.write(message);
      return Promise.resolve(message);
    }
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id as string | number);
        reject(new StdioTimeoutError(message.method ?? "request", timeoutMs));
      }, timeoutMs);
      this.pending.set(message.id as string | number, { method: message.method ?? "request", resolve, reject, timer });
      this.write(message);
    });
  }

  request(method: string, params: Record<string, unknown> | undefined, timeoutMs = 10_000): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    return this.send(message, timeoutMs);
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return;
    const message: JsonRpcMessage = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    this.write(message);
  }

  private write(message: JsonRpcMessage): void {
    if (!this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(graceMs = 300): Promise<void> {
    if (this.closed) return;
    try {
      this.child.stdin.end();
    } catch {
      // already closed
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, graceMs);
      timer.unref();
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
