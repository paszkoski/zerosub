import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeOpenCodeKey } from "./homes";
import { OpenCodeAdapter, keyFingerprint, pickExportedKey } from "./opencode";

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "zerosub-opencode-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("pickExportedKey", () => {
  it("picks the active OpenCode Go credential out of the CLI's export", () => {
    const document = JSON.stringify([
      { id: "cred_a", integrationID: "anthropic", label: "Anthropic", active: true, value: { type: "key", key: "sk-ant" } },
      { id: "cred_b", integrationID: "opencode-go", label: "OpenCode Go", active: false, value: { type: "key", key: "oc_old" } },
      { id: "cred_c", integrationID: "opencode-go", label: "OpenCode Go", active: true, value: { type: "key", key: "oc_live" } },
    ]);
    expect(pickExportedKey(document)).toBe("oc_live");
  });

  it("tolerates ANSI noise and gives up quietly on anything else", () => {
    expect(pickExportedKey("\u001b[32m[]\u001b[0m")).toBeNull();
    expect(pickExportedKey("not json")).toBeNull();
    expect(pickExportedKey(JSON.stringify([{ integrationID: "opencode-go", value: { type: "key" } }]))).toBeNull();
  });
});

describe("keyFingerprint", () => {
  it("names a key without carrying it", () => {
    const fingerprint = keyFingerprint("oc_secret_key_123");
    expect(fingerprint).toMatch(/^key\|[0-9a-f]{16}$/);
    expect(fingerprint).not.toContain("oc_secret_key_123");
    expect(keyFingerprint("oc_secret_key_123")).toBe(fingerprint);
    expect(keyFingerprint("oc_other_key")).not.toBe(fingerprint);
  });
});

describe("OpenCodeAdapter", () => {
  it("points a managed account at its own homes and injects its key", async () => {
    const home = join(root, "homes", "opencode-a");
    await writeOpenCodeKey(home, "oc_managed");
    expect(await new OpenCodeAdapter().env(home)).toEqual({
      PI_CODING_AGENT_DIR: join(home, "pi"),
      XDG_DATA_HOME: join(home, "oc-data"),
      OPENCODE_API_KEY: "oc_managed",
    });
  });

  it("keeps a signed-out account off any key the daemon's environment might carry", async () => {
    const patch = await new OpenCodeAdapter().env(join(root, "homes", "opencode-b"));
    expect(patch.OPENCODE_API_KEY).toBe("");
  });

  it("leaves the CLI's own login alone for the main account", async () => {
    expect(await new OpenCodeAdapter().env(null)).toEqual({
      PI_CODING_AGENT_DIR: null,
      XDG_DATA_HOME: null,
      OPENCODE_API_KEY: null,
    });
  });

  it("calls a managed account with no key signed out without asking the provider", async () => {
    expect(await new OpenCodeAdapter().identity(join(root, "homes", "opencode-c"))).toEqual({
      signedIn: false,
      email: null,
      plan: null,
      organization: null,
      identity: null,
    });
  });

  it("only accepts the key sign-in", async () => {
    await expect(new OpenCodeAdapter().login(null, "browser")).rejects.toThrow(/API key/);
  });
});
