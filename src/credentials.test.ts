import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_API_URL } from "./capabilities/shared.js";
import {
  LOGIN_COMMAND,
  MAX_HOME_ENV_BYTES,
  RELATIVE_HOME_SENTENCE,
  apiOrigin,
  credentialsResolver,
  readHomeEnv,
  resolvePipelexHome,
  resolveWorkshopCredentials,
} from "./credentials.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-mcp-credentials-"));
  tempDirs.push(dir);
  return dir;
}

/** A home directory whose `.env` holds `content`. */
async function homeWith(content: string): Promise<string> {
  const home = await makeTempDir();
  await fs.writeFile(path.join(home, ".env"), content);
  return home;
}

/** A user's home directory for `os.homedir()` to name, with nothing in it. */
function homedirAt(dir: string): () => string {
  return () => dir;
}

describe("resolvePipelexHome", () => {
  const homedir = homedirAt("/home/someone");

  it("is .pipelex in the user's home when PIPELEX_HOME is unset or empty", () => {
    expect(resolvePipelexHome({}, { homedir })).toEqual({
      kind: "dir",
      dir: path.join("/home/someone", ".pipelex"),
    });
    expect(resolvePipelexHome({ PIPELEX_HOME: "" }, { homedir })).toEqual({
      kind: "dir",
      dir: path.join("/home/someone", ".pipelex"),
    });
  });

  it("takes an absolute PIPELEX_HOME as it is, and expands a leading ~", () => {
    expect(resolvePipelexHome({ PIPELEX_HOME: "/opt/pipelex/" }, { homedir })).toEqual({
      kind: "dir",
      dir: path.normalize("/opt/pipelex/"),
    });
    expect(resolvePipelexHome({ PIPELEX_HOME: "~" }, { homedir })).toEqual({
      kind: "dir",
      dir: "/home/someone",
    });
    expect(resolvePipelexHome({ PIPELEX_HOME: "~/config/pipelex" }, { homedir })).toEqual({
      kind: "dir",
      dir: path.join("/home/someone", "config", "pipelex"),
    });
  });

  it("refuses a relative PIPELEX_HOME, and does not expand another user's ~", () => {
    for (const value of ["pipelex-home", ".pipelex", "./home", "../home", "~bob/pipelex", " "]) {
      expect(resolvePipelexHome({ PIPELEX_HOME: value }, { homedir }), value).toEqual({
        kind: "relative",
      });
    }
  });
});

describe("resolveWorkshopCredentials", () => {
  it("uses the host's key and never reads the home when the host passes one", async () => {
    const homedir = vi.fn(() => "/nowhere");
    const credentials = await resolveWorkshopCredentials(
      { PIPELEX_API_KEY: "plx_sk_host" },
      { homedir },
    );

    expect(credentials).toMatchObject({
      apiKey: "plx_sk_host",
      baseUrl: DEFAULT_API_URL,
      source: "host",
    });
    expect(homedir).not.toHaveBeenCalled();
  });

  it("keeps the file's base URL away from the host's key", async () => {
    // A base URL in the file never redirects a key the host supplied.
    const home = await homeWith(
      "PIPELEX_API_KEY=plx_sk_file\nPIPELEX_BASE_URL=https://api-dev.pipelex.com\n",
    );

    const credentials = await resolveWorkshopCredentials({
      PIPELEX_API_KEY: "plx_sk_host",
      PIPELEX_HOME: home,
    });

    expect(credentials).toMatchObject({
      apiKey: "plx_sk_host",
      baseUrl: DEFAULT_API_URL,
      source: "host",
    });
  });

  it("reads the file when the host's key is empty, as a host's configuration writes it", async () => {
    const home = await homeWith("PIPELEX_API_KEY=plx_sk_file\n");

    const credentials = await resolveWorkshopCredentials({
      PIPELEX_API_KEY: "",
      PIPELEX_BASE_URL: "",
      PIPELEX_HOME: home,
    });

    expect(credentials).toMatchObject({
      apiKey: "plx_sk_file",
      baseUrl: DEFAULT_API_URL,
      source: "file",
    });
  });

  it("pairs the file's key with the file's base URL, and lets the environment's beat it", async () => {
    const home = await homeWith(
      "PIPELEX_API_KEY=plx_sk_file\nPIPELEX_BASE_URL=https://api-dev.pipelex.com\n",
    );

    expect(await resolveWorkshopCredentials({ PIPELEX_HOME: home })).toMatchObject({
      apiKey: "plx_sk_file",
      baseUrl: "https://api-dev.pipelex.com",
      source: "file",
    });
    expect(
      await resolveWorkshopCredentials({
        PIPELEX_HOME: home,
        PIPELEX_BASE_URL: "http://localhost:8081",
      }),
    ).toMatchObject({ apiKey: "plx_sk_file", baseUrl: "http://localhost:8081", source: "file" });
  });

  it("applies the file's base URL only with the file's key", async () => {
    const home = await homeWith("PIPELEX_BASE_URL=https://api-dev.pipelex.com\n");

    const credentials = await resolveWorkshopCredentials({ PIPELEX_HOME: home });

    expect(credentials.source).toBe("none");
    expect(credentials.apiKey).toBeUndefined();
    expect(credentials.baseUrl).toBe(DEFAULT_API_URL);
  });

  it("counts empty values in the file as unset", async () => {
    const home = await homeWith("PIPELEX_API_KEY=\nPIPELEX_BASE_URL=\n");

    expect(await resolveWorkshopCredentials({ PIPELEX_HOME: home })).toMatchObject({
      baseUrl: DEFAULT_API_URL,
      source: "none",
    });

    const keyed = await homeWith("PIPELEX_API_KEY=plx_sk_file\nPIPELEX_BASE_URL=\n");
    expect(await resolveWorkshopCredentials({ PIPELEX_HOME: keyed })).toMatchObject({
      apiKey: "plx_sk_file",
      baseUrl: DEFAULT_API_URL,
      source: "file",
    });
  });

  it("reads export lines, quoted values and comments, as the pipelex CLI writes and users edit", async () => {
    const home = await homeWith(
      [
        "# Pipelex credentials — managed by 'pipelex init' and 'pipelex login'",
        "OPENAI_API_KEY=sk-other",
        'export PIPELEX_API_KEY="plx_sk_quoted" # saved by pipelex login',
        "export PIPELEX_BASE_URL='https://api-dev.pipelex.com'",
        "",
      ].join("\n"),
    );

    expect(await resolveWorkshopCredentials({ PIPELEX_HOME: home })).toMatchObject({
      apiKey: "plx_sk_quoted",
      baseUrl: "https://api-dev.pipelex.com",
      source: "file",
    });
  });

  it("takes the last of several assignments, and ignores a byte-order mark", async () => {
    const home = await homeWith(
      "\uFEFFPIPELEX_API_KEY=plx_sk_first\nPIPELEX_API_KEY=plx_sk_last\n",
    );

    expect((await resolveWorkshopCredentials({ PIPELEX_HOME: home })).apiKey).toBe("plx_sk_last");
  });

  it("follows a symlinked .env to the file it points to", async () => {
    const dotfiles = await homeWith("PIPELEX_API_KEY=plx_sk_linked\n");
    const home = await makeTempDir();
    await fs.symlink(path.join(dotfiles, ".env"), path.join(home, ".env"));

    expect((await resolveWorkshopCredentials({ PIPELEX_HOME: home })).apiKey).toBe("plx_sk_linked");
  });

  it("reads ~/.pipelex/.env when PIPELEX_HOME is unset or empty, and a ~-prefixed home", async () => {
    const userHome = await makeTempDir();
    await fs.mkdir(path.join(userHome, ".pipelex"));
    await fs.writeFile(path.join(userHome, ".pipelex", ".env"), "PIPELEX_API_KEY=plx_sk_default\n");
    await fs.mkdir(path.join(userHome, "elsewhere"));
    await fs.writeFile(path.join(userHome, "elsewhere", ".env"), "PIPELEX_API_KEY=plx_sk_tilde\n");
    const homedir = homedirAt(userHome);

    expect((await resolveWorkshopCredentials({}, { homedir })).apiKey).toBe("plx_sk_default");
    expect((await resolveWorkshopCredentials({ PIPELEX_HOME: "" }, { homedir })).apiKey).toBe(
      "plx_sk_default",
    );
    expect(
      (await resolveWorkshopCredentials({ PIPELEX_HOME: "~/elsewhere" }, { homedir })).apiKey,
    ).toBe("plx_sk_tilde");
  });

  it("refuses a relative PIPELEX_HOME without reading what it resolves to", async () => {
    // A relative home resolves against the working directory, which is the
    // project the host spawned the workshop in: a cloned repository could ship
    // the `.env` it names. This one resolves to a real home holding a key.
    const home = await homeWith(
      "PIPELEX_API_KEY=plx_sk_planted\nPIPELEX_BASE_URL=https://attacker.test\n",
    );
    const relative = path.relative(process.cwd(), home);
    expect(path.isAbsolute(relative)).toBe(false);

    const credentials = await resolveWorkshopCredentials({ PIPELEX_HOME: relative });

    expect(credentials.source).toBe("none");
    expect(credentials.apiKey).toBeUndefined();
    expect(credentials.baseUrl).toBe(DEFAULT_API_URL);
    expect(credentials.authError.location).toBe("PIPELEX_API_KEY");
    expect(credentials.authError.hint).toContain(RELATIVE_HOME_SENTENCE);
    expect(credentials.authError.hint).toContain(`\`${LOGIN_COMMAND}\``);
  });

  it("says no key is set, names the file and the login, when there is no file", async () => {
    const userHome = await makeTempDir();

    const credentials = await resolveWorkshopCredentials({}, { homedir: homedirAt(userHome) });

    expect(credentials.source).toBe("none");
    expect(credentials.apiKey).toBeUndefined();
    expect(credentials.authError).toEqual({
      location: "PIPELEX_API_KEY",
      hint: `No Pipelex API key is set: the host passes none, and none is saved in \`${path.join("~", ".pipelex", ".env")}\`. To save one there, run \`npx -y @pipelex/mcp@latest login\` in a terminal, or set PIPELEX_API_KEY in the host's configuration.`,
    });
  });

  it("counts a file it cannot read as holding no key, and says it could not be read", async () => {
    // A directory where the file should be.
    const dirHome = await makeTempDir();
    await fs.mkdir(path.join(dirHome, ".env"));
    // A home that is a file, so nothing under it exists.
    const fileHome = path.join(await makeTempDir(), "not-a-directory");
    await fs.writeFile(fileHome, "PIPELEX_API_KEY=plx_sk_wrong_place\n");
    // A file far past any credentials file, sparse so it costs no disk.
    const bigHome = await makeTempDir();
    await fs.writeFile(path.join(bigHome, ".env"), "PIPELEX_API_KEY=plx_sk_big\n");
    await fs.truncate(path.join(bigHome, ".env"), MAX_HOME_ENV_BYTES + 1);

    for (const home of [dirHome, fileHome, bigHome]) {
      const credentials = await resolveWorkshopCredentials({ PIPELEX_HOME: home });

      expect(credentials.source, home).toBe("none");
      expect(credentials.apiKey, home).toBeUndefined();
      expect(credentials.authError.hint, home).toContain("could not be read");
      expect(credentials.authError.hint, home).toContain(`\`${LOGIN_COMMAND}\``);
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    "counts a file without read permission as unreadable",
    async () => {
      const home = await homeWith("PIPELEX_API_KEY=plx_sk_locked\n");
      await fs.chmod(path.join(home, ".env"), 0o000);

      const read = await readHomeEnv({ PIPELEX_HOME: home });
      const credentials = await resolveWorkshopCredentials({ PIPELEX_HOME: home });

      expect(read.status).toBe("unreadable");
      expect(credentials.source).toBe("none");
      expect(credentials.authError.hint).toContain("could not be read");
    },
  );

  it("never throws when the user has no home directory", async () => {
    const homedir = (): string => {
      throw new Error("no home directory");
    };

    const credentials = await resolveWorkshopCredentials({}, { homedir });

    expect(credentials.source).toBe("none");
    expect(credentials.authError.hint).toContain("could not be read");
  });

  it("reads the file afresh on every call, so a key saved mid-session is used at once", async () => {
    const home = await makeTempDir();
    const resolve = credentialsResolver({ PIPELEX_HOME: home });

    expect((await resolve()).source).toBe("none");

    await fs.writeFile(path.join(home, ".env"), "PIPELEX_API_KEY=plx_sk_saved\n");
    expect(await resolve()).toMatchObject({ apiKey: "plx_sk_saved", source: "file" });
  });
});

describe("the auth texture", () => {
  it("says which key was refused, by which API, and never quotes the key", async () => {
    const home = await homeWith("PIPELEX_API_KEY=plx_sk_file_secret\n");

    const host = await resolveWorkshopCredentials({
      PIPELEX_API_KEY: "plx_sk_host_secret",
      PIPELEX_BASE_URL: "https://api-dev.pipelex.com",
    });
    const file = await resolveWorkshopCredentials(
      { PIPELEX_HOME: home },
      { homedir: homedirAt("/nowhere") },
    );

    expect(host.authError).toEqual({
      location: "PIPELEX_API_KEY",
      hint: "The PIPELEX_API_KEY the host passes was refused by https://api-dev.pipelex.com. Replace it in the host's configuration, or remove it there and run `npx -y @pipelex/mcp@latest login` in a terminal to use a saved key instead.",
    });
    expect(file.authError).toEqual({
      location: "PIPELEX_API_KEY",
      hint: `The key saved in \`${path.join(home, ".env")}\` was refused by https://api.pipelex.com. Run \`npx -y @pipelex/mcp@latest login\` again in a terminal to save a new one, or set PIPELEX_API_KEY in the host's configuration.`,
    });
    for (const { authError } of [host, file]) {
      expect(authError.hint).not.toContain("secret");
    }
  });

  it("names the API by its origin alone, whatever the base URL carries", async () => {
    const credentials = await resolveWorkshopCredentials({
      PIPELEX_API_KEY: "plx_sk_host",
      PIPELEX_BASE_URL: "https://user:hunter2@api.example.test:8443/v1/?token=abc#frag",
    });

    expect(credentials.authError.hint).toContain("refused by https://api.example.test:8443.");
    for (const leak of ["hunter2", "user", "token", "abc", "frag", "/v1"]) {
      expect(credentials.authError.hint).not.toContain(leak);
    }
  });

  it("names an API whose base URL is not an http(s) URL without showing it", () => {
    expect(apiOrigin("localhost:8081")).toBe("the configured Pipelex API");
    expect(apiOrigin("not a url")).toBe("the configured Pipelex API");
    expect(apiOrigin("http://127.0.0.1:8081")).toBe("http://127.0.0.1:8081");
  });

  it("shows a file under the user's home with ~", async () => {
    const userHome = await makeTempDir();
    await fs.mkdir(path.join(userHome, ".pipelex"));
    await fs.writeFile(path.join(userHome, ".pipelex", ".env"), "PIPELEX_API_KEY=plx_sk_file\n");

    const credentials = await resolveWorkshopCredentials({}, { homedir: homedirAt(userHome) });

    expect(credentials.authError.hint).toContain(`\`${path.join("~", ".pipelex", ".env")}\``);
    expect(credentials.authError.hint).not.toContain(userHome);
  });
});
