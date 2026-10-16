import { describe, expect, it } from "vitest";
import { bringsOwnAuth, familiesFromConfig } from "./families";

describe("familiesFromConfig", () => {
  it("maps the built-in providers, with pi and the opencode CLI on OpenCode Go", () => {
    expect(familiesFromConfig({ pi: { enabled: true }, opencode: { paseoTools: {} } })).toEqual({
      claude: "claude",
      codex: "codex",
      opencode: "opencode",
      pi: "opencode",
    });
    // A config that never mentions them still maps the built-ins.
    expect(familiesFromConfig({})).toEqual({ claude: "claude", codex: "codex", opencode: "opencode", pi: "opencode" });
  });

  it("leaves providers that bring their own credentials alone", () => {
    const mapped = familiesFromConfig({
      pi: { env: { PI_CODING_AGENT_DIR: "/tmp/agent" } },
      opencode: { env: { OPENCODE_API_KEY: "oc_x" } },
    });
    expect(mapped.pi).toBeUndefined();
    expect(mapped.opencode).toBeUndefined();
    // An empty value is no credential at all.
    expect(familiesFromConfig({ pi: { env: { PI_CODING_AGENT_DIR: "" } } }).pi).toBe("opencode");
  });

  it("maps custom profiles that extend a built-in, unless they bring their own credentials", () => {
    const mapped = familiesFromConfig({
      "go-work": { extends: "pi" },
      "go-home": { extends: "opencode", env: { OPENCODE_API_KEY: "oc_x" } },
      "claude-work": { extends: "claude" },
      "other": { extends: "somewhere-else" },
    });
    expect(mapped["go-work"]).toBe("opencode");
    expect(mapped["go-home"]).toBeUndefined();
    expect(mapped["claude-work"]).toBe("claude");
    expect(mapped.other).toBeUndefined();
  });
});

describe("bringsOwnAuth", () => {
  it("only counts non-empty string values", () => {
    expect(bringsOwnAuth("opencode", undefined)).toBe(false);
    expect(bringsOwnAuth("opencode", { OPENCODE_API_KEY: "oc_x" })).toBe(true);
    expect(bringsOwnAuth("opencode", { OPENCODE_API_KEY: "" })).toBe(false);
    expect(bringsOwnAuth("opencode", { OPENCODE_API_KEY: 42 })).toBe(false);
    expect(bringsOwnAuth("opencode", { SOMETHING_ELSE: "oc_x" })).toBe(false);
  });
});
