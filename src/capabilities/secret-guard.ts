/**
 * The workshop's secret guard: before a method's tree leaves the machine, it
 * refuses a file whose NAME is a known secret file, or whose TEXT holds a
 * well-known key format.
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
 * sends a tree (`L-261015-3a7958` extends it to the run tools) asks the same
 * question.
 */

/** One file the guard refuses, and why, in words that quote nothing of the file. */
export interface SecretFinding {
  /** The file's tree path. */
  path: string;
  /** What it is, or what it holds: "a private key block (PEM)", "an AWS access key id". */
  reason: string;
}

/**
 * Secret file names, matched on the last segment of a tree path, ignoring
 * case: key and certificate stores, SSH private keys under their default
 * names, and the credential exports of the cloud consoles.
 */
const SECRET_NAMES: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\.(pem|key)$/i, reason: "a key file (.pem or .key)" },
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

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The files of a tree the guard refuses, in the order given. A file whose name
 * is a secret file's is refused on the name alone; any other is read as text
 * when its bytes are UTF-8 and searched for every key format, and a file that
 * is not text is judged on its name alone.
 */
export function secretFindings(
  files: Iterable<{ path: string; bytes: Uint8Array }>,
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    const byName = SECRET_NAMES.find((rule) => rule.pattern.test(name));
    if (byName !== undefined) {
      findings.push({ path: file.path, reason: `it is named like ${byName.reason}` });
      continue;
    }
    let text: string;
    try {
      text = strictUtf8.decode(file.bytes);
    } catch {
      continue;
    }
    const held = KEY_FORMATS.filter((format) => format.pattern.test(text)).map(
      (format) => format.reason,
    );
    if (held.length > 0) {
      findings.push({ path: file.path, reason: `it holds ${[...new Set(held)].join(" and ")}` });
    }
  }
  return findings;
}
