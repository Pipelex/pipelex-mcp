/**
 * The workshop's secret guard: before a method's tree leaves the machine, it
 * refuses a file whose NAME is a known secret file, or whose TEXT holds a
 * well-known key format, in whatever encoding the file is written.
 *
 * The membership rule already keeps the commonest secret files out by
 * construction, since `.env`, `.ssh/`, `.aws/` and every other dotfile start
 * with a dot. What it cannot keep out is a key file under an ordinary name, or
 * a key pasted into an ordinary file: a `.py` module is the usual home of one,
 * which is why the guard reads text and not names alone (the design's security
 * posture, `wip/extra-files/design.md`). It is a tripwire for the well-known
 * shapes, never a promise that a tree holds no secret: a password in prose, a
 * scanned contract or a payslip goes through it.
 *
 * A finding names the file and what matched, and **never the matched text**,
 * since a refusal is shown to a model and may be logged.
 *
 * Pure: it reads the bytes it is handed and nothing else, so every tool that
 * sends a method's files, the save and every method-taking tool alike, asks
 * the same question of the bytes it is about to send.
 */

/** One file the guard refuses, and why, in words that quote nothing of the file. */
export interface SecretFinding {
  /** The file's tree path. */
  path: string;
  /** What it is, or what it holds: "a private key block (PEM)", "an AWS access key id". */
  reason: string;
}

/** Whether the bytes open with a zip archive's local file header, `PK\x03\x04`. */
function isZipArchive(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Secret file names, matched on the last segment of a tree path, ignoring
 * case: key and certificate stores, SSH private keys under their default
 * names, and the credential exports of the cloud consoles. A rule with
 * `unless` lets a file of that name go when its bytes show it is something
 * else.
 *
 * `.pem` is no name rule: a `.pem` file is as often a certificate, which is
 * public, and a private key in one is a PEM block, which the text search
 * finds. A `.key` file is a Keynote deck as often as a key, and a deck is a
 * zip archive, so only a `.key` file that is no zip is refused by name, which
 * still catches a DER key, binary and holding no PEM block.
 */
const SECRET_NAMES: readonly {
  pattern: RegExp;
  reason: string;
  unless?: (bytes: Uint8Array) => boolean;
}[] = [
  {
    pattern: /\.key$/i,
    reason: "a key file (.key), and is no zip archive as a Keynote deck is",
    unless: isZipArchive,
  },
  { pattern: /\.(p12|pfx|jks|keystore)$/i, reason: "a certificate or key store" },
  { pattern: /\.ppk$/i, reason: "a PuTTY private key" },
  { pattern: /\.kdbx$/i, reason: "a KeePass password database" },
  { pattern: /^id_(rsa|dsa|ecdsa|ed25519)/i, reason: "an SSH key under its default name" },
  { pattern: /^credentials(\.json)?$/i, reason: "a credentials file" },
  { pattern: /^client_secret.*\.json$/i, reason: "an OAuth client secret export" },
];

/**
 * Well-known key formats, matched in a file's text. Each is a prefix a
 * provider puts on its keys so that scanners can find them, with enough of
 * the key's body after it that prose mentioning the prefix does not match.
 */
const KEY_FORMATS: readonly { pattern: RegExp; reason: string }[] = [
  {
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
    reason: "a private key block (PEM)",
  },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, reason: "an AWS access key id" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, reason: "a GitHub token" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/, reason: "a GitHub fine-grained token" },
  { pattern: /\bglpat-[A-Za-z0-9_-]{20,}/, reason: "a GitLab token" },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, reason: "a Slack token" },
  { pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/, reason: "a Stripe live key" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}/, reason: "a Google API key" },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/, reason: "an Anthropic API key" },
  {
    pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/,
    reason: "an OpenAI API key",
  },
  { pattern: /\bsk-[A-Za-z0-9]{32,}\b/, reason: "an OpenAI-style secret key" },
  { pattern: /\bhf_[A-Za-z0-9]{30,}\b/, reason: "a Hugging Face token" },
  { pattern: /\bnpm_[A-Za-z0-9]{36}\b/, reason: "an npm token" },
  { pattern: /\bplx_sk_[A-Za-z0-9_-]{16,}/, reason: "a Pipelex API key" },
];

/**
 * The texts a file's bytes are searched in. Every key format is ASCII, so the
 * bytes are read as Latin-1, one character per byte, which keeps every ASCII
 * run of them whatever the file's encoding: UTF-8, Latin-1, cp1252, or a
 * binary file with a key inside it. A file holding NUL bytes is searched once
 * more with them removed, which is how an ASCII key reads in UTF-16, with or
 * without its byte order mark, and in UTF-32.
 */
function searchableTexts(bytes: Uint8Array): string[] {
  const latin1 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  return latin1.includes("\0") ? [latin1, latin1.replaceAll("\0", "")] : [latin1];
}

/**
 * The files of a tree the guard refuses, in the order given. A file whose name
 * is a secret file's is refused on the name alone, unless its rule's `unless`
 * says its bytes are something else; every other file, text in
 * any encoding or binary, is searched for every key format in the texts
 * {@link searchableTexts} reads from its bytes.
 */
export function secretFindings(
  files: Iterable<{ path: string; bytes: Uint8Array }>,
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    const byName = SECRET_NAMES.find(
      (rule) => rule.pattern.test(name) && rule.unless?.(file.bytes) !== true,
    );
    if (byName !== undefined) {
      findings.push({ path: file.path, reason: `it is named like ${byName.reason}` });
      continue;
    }
    const texts = searchableTexts(file.bytes);
    const held = KEY_FORMATS.filter((format) =>
      texts.some((text) => format.pattern.test(text)),
    ).map((format) => format.reason);
    if (held.length > 0) {
      findings.push({ path: file.path, reason: `it holds ${[...new Set(held)].join(" and ")}` });
    }
  }
  return findings;
}

/**
 * The words of a refusal for what the guard found, naming each file as the
 * caller can find it (`shown`) and what it matched, never the matched text.
 * `again` closes the hint with what the caller does once the file is dealt
 * with, such as "save again".
 */
export function secretRefusalText(
  findings: readonly SecretFinding[],
  shown: (treePath: string) => string,
  again: string,
): { message: string; hint: string } {
  return {
    message: `The method's files hold what looks like a secret, so nothing was sent: ${findings
      .map((finding) => `${shown(finding.path)} (${finding.reason})`)
      .join("; ")}.`,
    hint: `A key belongs in the environment, never in a method: a method's files leave this machine for the Pipelex API, which keeps them in the organization's storage, where every member can read them. Move the secret out of the file, or keep the file out of the method with a .gitignore line inside its folder or a name starting with a dot, then ${again}. A file refused for its name alone that is no key, a .key file that is not a Keynote deck for one, can be renamed.`,
  };
}
