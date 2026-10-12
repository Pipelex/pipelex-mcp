import { promises as fs, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveWorkshopCredentials } from "../src/credentials.js";
import { emptySmokeHome, smokeChildEnv } from "./smoke-env.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-smoke-env-"));
  tempDirs.push(dir);
  return dir;
}

/** A user's home directory holding a saved key, as `pipelex login` leaves it. */
async function userHomeWithSavedKey(): Promise<string> {
  const userHome = await makeTempDir();
  await fs.mkdir(path.join(userHome, ".pipelex"));
  await fs.writeFile(
    path.join(userHome, ".pipelex", ".env"),
    "PIPELEX_API_KEY=plx_sk_saved\nPIPELEX_BASE_URL=https://saved.pipelex.test\n",
  );
  return userHome;
}

const target = { baseUrl: "https://api-dev.pipelex.test", apiKey: undefined };

describe("smokeChildEnv", () => {
  it("sets the live pair and an empty home of its own over the base environment", () => {
    const env = smokeChildEnv({ ...target, apiKey: "plx_sk_live" }, "/tmp/smoke-home", {
      HOME: "/home/someone",
      PATH: "/usr/bin",
    });

    expect(env).toEqual({
      HOME: "/home/someone",
      PATH: "/usr/bin",
      PIPELEX_BASE_URL: "https://api-dev.pipelex.test",
      PIPELEX_HOME: "/tmp/smoke-home",
      PIPELEX_API_KEY: "plx_sk_live",
    });
  });

  it("passes no key when the live pair has none, whatever the base environment carries", () => {
    const env = smokeChildEnv(target, "/tmp/smoke-home", {
      HOME: "/home/someone",
      PIPELEX_API_KEY: "plx_sk_ambient",
      PIPELEX_HOME: "/home/someone/.pipelex",
    });

    expect(env).not.toHaveProperty("PIPELEX_API_KEY");
    expect(env.PIPELEX_HOME).toBe("/tmp/smoke-home");
  });

  it("keeps the workshop off the developer's saved key when the live pair has none", async () => {
    // The regression this guards: the SDK's base environment always carries
    // HOME, so without PIPELEX_HOME the workshop read ~/.pipelex/.env and sent
    // its key while the script printed `key: NOT SET`.
    const userHome = await userHomeWithSavedKey();
    const smokeHome = await makeTempDir();
    const base = { HOME: userHome, PATH: "/usr/bin" };
    const homedir = () => userHome;

    const unshielded = await resolveWorkshopCredentials(
      { PIPELEX_BASE_URL: target.baseUrl },
      { homedir },
    );
    expect(unshielded).toMatchObject({ source: "file", apiKey: "plx_sk_saved" });

    const env = smokeChildEnv(target, smokeHome, base);
    const credentials = await resolveWorkshopCredentials(env, { homedir });
    expect(credentials).toMatchObject({ source: "none", baseUrl: target.baseUrl });
    expect(credentials.apiKey).toBeUndefined();
  });
});

describe("emptySmokeHome", () => {
  it("makes an empty, absolute directory outside the user's home", () => {
    const home = emptySmokeHome();
    tempDirs.push(home);

    expect(path.isAbsolute(home)).toBe(true);
    expect(statSync(home).isDirectory()).toBe(true);
    expect(readdirSync(home)).toEqual([]);
    expect(home).not.toBe(path.join(os.homedir(), ".pipelex"));
  });
});
