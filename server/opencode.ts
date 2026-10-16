import { createHash, randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { LoginMethod, UsageWindow } from "../shared/model";
import {
  ProgressEmitter,
  spawnEnv,
  type EnvPatch,
  type FamilyAdapter,
  type Identity,
  type LimitHit,
  type LoginHandle,
  type RedeemReply,
  type TurnEvent,
  type UsageRead,
} from "./adapter";
import { providerCommand } from "./binaries";
import {
  prepareOpenCodeHome,
  readOpenCodeKey,
  readPiAuthKey,
  removeOpenCodeKey,
  writeOpenCodeKey,
  writePiAuthKey,
} from "./homes";
import { detectOpenCodeLimit, detectOpenCodeSignOut } from "./limits";
import { mainPiAgentDir } from "./paths";
import { run, stripAnsi } from "./process";
import { parseGoUsage, retryDelayMs } from "./usage";

/** The usage endpoint: rolling, weekly and monthly percents for one key. */
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
/** The integration both CLIs file OpenCode Go credentials under. */
const INTEGRATION = "opencode-go";
/** The label the opencode CLI gives that integration, the handle for signing one out. */
const INTEGRATION_LABEL = "OpenCode Go";
/** How long one usage answer serves both the identity check and the reading after it. */
const PROBE_TTL_MS = 60_000;
/** How long the opencode CLI's exported key is trusted before its store is read again. */
const CLI_KEY_TTL_MS = 10 * 60_000;
/** How often to note that the machine's two CLIs are signed in with different keys. */
const MISMATCH_WARN_MS = 30 * 60_000;
const USAGE_TIMEOUT_MS = 15_000;

interface Probe {
  at: number;
  key: string;
  /** HTTP status, or null when no answer arrived. */
  status: number | null;
  windows: UsageWindow[];
  /** When the provider asked us to slow down. */
  retryAt: number | null;
  /** Why the reading failed, in words fit for an account card. */
  error: string | null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function signedOut(): Identity {
  return { signedIn: false, email: null, plan: null, organization: null, identity: null };
}

/** A stable name for an account's key that never carries the key itself. */
export function keyFingerprint(key: string): string {
  return `key|${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/** The OpenCode Go key in an `opencode auth export` document, whatever else is in the store. */
export function pickExportedKey(stdout: string): string | null {
  const text = stripAnsi(stdout);
  const start = text.indexOf("[");
  try {
    const parsed = JSON.parse(start >= 0 ? text.slice(start) : text) as unknown;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as { integrationID?: unknown; active?: unknown; value?: unknown };
      if (record.integrationID !== INTEGRATION || record.active === false) continue;
      const value = record.value as { key?: unknown } | undefined;
      const key = typeof value?.key === "string" ? value.key.trim() : "";
      if (key) return key;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Waiting for a pasted key. A key the endpoint turns down leaves the flow open with the reason on
 * screen, so a bad paste can be fixed without starting over.
 */
class OpenCodeKeyLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private settle!: (result: { ok: boolean; message: string | null }) => void;
  private done = false;

  constructor(private readonly adopt: (key: string) => Promise<void>) {
    super();
    this.finished = new Promise((resolve) => {
      this.settle = (result) => {
        if (this.done) return;
        this.done = true;
        resolve(result);
      };
    });
    this.update({ step: "waiting", message: "Paste the API key from your OpenCode Go plan." });
  }

  async submitCode(code: string): Promise<void> {
    const key = code.trim();
    if (!key) throw new Error("Paste the API key from your OpenCode Go plan.");
    this.update({ message: "Checking the key…" });
    try {
      await this.adopt(key);
    } catch (error) {
      this.update({ message: describe(error) });
      throw error;
    }
    this.settle({ ok: true, message: null });
  }

  cancel(): void {
    this.settle({ ok: false, message: "Sign-in was canceled." });
  }
}

/**
 * OpenCode Go, however the machine reaches it: pi (the OpenAI-compatible CLI lots of Go setups
 * run on) or the opencode CLI. Both are covered by the same account, and both understand the same
 * key, so sign-in is one pasted key and the account's homes make it private.
 */
export class OpenCodeAdapter implements FamilyAdapter {
  readonly family = "opencode" as const;
  /** A conversation lives in the store that opened it, so an agent can't move between accounts in place. */
  readonly portable = false;
  /** One cheap GET per key; the client polls usage while the accounts screen is open. */
  readonly usageSpacingMs = 30_000;
  private probe: Probe | null = null;
  private cliKey: { at: number; value: string | null } | null = null;
  private lastMismatchWarn = 0;

  /** Either CLI runs OpenCode Go models everywhere, so one of them is enough. */
  async available(): Promise<{ ok: boolean; detail: string | null }> {
    const [pi, opencode] = await Promise.all([providerCommand("pi"), providerCommand("opencode")]);
    const versions = await Promise.all([
      run(pi.command, [...pi.prefix, "--version"], { timeoutMs: 30_000 }),
      run(opencode.command, [...opencode.prefix, "--version"], { timeoutMs: 30_000 }),
    ]);
    if (versions.some((result) => result.code === 0)) return { ok: true, detail: null };
    return { ok: false, detail: `neither \`${pi.command}\` nor \`${opencode.command}\` was found` };
  }

  prepareHome(home: string): Promise<void> {
    return prepareOpenCodeHome(home);
  }

  async env(home: string | null): Promise<EnvPatch> {
    if (!home) return { OPENCODE_API_KEY: null, PI_CODING_AGENT_DIR: null, XDG_DATA_HOME: null };
    const key = await readOpenCodeKey(home).catch(() => null);
    return {
      // The account's own pi directory holds its login; the opencode CLI gets a data directory of
      // its own and reads the key from the environment. The empty string keeps an account that is
      // signed out from reaching for a key that isn't its own.
      PI_CODING_AGENT_DIR: join(home, "pi"),
      XDG_DATA_HOME: join(home, "oc-data"),
      OPENCODE_API_KEY: key ?? "",
    };
  }

  async identity(home: string | null): Promise<Identity> {
    const key = await this.accountKey(home);
    if (!key) return signedOut();
    const probe = await this.probeKey(key);
    // Only the provider turning the key down signs an account out; a network hiccup doesn't.
    if (probe.status === 401 || probe.status === 403) return signedOut();
    return { signedIn: true, email: null, plan: null, organization: null, identity: keyFingerprint(key) };
  }

  async usage(home: string | null): Promise<UsageRead> {
    const fetchedAt = new Date().toISOString();
    const key = await this.accountKey(home);
    if (!key) {
      return {
        fetchedAt,
        windows: [],
        error: home ? "This account's key is gone. Sign it in again." : "No pi or opencode sign-in was found on this machine.",
        cached: false,
        resets: null,
      };
    }
    const probe = await this.probeKey(key);
    return {
      fetchedAt,
      windows: probe.windows,
      error: probe.error,
      cached: false,
      resets: null,
      ...(probe.retryAt ? { retryAt: probe.retryAt } : {}),
    };
  }

  async redeemReset(): Promise<RedeemReply> {
    return { outcome: "none", message: "OpenCode Go subscriptions don't come with banked resets.", left: null };
  }

  async login(home: string | null, method: LoginMethod): Promise<LoginHandle> {
    if (method !== "key") throw new Error("OpenCode Go accounts are added by pasting an API key.");
    return new OpenCodeKeyLogin((key) => this.adoptKey(home, key));
  }

  async logout(home: string): Promise<void> {
    this.probe = null;
    await removeOpenCodeKey(home).catch(() => undefined);
    // Rewrites pi's auth file from the account's key — gone now, so the login goes with it.
    await prepareOpenCodeHome(home, true).catch(() => undefined);
    await this.clearCliLogin(spawnEnv({ XDG_DATA_HOME: join(home, "oc-data") })).catch(() => undefined);
  }

  detectLimit(event: TurnEvent): LimitHit | null {
    return detectOpenCodeLimit(event);
  }

  detectSignOut(event: TurnEvent): string | null {
    return detectOpenCodeSignOut(event);
  }

  // ------------------------------------------------------------------ keys

  /** The account's key: its own file, or the machine's own login for the main account. */
  private async accountKey(home: string | null): Promise<string | null> {
    return home ? readOpenCodeKey(home) : this.mainKey();
  }

  /**
   * The machine's own OpenCode Go login. pi comes first: its auth file is the login pi sessions
   * will use, so usage and routing agree on the main account. The opencode CLI's store is the
   * fallback for machines that never ran pi.
   */
  private async mainKey(): Promise<string | null> {
    const fromPi = await readPiAuthKey(mainPiAgentDir()).catch(() => null);
    const fromCli = await this.openCodeCliKey();
    if (fromPi && fromCli && fromPi !== fromCli && Date.now() - this.lastMismatchWarn > MISMATCH_WARN_MS) {
      this.lastMismatchWarn = Date.now();
      console.warn("[ZeroSub] pi and the opencode CLI are signed in with different OpenCode Go keys; the main account follows pi's.");
    }
    return fromPi ?? fromCli;
  }

  private async openCodeCliKey(fresh = false): Promise<string | null> {
    if (!fresh && this.cliKey && Date.now() - this.cliKey.at < CLI_KEY_TTL_MS) return this.cliKey.value;
    const value = await (async () => {
      const { command, prefix } = await providerCommand("opencode");
      const result = await run(command, [...prefix, "auth", "export", "--standalone"], { timeoutMs: 30_000 });
      return result.code === 0 ? pickExportedKey(result.stdout) : null;
    })().catch(() => null);
    this.cliKey = { at: Date.now(), value };
    return value;
  }

  // ------------------------------------------------------------------ usage

  /** One usage read per key per minute, so the identity check and the refresh after it share a request. */
  private async probeKey(key: string, fresh = false): Promise<Probe> {
    if (!fresh && this.probe?.key === key && Date.now() - this.probe.at < PROBE_TTL_MS) return this.probe;
    let probe: Probe;
    try {
      const response = await fetch(USAGE_URL, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
      });
      const at = Date.now();
      const status = response.status;
      if (response.ok) {
        probe = { at, key, status, windows: parseGoUsage(await response.json().catch(() => null)), retryAt: null, error: null };
      } else if (status === 429) {
        probe = { at, key, status, windows: [], retryAt: at + retryDelayMs(response.headers.get("retry-after"), at), error: null };
      } else if (status === 401) {
        probe = { at, key, status, windows: [], retryAt: null, error: "OpenCode rejected this account's key. Sign it in again." };
      } else if (status === 403) {
        probe = { at, key, status, windows: [], retryAt: null, error: "This key has no OpenCode Go subscription." };
      } else {
        probe = { at, key, status, windows: [], retryAt: null, error: `The usage request failed (HTTP ${status}).` };
      }
    } catch (error) {
      probe = { at: Date.now(), key, status: null, windows: [], retryAt: null, error: describe(error) };
    }
    this.probe = probe;
    return probe;
  }

  // ------------------------------------------------------------------ sign-in

  /** Validates one pasted key and stores it on the account (or the machine's own login). */
  private async adoptKey(home: string | null, raw: string): Promise<void> {
    const key = raw.trim();
    const probe = await this.probeKey(key, true);
    if (probe.status === 401) throw new Error("OpenCode rejected that key. Copy the whole key and paste it again.");
    if (probe.status === 403) throw new Error("That key has no OpenCode Go subscription.");
    if (probe.retryAt) throw new Error("OpenCode is rate-limiting key checks. Wait a minute and try again.");
    if (probe.error || probe.status === null) throw new Error(`Couldn't check the key with OpenCode (${probe.error ?? "no answer"}). Try again.`);
    if (!home) {
      await this.adoptMainKey(key);
      return;
    }
    await writeOpenCodeKey(home, key);
    await prepareOpenCodeHome(home, true);
  }

  /**
   * Signs the machine's own login in again, keeping every store that was signed in signed in: pi's
   * auth file when pi has one, the opencode CLI's store when it holds a credential. A machine with
   * neither gets whichever CLI it has actually used.
   */
  private async adoptMainKey(key: string): Promise<void> {
    const piDir = mainPiAgentDir();
    const piAuth = await stat(join(piDir, "auth.json")).catch(() => null);
    const cliKey = await this.openCodeCliKey(true);
    if (piAuth) await writePiAuthKey(piDir, key);
    if (cliKey && cliKey !== key) await this.storeCliKey(key);
    if (!piAuth && !cliKey) {
      if (await stat(piDir).catch(() => null)) await writePiAuthKey(piDir, key);
      else await this.storeCliKey(key);
    }
    this.cliKey = null;
  }

  /** Replaces the opencode CLI's own OpenCode Go credential with the given key. */
  private async storeCliKey(key: string): Promise<void> {
    const { command, prefix } = await providerCommand("opencode");
    await this.clearCliLogin();
    const document = JSON.stringify([
      {
        id: `cred_zerosub_${randomBytes(6).toString("hex")}`,
        integrationID: INTEGRATION,
        label: INTEGRATION_LABEL,
        active: true,
        value: { type: "key", key },
      },
    ]);
    const result = await run(command, [...prefix, "auth", "import", "--standalone"], { input: document, timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error("The opencode CLI wouldn't store the key. Sign in from the CLI, or use pi.");
  }

  /** Best-effort sign-out of the opencode CLI's OpenCode Go credential, wherever `env` points it. */
  private async clearCliLogin(env?: NodeJS.ProcessEnv): Promise<void> {
    const { command, prefix } = await providerCommand("opencode");
    await run(command, [...prefix, "auth", "logout", "--standalone", INTEGRATION, INTEGRATION_LABEL], { env, timeoutMs: 30_000 }).catch(
      () => undefined,
    );
  }
}
