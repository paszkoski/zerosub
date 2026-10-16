import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mergeShared,
  prepareClaudeHome,
  prepareCodexHome,
  prepareOpenCodeHome,
  readOpenCodeKey,
  removeHome,
  removeOpenCodeKey,
  writeOpenCodeKey,
} from "./homes";

let root: string;
const saved = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  PASEO_HOME: process.env.PASEO_HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "zerosub-homes-")));
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

async function isLinkTo(path: string, target: string): Promise<boolean> {
  const entry = await lstat(path).catch(() => null);
  return Boolean(entry?.isSymbolicLink()) && (await readlink(path)) === target;
}

async function sync(home: string, main: string, config: Record<string, unknown>, bump = 0): Promise<void> {
  await writeFile(join(main, ".claude.json"), JSON.stringify(config));
  if (bump) {
    const at = new Date(Date.now() + bump);
    await utimes(join(main, ".claude.json"), at, at);
  }
  await prepareClaudeHome(home, true);
}

describe("prepareClaudeHome", () => {
  it("shares configuration and history but keeps credentials and identity per account", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-a");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(join(main, "skills"), { recursive: true });
    await mkdir(join(main, "backups"), { recursive: true });
    await writeFile(join(main, "settings.json"), "{}");
    await writeFile(join(main, ".credentials.json"), "{}");
    await writeFile(join(main, "settings.json.tmp.123.abc"), "");
    await sync(home, main, {
      oauthAccount: { emailAddress: "main@example.com" },
      userID: "device",
      cachedGrowthBookFeatures: {},
      mcpServers: { docs: { command: "docs-mcp" } },
      projects: { "/work": { allowedTools: ["Bash(ls)"] } },
      theme: "dark",
    });

    expect(await isLinkTo(join(home, "settings.json"), join(main, "settings.json"))).toBe(true);
    expect(await isLinkTo(join(home, "skills"), join(main, "skills"))).toBe(true);
    // Created in main up front so history is shared from the first session.
    expect(await isLinkTo(join(home, "projects"), join(main, "projects"))).toBe(true);
    expect(await isLinkTo(join(home, "todos"), join(main, "todos"))).toBe(true);
    for (const name of [".credentials.json", "backups", "settings.json.tmp.123.abc"]) {
      expect(await lstat(join(home, name)).catch(() => null)).toBeNull();
    }

    const seeded = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    expect(seeded.oauthAccount).toBeUndefined();
    expect(seeded.userID).toBeUndefined();
    expect(seeded.cachedGrowthBookFeatures).toBeUndefined();
    expect(seeded.mcpServers).toEqual({ docs: { command: "docs-mcp" } });
    expect(seeded.theme).toBe("dark");
    expect(seeded.hasCompletedOnboarding).toBe(true);
  });

  it("links to the real file behind a dotfiles symlink, so writes can't replace the user's link", async () => {
    const main = join(root, "main");
    const dotfiles = join(root, "dotfiles");
    const home = join(root, "homes", "claude-d");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(main, { recursive: true });
    await mkdir(dotfiles, { recursive: true });
    await writeFile(join(dotfiles, "settings.json"), "{}");
    await symlink(join(dotfiles, "settings.json"), join(main, "settings.json"));
    await prepareClaudeHome(home, true);
    expect(await isLinkTo(join(home, "settings.json"), join(dotfiles, "settings.json"))).toBe(true);
  });

  it("keeps MCP servers in step with main without clobbering the account", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-b");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(main, { recursive: true });
    await sync(home, main, { mcpServers: { docs: { command: "docs-mcp" }, old: { command: "old-mcp" } } });

    // The account signs in and adds a server of its own; Claude Code writes its identity here.
    const signedIn = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    signedIn.oauthAccount = { emailAddress: "b@example.com" };
    signedIn.mcpServers = { ...signedIn.mcpServers, mine: { command: "mine-mcp" } };
    signedIn.projects = { "/work": { allowedTools: ["Bash(npm test)"] } };
    await writeFile(join(home, ".claude.json"), JSON.stringify(signedIn));

    await sync(
      home,
      main,
      {
        mcpServers: { docs: { command: "docs-mcp-v2" }, linear: { url: "https://mcp.linear.app" } },
        projects: { "/work": { hasTrustDialogAccepted: true, allowedTools: ["Bash(ls)"] } },
      },
      5_000,
    );

    const synced = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    expect(synced.oauthAccount).toEqual({ emailAddress: "b@example.com" });
    expect(synced.mcpServers).toEqual({
      docs: { command: "docs-mcp-v2" },
      linear: { url: "https://mcp.linear.app" },
      mine: { command: "mine-mcp" },
    });
    expect(synced.projects["/work"]).toEqual({ allowedTools: ["Bash(npm test)", "Bash(ls)"], hasTrustDialogAccepted: true });
    expect(await lstat(join(home, ".claude.json.lock")).catch(() => null)).toBeNull();
  });

  it("leaves entries the CLI created inside the home alone", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-c");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(join(home, "plans"), { recursive: true });
    await writeFile(join(home, "plans", "mine.md"), "keep me");
    await mkdir(join(main, "plans"), { recursive: true });
    await prepareClaudeHome(home, true);
    expect((await lstat(join(home, "plans"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(home, "plans", "mine.md"), "utf8")).toBe("keep me");
  });
});

describe("prepareCodexHome", () => {
  it("shares sessions and config but not credentials, caches or databases", async () => {
    const main = join(root, "codex");
    const home = join(root, "homes", "codex-a");
    process.env.CODEX_HOME = main;
    await mkdir(join(main, "skills"), { recursive: true });
    for (const name of ["auth.json", "config.toml", "models_cache.json", "state_5.sqlite", "state_5.sqlite-wal", "..codex-global-state.json.tmp-1"]) {
      await writeFile(join(main, name), "");
    }
    await prepareCodexHome(home, true);

    expect(await isLinkTo(join(home, "config.toml"), join(main, "config.toml"))).toBe(true);
    expect(await isLinkTo(join(home, "sessions"), join(main, "sessions"))).toBe(true);
    expect(await isLinkTo(join(home, "archived_sessions"), join(main, "archived_sessions"))).toBe(true);
    for (const name of ["auth.json", "models_cache.json", "state_5.sqlite", "state_5.sqlite-wal", "..codex-global-state.json.tmp-1"]) {
      expect(await lstat(join(home, name)).catch(() => null)).toBeNull();
    }
  });
});

describe("prepareOpenCodeHome", () => {
  it("keeps both CLIs' logins private, shares history and caches, and writes the key to pi's auth file", async () => {
    const main = join(root, "pi-agent");
    const data = join(root, "xdg-data");
    const home = join(root, "homes", "opencode-a");
    process.env.PI_CODING_AGENT_DIR = main;
    process.env.XDG_DATA_HOME = data;
    await mkdir(join(main, "sessions"), { recursive: true });
    await writeFile(join(main, "settings.json"), "{}");
    await writeFile(join(main, "auth.json"), "{}");
    await mkdir(join(data, "opencode", "venvs"), { recursive: true });
    await writeFile(join(data, "opencode", "opencode.db"), "");
    await writeFile(join(data, "opencode", "opencode.db-wal"), "");

    await writeOpenCodeKey(home, "oc_test_key");
    await prepareOpenCodeHome(home, true);

    expect(await isLinkTo(join(home, "pi", "sessions"), join(main, "sessions"))).toBe(true);
    expect(await isLinkTo(join(home, "pi", "settings.json"), join(main, "settings.json"))).toBe(true);
    // pi's login is this account's own file, not a link to the user's login.
    expect((await lstat(join(home, "pi", "auth.json"))).isSymbolicLink()).toBe(false);
    expect(JSON.parse(await readFile(join(home, "pi", "auth.json"), "utf8"))).toEqual({
      "opencode-go": { type: "api_key", key: "oc_test_key" },
    });
    expect(await isLinkTo(join(home, "oc-data", "opencode", "venvs"), join(data, "opencode", "venvs"))).toBe(true);
    for (const name of ["opencode.db", "opencode.db-wal"]) {
      expect(await lstat(join(home, "oc-data", "opencode", name)).catch(() => null)).toBeNull();
    }
    if (process.platform !== "win32") {
      expect((await stat(join(home, "key"))).mode & 0o777).toBe(0o600);
    }
  });

  it("clears pi's login when the account's key is gone", async () => {
    const home = join(root, "homes", "opencode-b");
    process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
    process.env.XDG_DATA_HOME = join(root, "xdg-data");
    await writeOpenCodeKey(home, "oc_test_key");
    await prepareOpenCodeHome(home, true);
    expect(await readOpenCodeKey(home)).toBe("oc_test_key");
    expect(await lstat(join(home, "pi", "auth.json")).catch(() => null)).not.toBeNull();

    await removeOpenCodeKey(home);
    await prepareOpenCodeHome(home, true);
    expect(await lstat(join(home, "pi", "auth.json")).catch(() => null)).toBeNull();
  });
});

describe("removeHome", () => {
  it("deletes the home without touching what its links point at", async () => {
    process.env.PASEO_HOME = root;
    const main = join(root, "main");
    const home = join(root, "zerosub", "homes", "claude-x");
    await mkdir(join(main, "projects"), { recursive: true });
    await writeFile(join(main, "projects", "conversation.jsonl"), "keep");
    await mkdir(home, { recursive: true });
    await symlink(join(main, "projects"), join(home, "projects"));
    await writeFile(join(home, ".claude.json"), "{}");

    await removeHome(home);

    expect(await lstat(home).catch(() => null)).toBeNull();
    expect(await readFile(join(main, "projects", "conversation.jsonl"), "utf8")).toBe("keep");
  });

  it("refuses anything outside zerosub's homes directory", async () => {
    process.env.PASEO_HOME = root;
    const outside = join(root, "elsewhere");
    await mkdir(outside, { recursive: true });
    await removeHome(outside);
    expect((await lstat(outside)).isDirectory()).toBe(true);
  });
});

describe("mergeShared", () => {
  it("merges objects, unions lists and adopts true", () => {
    expect(mergeShared({ a: 1, mine: 2 }, { a: 3, b: 4 })).toEqual({ a: 3, b: 4, mine: 2 });
    expect(mergeShared({ gone: 1, mine: 2 }, { a: 1 }, new Set(["gone", "a"]))).toEqual({ a: 1, mine: 2 });
    expect(mergeShared(["x"], ["x", "y"])).toEqual(["x", "y"]);
    expect(mergeShared(false, true)).toBe(true);
    expect(mergeShared(true, false)).toBe(true);
  });
});
