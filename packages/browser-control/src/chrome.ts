/* Owning the Chromium process behind the Browser Control route: finding the
 * binary, starting it with a private profile, and learning which debugging
 * port it picked. Chrome only prints the port after it is ready, so the wait
 * is a poll of the profile's DevToolsActivePort file, and an early exit has to
 * be reported as a death rather than as a timeout.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { CdpConnection } from "./cdp.js";

const DEVTOOLS_PORT_FILE = "DevToolsActivePort";
const DEFAULT_DEADLINE_MS = 15_000;
const DEFAULT_WINDOW_SIZE = { width: 1280, height: 800 } as const;
const STDERR_LOG_NAME = "browser.err.log";
const STDERR_LOG_LIMIT_BYTES = 1024 * 1024;
const STDERR_EXCERPT_CHARS = 240;
const GRACEFUL_EXIT_WAIT_MS = 400;
const TERMINATE_WAIT_MS = 2000;
const KILL_WAIT_MS = 1000;

const MAC_BINARIES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

const PATH_BINARIES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "chrome",
];

/** A runnable Chrome plus any flags its install ships with. */
export interface ChromeBinary {
  readonly path: string;
  readonly args: readonly string[];
}

/** What a Chromium process looked like when it stopped. */
export interface ChromeDeath {
  readonly code: number | null;
  readonly signal: string | null;
  /** Milliseconds between spawn and exit. */
  readonly ms: number;
  /** Whitespace-collapsed tail of the stderr this run appended, at most 240. */
  readonly stderr: string;
}

/** Where a launched Chrome listens once it is ready. */
export interface DevToolsPort {
  readonly port: number;
  readonly path: string;
}

export interface WaitForDevToolsPortOptions {
  readonly deadlineMs?: number;
  readonly isDead?: () => ChromeDeath | null;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface LaunchChromeOptions {
  readonly headless: boolean;
  readonly profile: string;
  readonly extraFlags?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly binaryPath?: string;
}

export interface CloseChromeOptions {
  readonly timeoutMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function trimExcerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(-STDERR_EXCERPT_CHARS).trim();
}

/** Resolves the Chrome to run: explicit override, macOS app, then `PATH`. */
export function chromeBinary(
  env: NodeJS.ProcessEnv = process.env,
): ChromeBinary {
  const override = env.OXRAIL_CHROME?.trim();
  if (override !== undefined && override.length > 0) {
    if (!existsSync(override)) {
      throw new Error(
        `oxrail-browser: OXRAIL_CHROME points at ${override}, which does not exist`,
      );
    }
    return { path: override, args: [] };
  }
  for (const candidate of MAC_BINARIES) {
    if (existsSync(candidate)) return { path: candidate, args: [] };
  }
  const searchPath = env.PATH ?? "";
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory.length === 0) continue;
    for (const name of PATH_BINARIES) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return { path: candidate, args: [] };
    }
  }
  throw new Error(
    "oxrail-browser: no Chrome or Chromium found; install one or set OXRAIL_CHROME",
  );
}

/**
 * Flags for a Chrome that this route owns.
 *
 * A dedicated `--user-data-dir` keeps the human's own browser untouched, and
 * `--remote-debugging-port=0` makes the OS pick a port so two routes never
 * fight over one. Automation-controlled and the crash bubbles are turned off
 * because they add prompts the route cannot answer.
 */
export function chromeArgs(options: {
  userDataDir: string;
  headless: boolean;
  extraFlags?: readonly string[];
  windowSize?: { readonly width: number; readonly height: number };
}): string[] {
  const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
  const args: string[] = [];
  if (options.headless) args.push("--headless=new");
  args.push(
    `--user-data-dir=${options.userDataDir}`,
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--use-mock-keychain",
    "--disable-blink-features=AutomationControlled",
    "--disable-sync",
    "--disable-popup-blocking",
    "--hide-crash-restore-bubble",
    "--disable-session-crashed-bubble",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    `--window-size=${windowSize.width},${windowSize.height}`,
  );
  if (options.extraFlags !== undefined) args.push(...options.extraFlags);
  return args;
}

/** Root for profiles and logs; overridable so tests and CI stay off `$HOME`. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OXRAIL_BROWSER_STATE_DIR?.trim();
  if (override !== undefined && override.length > 0)
    return path.resolve(override);
  return path.join(homedir(), ".oxrail", "browser-control");
}

/** Keeps a profile name from reaching outside the profiles root. */
function profileName(profile: string): string {
  const cleaned = profile
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "default";
}

export function profileDir(
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = path.join(stateDir(env), "profiles");
  const directory = path.join(root, profileName(profile));
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `oxrail-browser: profile ${profile} escapes the profile root`,
    );
  }
  return directory;
}

/**
 * Removes a `DevToolsActivePort` left behind by an earlier run of the same
 * profile. Chrome rewrites the file once it is ready, but until then a stale
 * file still names a port nothing listens on, and a route that trusted it
 * failed with `ws: connect ECONNREFUSED` instead of waiting for the new one.
 * Deleting it before the spawn makes the wait below mean "this process".
 */
export function clearStaleDevToolsPort(userDataDir: string): void {
  rmSync(path.join(userDataDir, DEVTOOLS_PORT_FILE), { force: true });
}

function readDevToolsPort(userDataDir: string): DevToolsPort | null {
  let text: string;
  try {
    text = readFileSync(path.join(userDataDir, DEVTOOLS_PORT_FILE), "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const port = Number.parseInt(lines[0]?.trim() ?? "", 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  const wsPath = lines[1]?.trim() ?? "";
  return { port, path: wsPath.length > 0 ? wsPath : "/devtools/browser" };
}

/** Poll cadence: tight while Chrome warms up, then cheap once it drags on. */
function pollDelayMs(attempt: number): number {
  if (attempt < 10) return 5;
  if (attempt < 25) return 40;
  return 100;
}

/** The message a route shows when Chrome died before it could be driven. */
export function deathMessage(death: ChromeDeath): string {
  const how =
    death.signal !== null
      ? `signal ${death.signal}`
      : `exit code ${death.code ?? "unknown"}`;
  const stderr = trimExcerpt(death.stderr);
  const detail = stderr.length > 0 ? ` — ${stderr}` : "";
  return `oxrail-browser: Chrome ended before it opened a debugging port (${how} after ${death.ms} ms${detail})`;
}

/**
 * Waits for `<profile>/DevToolsActivePort` and reports a death as soon as one
 * is known, so the caller never sits through the full deadline for a process
 * that already ended. Time is accumulated from the sleeps rather than read off
 * the clock, which keeps an injected sleep deterministic.
 */
export async function waitForDevToolsPort(
  userDataDir: string,
  options: WaitForDevToolsPortOptions = {},
): Promise<DevToolsPort> {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const isDead = options.isDead ?? (() => null);
  const sleep = options.sleep ?? defaultSleep;
  let elapsed = 0;
  let attempt = 0;
  for (;;) {
    const death = isDead();
    if (death !== null) throw new Error(deathMessage(death));
    const found = readDevToolsPort(userDataDir);
    if (found !== null) return found;
    if (elapsed >= deadlineMs) {
      throw new Error("oxrail-browser: Chrome did not open a debugging port");
    }
    const delay = Math.min(
      pollDelayMs(attempt),
      Math.max(deadlineMs - elapsed, 1),
    );
    await sleep(delay);
    elapsed += delay;
    attempt += 1;
  }
}

function stderrOffset(logPath: string): number {
  try {
    const size = statSync(logPath).size;
    if (size > STDERR_LOG_LIMIT_BYTES) {
      truncateSync(logPath, 0);
      return 0;
    }
    return size;
  } catch {
    return 0;
  }
}

/**
 * A Chrome process this route started. It owns exactly one child, and `close`
 * is the only way to release it: protocol close first, then signals, so a
 * hung renderer cannot keep the child alive.
 */
export class ChromeProcess {
  readonly pid: number | null;
  readonly profile: string;
  readonly headless: boolean;

  #child: ChildProcess | null;
  readonly #startedAt: number;
  readonly #stderrLogPath: string;
  readonly #stderrOffset: number;
  #wsUrl: string | null = null;
  #death: ChromeDeath | null = null;
  #exited = false;
  #exitWaiters: Array<() => void> = [];

  private constructor(
    child: ChildProcess,
    profile: string,
    headless: boolean,
    stderrLogPath: string,
    stderrOffsetBytes: number,
  ) {
    this.#child = child;
    this.pid = child.pid ?? null;
    this.profile = profile;
    this.headless = headless;
    this.#startedAt = Date.now();
    this.#stderrLogPath = stderrLogPath;
    this.#stderrOffset = stderrOffsetBytes;
    child.once("exit", (code, signal) => {
      this.#recordDeath(code, signal);
    });
    child.once("error", () => {
      this.#recordDeath(null, null);
    });
  }

  static async launch(options: LaunchChromeOptions): Promise<ChromeProcess> {
    const env = options.env ?? process.env;
    const binary =
      options.binaryPath === undefined
        ? chromeBinary(env)
        : { path: options.binaryPath, args: [] as string[] };
    if (!existsSync(binary.path)) {
      throw new Error(
        `oxrail-browser: Chrome binary not found at ${binary.path}`,
      );
    }
    const userDataDir = profileDir(options.profile, env);
    mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
    clearStaleDevToolsPort(userDataDir);
    const logs = stateDir(env);
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    const logPath = path.join(logs, STDERR_LOG_NAME);
    const offset = stderrOffset(logPath);
    const args = chromeArgs(
      options.extraFlags === undefined
        ? { userDataDir, headless: options.headless }
        : {
            userDataDir,
            headless: options.headless,
            extraFlags: options.extraFlags,
          },
    );

    const logFd = openSync(logPath, "a", 0o600);
    let child: ChildProcess;
    try {
      child = spawn(binary.path, args, {
        stdio: ["ignore", logFd, logFd],
        env,
      });
    } finally {
      closeSync(logFd);
    }

    const chrome = new ChromeProcess(
      child,
      options.profile,
      options.headless,
      logPath,
      offset,
    );
    try {
      const port = await waitForDevToolsPort(userDataDir, {
        isDead: () => chrome.lastDeath(),
      });
      chrome.#attachPort(port);
      return chrome;
    } catch (error) {
      await chrome.close();
      throw error;
    }
  }

  /** The browser-wide DevTools endpoint, known once the port file appeared. */
  get browserWsUrl(): string {
    if (this.#wsUrl === null) {
      throw new Error(
        "oxrail-browser: the debugging port was never discovered",
      );
    }
    return this.#wsUrl;
  }

  alive(): boolean {
    const child = this.#child;
    return (
      child !== null &&
      !this.#exited &&
      child.exitCode === null &&
      child.signalCode === null
    );
  }

  /** What the process reported when it ended, if it has ended. */
  lastDeath(): ChromeDeath | null {
    return this.#death;
  }

  /**
   * Releases the process. A protocol-level `Browser.close` lets Chrome flush
   * its profile; signals are only the fallback. This never throws and is safe
   * to call twice, because a leaked Chrome would outlive the route.
   */
  async close(options: CloseChromeOptions = {}): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    try {
      if (this.#wsUrl !== null && this.alive()) {
        await this.#requestBrowserClose();
      }
      if (await this.#waitForExit(GRACEFUL_EXIT_WAIT_MS)) return;
      this.#signal(child, "SIGTERM");
      if (await this.#waitForExit(options.timeoutMs ?? TERMINATE_WAIT_MS)) {
        return;
      }
      this.#signal(child, "SIGKILL");
      await this.#waitForExit(KILL_WAIT_MS);
    } catch {
      // Closing is best effort; the route must be able to drop the process even
      // when the browser misbehaves.
    } finally {
      this.#child = null;
    }
  }

  #attachPort(port: DevToolsPort): void {
    const wsPath = port.path.startsWith("/") ? port.path : "/devtools/browser";
    this.#wsUrl = `ws://127.0.0.1:${port.port}${wsPath}`;
  }

  async #requestBrowserClose(): Promise<void> {
    if (this.#wsUrl === null) return;
    let connection: CdpConnection | null = null;
    try {
      connection = await CdpConnection.connect(this.#wsUrl, {
        timeoutMs: 2000,
      });
      await connection.send("Browser.close");
    } catch {
      // Fall back to signals below.
    } finally {
      connection?.close();
    }
  }

  #signal(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      child.kill(signal);
    } catch {
      // ESRCH means it is already gone, which is what we wanted.
    }
  }

  async #waitForExit(ms: number): Promise<boolean> {
    if (!this.alive()) return true;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(exited);
      };
      const timer = setTimeout(() => {
        finish(false);
      }, ms);
      this.#exitWaiters.push(() => {
        finish(true);
      });
      // The exit may have landed between `alive` and the waiter registration.
      if (!this.alive()) finish(true);
    });
  }

  #recordDeath(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#death !== null) return;
    this.#death = {
      code,
      signal,
      ms: Date.now() - this.#startedAt,
      // Only this run's appended bytes, and only the tail the message shows, so
      // a chatty Chrome cannot hold a megabyte of log in memory per route.
      stderr: trimExcerpt(this.#readAppendedStderr()),
    };
    this.#exited = true;
    const waiters = this.#exitWaiters;
    this.#exitWaiters = [];
    for (const waiter of waiters) waiter();
  }

  #readAppendedStderr(): string {
    try {
      const contents = readFileSync(this.#stderrLogPath);
      if (this.#stderrOffset >= contents.length) return "";
      return contents.subarray(this.#stderrOffset).toString("utf8");
    } catch {
      return "";
    }
  }
}
