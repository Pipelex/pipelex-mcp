import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseEnv } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_API_URL } from "./capabilities/shared.js";
import {
  LOGIN_COMMAND,
  MAX_HOME_ENV_BYTES,
  RELATIVE_HOME_SENTENCE,
  apiOrigin,
  checkHomeEnvWritable,
  credentialsResolver,
  displayPath,
  isWellFormedApiKey,
  readHomeEnv,
  resolvePipelexHome,
  resolveWorkshopCredentials,
  saveApiKeyToHomeEnv,
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

describe("the base URL texture", () => {
  it("names the file and the origin when the base URL in use is the file's", async () => {
    const userHome = await makeTempDir();
    await fs.mkdir(path.join(userHome, ".pipelex"));
    await fs.writeFile(
      path.join(userHome, ".pipelex", ".env"),
      "PIPELEX_API_KEY=plx_sk_file_secret\nPIPELEX_BASE_URL=https://user:hunter2@api-dev.pipelex.com/v1?token=abc\n",
    );

    const credentials = await resolveWorkshopCredentials(
      { PIPELEX_BASE_URL: "" },
      { homedir: homedirAt(userHome) },
    );

    expect(credentials.source).toBe("file");
    expect(credentials.baseUrlSource).toEqual({
      hint: `The PIPELEX_BASE_URL in use, https://api-dev.pipelex.com, was read from \`${path.join("~", ".pipelex", ".env")}\` beside the saved key: fix it there, or set PIPELEX_BASE_URL in the host's configuration, which overrides the file's.`,
    });
    for (const leak of ["secret", "hunter2", "user", "token", "abc", "/v1", userHome]) {
      expect(credentials.baseUrlSource?.hint).not.toContain(leak);
    }
  });

  it("names the file without a value when the file's base URL is not an http(s) URL", async () => {
    const home = await homeWith("PIPELEX_API_KEY=plx_sk_file\nPIPELEX_BASE_URL=localhost:8081\n");

    const credentials = await resolveWorkshopCredentials(
      { PIPELEX_HOME: home },
      { homedir: homedirAt("/nowhere") },
    );

    expect(credentials.baseUrlSource?.hint).toMatch(
      new RegExp(
        `^The PIPELEX_BASE_URL in use was read from \`${escapeRegExp(path.join(home, ".env"))}\``,
      ),
    );
    expect(credentials.baseUrlSource?.hint).not.toContain("localhost");
  });

  it("is absent when the environment sets the base URL, even beside the file's key", async () => {
    const home = await homeWith(
      "PIPELEX_API_KEY=plx_sk_file\nPIPELEX_BASE_URL=https://api-dev.pipelex.com\n",
    );

    const credentials = await resolveWorkshopCredentials({
      PIPELEX_HOME: home,
      PIPELEX_BASE_URL: "http://localhost:8081",
    });

    expect(credentials).toMatchObject({ source: "file", baseUrl: "http://localhost:8081" });
    expect(credentials.baseUrlSource).toBeUndefined();
  });

  it("is absent when the file's key goes to the hosted API by default", async () => {
    const home = await homeWith("PIPELEX_API_KEY=plx_sk_file\nPIPELEX_BASE_URL=\n");

    const credentials = await resolveWorkshopCredentials({ PIPELEX_HOME: home });

    expect(credentials).toMatchObject({ source: "file", baseUrl: DEFAULT_API_URL });
    expect(credentials.baseUrlSource).toBeUndefined();
  });

  it("is absent when the key is the host's, or when there is none", async () => {
    // The file's base URL never comes with the host's key, nor goes out alone.
    const saved = await homeWith(
      "PIPELEX_API_KEY=plx_sk_file\nPIPELEX_BASE_URL=https://api-dev.pipelex.com\n",
    );
    const keyless = await homeWith("PIPELEX_BASE_URL=https://api-dev.pipelex.com\n");

    const host = await resolveWorkshopCredentials({
      PIPELEX_API_KEY: "plx_sk_host",
      PIPELEX_HOME: saved,
    });
    const none = await resolveWorkshopCredentials({ PIPELEX_HOME: keyless });

    expect(host.source).toBe("host");
    expect(host.baseUrlSource).toBeUndefined();
    expect(none.source).toBe("none");
    expect(none.baseUrlSource).toBeUndefined();
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("saveApiKeyToHomeEnv", () => {
  const KEY = "plx_sk_new.Key_~-1";
  const POSIX = process.platform !== "win32";

  async function modeOf(file: string): Promise<number> {
    return (await fs.stat(file)).mode & 0o777;
  }

  /** The names in a directory that are not the files a test put there: a leftover temporary file. */
  async function leftovers(dir: string, expected: string[]): Promise<string[]> {
    return (await fs.readdir(dir)).filter((name) => !expected.includes(name));
  }

  it("creates the home directory and the file, with the key alone at mode 0600", async () => {
    const home = path.join(await makeTempDir(), "nested", "pipelex-home");

    const saved = await saveApiKeyToHomeEnv({ PIPELEX_HOME: home }, KEY);

    expect(saved).toEqual({ status: "saved", file: path.join(home, ".env") });
    expect(await fs.readFile(path.join(home, ".env"), "utf8")).toBe(`PIPELEX_API_KEY=${KEY}\n`);
    if (POSIX) expect(await modeOf(path.join(home, ".env"))).toBe(0o600);
    expect(await leftovers(home, [".env"])).toEqual([]);
  });

  it("saves in ~/.pipelex/.env when PIPELEX_HOME is unset, and a reader then finds the key", async () => {
    const userHome = await makeTempDir();
    const homedir = homedirAt(userHome);

    const saved = await saveApiKeyToHomeEnv({}, KEY, { homedir });
    const credentials = await resolveWorkshopCredentials({}, { homedir });

    expect(saved).toEqual({ status: "saved", file: path.join(userHome, ".pipelex", ".env") });
    expect(credentials).toMatchObject({ apiKey: KEY, source: "file" });
    expect(displayPath(path.join(userHome, ".pipelex", ".env"), homedir)).toBe(
      `~${path.sep}${path.join(".pipelex", ".env")}`,
    );
  });

  it("replaces every assignment of the key in place, export ones included, and keeps every other line", async () => {
    const before = [
      "# Pipelex credentials",
      "PIPELEX_BASE_URL=https://api-dev.pipelex.com",
      "PIPELEX_API_KEY=plx_sk_old_one",
      "",
      "export PIPELEX_API_KEY=plx_sk_old_two # from a shell",
      '  PIPELEX_API_KEY = "plx_sk_old_three"',
      "# PIPELEX_API_KEY=plx_sk_commented_out",
      "OPENAI_API_KEY='sk-other' # a comment",
      "PIPELEX_API_KEY_BACKUP=plx_sk_kept",
      "",
    ].join("\n");
    const home = await homeWith(before);

    const saved = await saveApiKeyToHomeEnv({ PIPELEX_HOME: home }, KEY);

    expect(saved.status).toBe("saved");
    expect(await fs.readFile(path.join(home, ".env"), "utf8")).toBe(
      [
        "# Pipelex credentials",
        "PIPELEX_BASE_URL=https://api-dev.pipelex.com",
        `PIPELEX_API_KEY=${KEY}`,
        "",
        `export PIPELEX_API_KEY=${KEY}`,
        `PIPELEX_API_KEY=${KEY}`,
        "# PIPELEX_API_KEY=plx_sk_commented_out",
        "OPENAI_API_KEY='sk-other' # a comment",
        "PIPELEX_API_KEY_BACKUP=plx_sk_kept",
        "",
      ].join("\n"),
    );
  });

  it("appends the key when the file holds none, ending an unterminated last line first", async () => {
    const home = await homeWith("PIPELEX_BASE_URL=https://api-dev.pipelex.com");

    await saveApiKeyToHomeEnv({ PIPELEX_HOME: home }, KEY);

    expect(await fs.readFile(path.join(home, ".env"), "utf8")).toBe(
      `PIPELEX_BASE_URL=https://api-dev.pipelex.com\nPIPELEX_API_KEY=${KEY}\n`,
    );
  });

  it("keeps a file's CRLF line endings and its byte-order mark", async () => {
    const home = await homeWith("\uFEFFA=1\r\nPIPELEX_API_KEY=plx_sk_old\r\nB=2\r\n");

    await saveApiKeyToHomeEnv({ PIPELEX_HOME: home }, KEY);

    expect(await fs.readFile(path.join(home, ".env"), "utf8")).toBe(
      `\uFEFFA=1\r\nPIPELEX_API_KEY=${KEY}\r\nB=2\r\n`,
    );
  });

  it("never takes a line inside another variable's quoted value for an assignment", async () => {
    const before = 'NOTE="first line\nPIPELEX_API_KEY=plx_sk_inside_a_value\nlast line"\nZ=1\n';
    const home = await homeWith(before);

    await saveApiKeyToHomeEnv({ PIPELEX_HOME: home }, KEY);
    const after = await fs.readFile(path.join(home, ".env"), "utf8");

    expect(after).toBe(`${before}PIPELEX_API_KEY=${KEY}\n`);
    expect(parseEnv(after)).toEqual({
      NOTE: "first line\nPIPELEX_API_KEY=plx_sk_inside_a_value\nlast line",
      Z: "1",
      PIPELEX_API_KEY: KEY,
    });
  });

  it("replaces an old multi-line value of the key whole", async () => {
    const home = await homeWith('A=1\nPIPELEX_API_KEY="plx_sk_\nbroken"\nB=2\n');

    await saveApiKeyToHomeEnv({ PIPELEX_HOME: home }, KEY);

    expect(await fs.readFile(path.join(home, ".env"), "utf8")).toBe(
      `A=1\nPIPELEX_API_KEY=${KEY}\nB=2\n`,
    );
  });

  it.skipIf(!POSIX)("tightens a file others could read to 0600", async () => {
    const home = await homeWith("A=1\n");
    await fs.chmod(path.join(home, ".env"), 0o644);

    await saveApiKeyToHomeEnv({ PIPELEX_HOME: home }, KEY);

    expect(await modeOf(path.join(home, ".env"))).toBe(0o600);
  });

  it.skipIf(!POSIX)(
    "keeps a symlinked .env a link, and rewrites the file it points to",
    async () => {
      const dotfiles = await makeTempDir();
      const target = path.join(dotfiles, "pipelex.env");
      await fs.writeFile(target, "A=1\n");
      const home = await makeTempDir();
      await fs.symlink(target, path.join(home, ".env"));

      const saved = await saveApiKeyToHomeEnv({ PIPELEX_HOME: home }, KEY);

      expect(saved).toEqual({ status: "saved", file: path.join(home, ".env") });
      expect((await fs.lstat(path.join(home, ".env"))).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(target, "utf8")).toBe(`A=1\nPIPELEX_API_KEY=${KEY}\n`);
      expect(await modeOf(target)).toBe(0o600);
      expect(await leftovers(dotfiles, ["pipelex.env"])).toEqual([]);
    },
  );

  it.skipIf(!POSIX)(
    "refuses a symlinked .env whose target does not exist, and leaves the link",
    async () => {
      const home = await makeTempDir();
      await fs.symlink(path.join(home, "missing.env"), path.join(home, ".env"));

      const saved = await saveApiKeyToHomeEnv({ PIPELEX_HOME: home }, KEY);

      expect(saved).toMatchObject({ status: "failed", file: path.join(home, ".env") });
      expect(saved.status === "failed" && saved.reason).toContain("symbolic link");
      expect((await fs.lstat(path.join(home, ".env"))).isSymbolicLink()).toBe(true);
    },
  );

  it("refuses a .env it cannot read or that is past the cap, rather than lose its other lines", async () => {
    const dirHome = await makeTempDir();
    await fs.mkdir(path.join(dirHome, ".env"));
    const bigHome = await makeTempDir();
    await fs.writeFile(path.join(bigHome, ".env"), "A=1\n");
    await fs.truncate(path.join(bigHome, ".env"), MAX_HOME_ENV_BYTES + 1);
    const binaryHome = await makeTempDir();
    await fs.writeFile(path.join(binaryHome, ".env"), Buffer.from([0x41, 0x3d, 0xff, 0xfe, 0x0a]));

    for (const home of [dirHome, bigHome, binaryHome]) {
      const saved = await saveApiKeyToHomeEnv({ PIPELEX_HOME: home }, KEY);

      expect(saved, home).toEqual({ status: "unreadable", file: path.join(home, ".env") });
    }
    expect((await fs.stat(path.join(bigHome, ".env"))).size).toBe(MAX_HOME_ENV_BYTES + 1);
    expect(await fs.readFile(path.join(binaryHome, ".env"))).toEqual(
      Buffer.from([0x41, 0x3d, 0xff, 0xfe, 0x0a]),
    );
  });

  it.skipIf(!POSIX || process.getuid?.() === 0)(
    "refuses a .env without read permission, and leaves it as it was",
    async () => {
      const home = await homeWith("A=1\n");
      await fs.chmod(path.join(home, ".env"), 0o000);

      const saved = await saveApiKeyToHomeEnv({ PIPELEX_HOME: home }, KEY);

      expect(saved).toEqual({ status: "unreadable", file: path.join(home, ".env") });
      await fs.chmod(path.join(home, ".env"), 0o600);
      expect(await fs.readFile(path.join(home, ".env"), "utf8")).toBe("A=1\n");
    },
  );

  it.skipIf(!POSIX || process.getuid?.() === 0)(
    "reports a directory it cannot write to, leaving the file and no temporary file behind",
    async () => {
      const home = await homeWith("A=1\n");
      await fs.chmod(home, 0o500);

      try {
        const saved = await saveApiKeyToHomeEnv({ PIPELEX_HOME: home }, KEY);

        expect(saved).toEqual({
          status: "failed",
          file: path.join(home, ".env"),
          reason: "permission denied",
        });
      } finally {
        await fs.chmod(home, 0o700);
      }
      expect(await fs.readFile(path.join(home, ".env"), "utf8")).toBe("A=1\n");
      expect(await leftovers(home, [".env"])).toEqual([]);
    },
  );

  it("reports a home that is a file, without throwing", async () => {
    const home = path.join(await makeTempDir(), "not-a-directory");
    await fs.writeFile(home, "A=1\n");

    const saved = await saveApiKeyToHomeEnv({ PIPELEX_HOME: home }, KEY);

    expect(saved.status).not.toBe("saved");
    expect(await fs.readFile(home, "utf8")).toBe("A=1\n");
  });

  it("refuses a relative PIPELEX_HOME, and a user with no home directory, without writing", async () => {
    const homedir = (): string => {
      throw new Error("no home directory");
    };

    expect(await saveApiKeyToHomeEnv({ PIPELEX_HOME: "relative/home" }, KEY)).toEqual({
      status: "relative_home",
    });
    expect(await saveApiKeyToHomeEnv({}, KEY, { homedir })).toMatchObject({ status: "failed" });
  });

  it("refuses a value that is not a Pipelex API key, writing nothing and never quoting it", async () => {
    const home = await makeTempDir();

    for (const value of [
      "sk-not-pipelex",
      "plx_sk_",
      "plx_sk_has space",
      'plx_sk_"quoted"',
      "plx_sk_a#b",
    ]) {
      const saved = await saveApiKeyToHomeEnv({ PIPELEX_HOME: home }, value);

      expect(saved, value).toMatchObject({ status: "failed" });
      expect(JSON.stringify(saved), value).not.toContain(value);
    }
    expect(await fs.readdir(home)).toEqual([]);
  });
});

describe("isWellFormedApiKey", () => {
  it("takes plx_sk_ followed by URL-safe characters only", () => {
    expect(isWellFormedApiKey("plx_sk_abc.DEF_123~-")).toBe(true);
    for (const value of [
      "",
      "plx_sk_",
      "plx_pk_abc",
      " plx_sk_abc",
      "plx_sk_a/b",
      "plx_sk_a=b",
      "plx_sk_a\nb",
    ]) {
      expect(isWellFormedApiKey(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("checkHomeEnvWritable", () => {
  const POSIX = process.platform !== "win32";

  it("finds a home that does not exist yet writable when its nearest existing parent is", async () => {
    const home = path.join(await makeTempDir(), "not", "yet");

    expect(await checkHomeEnvWritable({ PIPELEX_HOME: home })).toEqual({
      status: "writable",
      file: path.join(home, ".env"),
    });
    await expect(fs.stat(home)).rejects.toThrow();
  });

  it("refuses what the save would refuse, writing nothing", async () => {
    const dirHome = await makeTempDir();
    await fs.mkdir(path.join(dirHome, ".env"));
    const fileHome = path.join(await makeTempDir(), "not-a-directory");
    await fs.writeFile(fileHome, "A=1\n");

    expect(await checkHomeEnvWritable({ PIPELEX_HOME: "relative/home" })).toEqual({
      status: "relative_home",
    });
    expect(await checkHomeEnvWritable({ PIPELEX_HOME: dirHome })).toEqual({
      status: "unreadable",
      file: path.join(dirHome, ".env"),
    });
    expect((await checkHomeEnvWritable({ PIPELEX_HOME: fileHome })).status).not.toBe("writable");
    expect(await fs.readFile(fileHome, "utf8")).toBe("A=1\n");
  });

  it.skipIf(!POSIX || process.getuid?.() === 0)(
    "refuses a home directory it cannot write in, and leaves the file alone",
    async () => {
      const home = await homeWith("A=1\n");
      await fs.chmod(home, 0o500);
      try {
        expect(await checkHomeEnvWritable({ PIPELEX_HOME: home })).toEqual({
          status: "failed",
          file: path.join(home, ".env"),
          reason: "permission denied",
        });
      } finally {
        await fs.chmod(home, 0o700);
      }
      expect(await fs.readFile(path.join(home, ".env"), "utf8")).toBe("A=1\n");
    },
  );
});
