import { describe, expect, it } from "vitest";

import { secretFindings } from "./secret-guard.js";

const text = (value: string) => new TextEncoder().encode(value);

/**
 * Key-shaped strings, assembled at run time so that no literal in this file
 * looks like a key to a scanner reading the repository. None is a real key.
 */
const fake = {
  pem: ["-----BEGIN ", "RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----"].join(""),
  openssh: ["-----BEGIN ", "OPENSSH PRIVATE KEY-----"].join(""),
  aws: ["AKIA", "Z".repeat(16)].join(""),
  github: ["ghp_", "a".repeat(36)].join(""),
  slack: ["xoxb-", "1234567890-abcdef"].join(""),
  stripe: ["sk_live_", "x".repeat(24)].join(""),
  google: ["AIza", "B".repeat(35)].join(""),
  anthropic: ["sk-ant-", "api03-", "c".repeat(40)].join(""),
  openai: ["sk-proj-", "d".repeat(40)].join(""),
  huggingface: ["hf_", "e".repeat(34)].join(""),
  pipelex: ["plx_sk_", "f".repeat(32)].join(""),
};

describe("secretFindings", () => {
  it("refuses a known secret file by its name, whatever its content, ignoring case", () => {
    const findings = secretFindings(
      [
        "deploy/Signing.KEY",
        "store.p12",
        "keys/id_rsa",
        "keys/id_ed25519.pub",
        "credentials.json",
        "client_secret_123.apps.googleusercontent.com.json",
        "vault.kdbx",
      ].map((path) => ({ path, bytes: text("nothing secret") })),
    );

    expect(findings.map((finding) => finding.path)).toEqual([
      "deploy/Signing.KEY",
      "store.p12",
      "keys/id_rsa",
      "keys/id_ed25519.pub",
      "credentials.json",
      "client_secret_123.apps.googleusercontent.com.json",
      "vault.kdbx",
    ]);
    expect(findings[0]?.reason).toBe(
      "it is named like a key file (.key), and is no zip archive as a Keynote deck is",
    );
  });

  it("judges a .pem file by what it holds: a certificate goes, a private key is refused", () => {
    const certificate = ["-----BEGIN ", "CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----"].join(
      "",
    );

    const findings = secretFindings([
      { path: "certs/ca.pem", bytes: text(certificate) },
      { path: "certs/server.pem", bytes: text(fake.pem) },
    ]);

    expect(findings).toEqual([
      { path: "certs/server.pem", reason: "it holds a private key block (PEM)" },
    ]);
  });

  it("lets a .key file that is a zip archive go, as a Keynote deck is, and refuses a binary key", () => {
    const keynote = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    const der = new Uint8Array([0x30, 0x82, 0x04, 0xa4, 0x02, 0x01, 0x00, 0x02]);

    const findings = secretFindings([
      { path: "decks/pitch.key", bytes: keynote },
      { path: "deploy/signing.key", bytes: der },
    ]);

    expect(findings.map((finding) => finding.path)).toEqual(["deploy/signing.key"]);
  });

  it("refuses a text file holding a well-known key format, naming the format and never the key", () => {
    const cases = Object.entries(fake).map(([name, value]) => ({
      path: `funcs/${name}.py`,
      bytes: text(`API_KEY = "${value}"\n`),
    }));

    const findings = secretFindings(cases);

    expect(findings.map((finding) => finding.path)).toEqual(cases.map((file) => file.path));
    for (const [index, finding] of findings.entries()) {
      const value = Object.values(fake)[index] ?? "";
      expect(finding.reason).not.toContain(value);
      expect(finding.reason).not.toContain(value.slice(8));
    }
    expect(findings.find((finding) => finding.path === "funcs/pem.py")?.reason).toBe(
      "it holds a private key block (PEM)",
    );
    expect(findings.find((finding) => finding.path === "funcs/pipelex.py")?.reason).toBe(
      "it holds a Pipelex API key",
    );
  });

  it("names every format one file holds, once each", () => {
    const [finding] = secretFindings([
      { path: "notes.md", bytes: text(`${fake.aws}\n${fake.github}\n${fake.aws}`) },
    ]);

    expect(finding?.reason).toBe("it holds an AWS access key id and a GitHub token");
  });

  it("passes ordinary method files, prose naming a prefix, and short look-alikes", () => {
    const findings = secretFindings([
      {
        path: "main.mthds",
        bytes: text('domain = "invoices"\n[pipe.extract]\ntype = "PipeLLM"\n'),
      },
      {
        path: "README.md",
        bytes: text(
          "Keys start with sk- or AKIA; see the sk-learn docs. A key file ends in .pem. Use ghp_ tokens.",
        ),
      },
      { path: "funcs/helpers.py", bytes: text("def total(items):\n    return sum(items)\n") },
      { path: "templates/keynote.docx", bytes: text("not a key") },
      { path: "keys.md", bytes: text("about keys") },
    ]);

    expect(findings).toEqual([]);
  });

  it("finds a key in a file that is not UTF-8: Latin-1, cp1252, or bytes around it", () => {
    // A Latin-1 or cp1252 file: an "é" as the single byte 0xe9, which no
    // UTF-8 decoder accepts, beside a key.
    const latin1 = new Uint8Array([...text("caf"), 0xe9, ...text(` key = "${fake.aws}"\n`)]);
    // A binary file with a key inside it.
    const binary = new Uint8Array([0xff, 0xd8, 0x00, 0x9f, ...text(fake.pipelex), 0x00, 0xc3]);

    expect(secretFindings([{ path: "config/legacy.py", bytes: latin1 }])).toEqual([
      { path: "config/legacy.py", reason: "it holds an AWS access key id" },
    ]);
    expect(secretFindings([{ path: "data/blob.bin", bytes: binary }])).toEqual([
      { path: "data/blob.bin", reason: "it holds a Pipelex API key" },
    ]);
  });

  it("finds a key in a UTF-16 file, with or without its byte order mark, either way round", () => {
    const utf16le = Buffer.from(`token: ${fake.github}\n`, "utf16le");
    const withBom = new Uint8Array([0xff, 0xfe, ...utf16le]);
    const bigEndian = new Uint8Array(utf16le.length);
    for (let index = 0; index < utf16le.length; index += 2) {
      bigEndian[index] = utf16le[index + 1]!;
      bigEndian[index + 1] = utf16le[index]!;
    }

    for (const bytes of [new Uint8Array(utf16le), withBom, bigEndian]) {
      expect(secretFindings([{ path: "notes.txt", bytes }])).toEqual([
        { path: "notes.txt", reason: "it holds a GitHub token" },
      ]);
    }
  });

  it("refuses a known secret file by name whatever its bytes, and lets a binary file without a key through", () => {
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x9c, 0x00]);

    expect(secretFindings([{ path: "template.docx", bytes: binary }])).toEqual([]);
    expect(secretFindings([{ path: "release.pfx", bytes: binary }])).toHaveLength(1);
  });
});
