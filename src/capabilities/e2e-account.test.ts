/**
 * The live targets' account check, over an injected `/v1/me` reader: what it
 * confirms, each difference it stops on, the refusals it makes before any
 * request, and a platform that does not state the key's organization yet.
 */
import { ApiResponseError } from "@pipelex/sdk";
import { describe, expect, it, vi } from "vitest";

import {
  LiveAccountError,
  checkLiveAccount,
  missingExpectations,
  requireLiveAccount,
} from "./e2e-account.js";

const KEY = "plx_sk_never_printed";
const ORG_ID = "org_19b48477-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "org_19b48477-0000-4000-8000-000000000002";
const EMAIL = "qa+dev-builder@example.com";

/** What `test-account run` hands over for one key. */
const HANDED_OVER: NodeJS.ProcessEnv = {
  PIPELEX_E2E_BASE_URL: "https://api-dev.example.com",
  PIPELEX_E2E_API_KEY: KEY,
  PIPELEX_E2E_API_KEY_EXPECTED_ORG_ID: ORG_ID,
  PIPELEX_E2E_API_KEY_EXPECTED_ROLE: "member",
  PIPELEX_E2E_API_KEY_EXPECTED_EMAIL: EMAIL,
};

/** A `/v1/me` answer from a platform that states the key's organization and the key. */
function meAnswer(overrides: {
  email?: string;
  organization?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    user_id: "user_1",
    email: overrides.email ?? EMAIL,
    full_name: "QA Builder (dev)",
    organization:
      overrides.organization === undefined
        ? { org_id: ORG_ID, name: "QA Workshop (dev)", role_in_org: "member" }
        : overrides.organization,
    api_key: {
      id: "apikey_1",
      label: "qa.dev.workshop.builder",
      created_at: "2026-10-27T03:58:45Z",
      expires_at: null,
    },
  };
}

function reading(body: unknown) {
  return vi.fn(() => Promise.resolve(body));
}

async function refusal(env: NodeJS.ProcessEnv, readMe = reading(meAnswer({}))) {
  const verdict = await checkLiveAccount({ env, readMe });
  expect(verdict.status).toBe("refused");
  const message = verdict.status === "refused" ? verdict.message : "";
  expect(message).not.toContain(KEY);
  return { message, readMe };
}

describe("checkLiveAccount", () => {
  it("confirms a key whose organization, role and email are the ones expected, the email in any case", async () => {
    const readMe = reading(meAnswer({ email: EMAIL.toUpperCase() }));

    await expect(checkLiveAccount({ env: HANDED_OVER, readMe })).resolves.toEqual({
      status: "confirmed",
      account: `QA Workshop (dev) (${ORG_ID}), as member`,
    });
    expect(readMe).toHaveBeenCalledOnce();
  });

  it("stops on another organization, naming the variable, the value found and the value expected", async () => {
    const { message } = await refusal(
      HANDED_OVER,
      reading(
        meAnswer({
          organization: { org_id: OTHER_ORG_ID, name: "QA Lab (dev)", role_in_org: "member" },
        }),
      ),
    );

    expect(message).toContain(
      `- PIPELEX_E2E_API_KEY: GET /v1/me states the organization QA Lab (dev) (${OTHER_ORG_ID}), where PIPELEX_E2E_API_KEY_EXPECTED_ORG_ID expects "${ORG_ID}"`,
    );
    expect(message).toContain("The registry's owner restores the account");
    expect(message).toContain("test-account run pipelex-mcp -- make <target>");
  });

  it("stops on another role", async () => {
    const { message } = await refusal(
      HANDED_OVER,
      reading(
        meAnswer({
          organization: { org_id: ORG_ID, name: "QA Workshop (dev)", role_in_org: "runner" },
        }),
      ),
    );

    expect(message).toContain(
      `- PIPELEX_E2E_API_KEY: GET /v1/me states the role "runner" in QA Workshop (dev) (${ORG_ID}), where PIPELEX_E2E_API_KEY_EXPECTED_ROLE expects "member"`,
    );
  });

  it("stops on a role the platform does not recognise, which it states as null", async () => {
    const { message } = await refusal(
      HANDED_OVER,
      reading(meAnswer({ organization: { org_id: ORG_ID, name: null, role_in_org: null } })),
    );

    expect(message).toContain(
      `GET /v1/me states the role null in "${ORG_ID}", where PIPELEX_E2E_API_KEY_EXPECTED_ROLE expects "member"`,
    );
  });

  it("stops on another account", async () => {
    const { message } = await refusal(
      HANDED_OVER,
      reading(meAnswer({ email: "someone@example.com" })),
    );

    expect(message).toContain(
      `- PIPELEX_E2E_API_KEY: GET /v1/me states the account "someone@example.com", where PIPELEX_E2E_API_KEY_EXPECTED_EMAIL expects "${EMAIL}"`,
    );
  });

  it("stops once with every difference", async () => {
    const { message } = await refusal(
      HANDED_OVER,
      reading(
        meAnswer({
          email: "someone@example.com",
          organization: { org_id: OTHER_ORG_ID, name: "Test team", role_in_org: "admin" },
        }),
      ),
    );

    const findings = message.split("\n").filter((line) => line.startsWith("- "));
    expect(findings).toHaveLength(3);
    expect(message.match(/did not start/g)).toHaveLength(1);
  });

  it("stops on a key that acts for no organization", async () => {
    const { message } = await refusal(HANDED_OVER, reading(meAnswer({ organization: null })));

    expect(message).toContain(
      `GET /v1/me states the key acts for no organization, where PIPELEX_E2E_API_KEY_EXPECTED_ORG_ID expects "${ORG_ID}"`,
    );
  });

  it("reports a platform that does not state the key's organization yet, never as a pass", async () => {
    const { user_id, email, full_name } = meAnswer({});
    const { message } = await refusal(HANDED_OVER, reading({ user_id, email, full_name }));

    expect(message).toContain(
      "- PIPELEX_E2E_API_KEY: the platform does not state the key's organization yet, so its organization and role cannot be compared with PIPELEX_E2E_API_KEY_EXPECTED_ORG_ID and PIPELEX_E2E_API_KEY_EXPECTED_ROLE",
    );
  });

  it("stops on a key the platform refuses, with the status and the problem's code", async () => {
    const refused = new ApiResponseError(
      "HTTP 401",
      "https://api-dev.example.com/v1/me",
      401,
      "Unauthorized",
      JSON.stringify({
        type: "https://docs.pipelex.com/errors/auth.invalid_credential",
        code: "auth.invalid_credential",
        title: "Invalid credential",
        detail: "The credential names no key that may act.",
        status: 401,
        domain: "auth",
        retry: "no",
        next_step: { kind: "fix_credential", detail: "Use a key that may act." },
      }),
    );
    const { message } = await refusal(
      HANDED_OVER,
      vi.fn(() => Promise.reject(refused)),
    );

    expect(message).toContain(
      "- PIPELEX_E2E_API_KEY: GET /v1/me refused the key: HTTP 401 (auth.invalid_credential)",
    );
  });

  it("lets an error that is no answer at all propagate", async () => {
    const bug = new TypeError("not a problem");

    await expect(
      checkLiveAccount({ env: HANDED_OVER, readMe: vi.fn(() => Promise.reject(bug)) }),
    ).rejects.toBe(bug);
  });

  it("refuses a key handed over with no expectations before any request, naming test-account run", async () => {
    const { message, readMe } = await refusal({
      PIPELEX_E2E_BASE_URL: HANDED_OVER.PIPELEX_E2E_BASE_URL,
      PIPELEX_E2E_API_KEY: KEY,
    });

    expect(readMe).not.toHaveBeenCalled();
    expect(message).toContain(
      "PIPELEX_E2E_API_KEY_EXPECTED_ORG_ID, PIPELEX_E2E_API_KEY_EXPECTED_ROLE and PIPELEX_E2E_API_KEY_EXPECTED_EMAIL are not set",
    );
    expect(message).toContain("no request was sent");
    expect(message).toContain("`test-account run pipelex-mcp -- make <target>`");
  });

  it.each([
    "PIPELEX_E2E_API_KEY_EXPECTED_ORG_ID",
    "PIPELEX_E2E_API_KEY_EXPECTED_ROLE",
    "PIPELEX_E2E_API_KEY_EXPECTED_EMAIL",
  ])("refuses before any request when %s alone is missing or empty", async (variable) => {
    const { message, readMe } = await refusal({ ...HANDED_OVER, [variable]: "" });

    expect(readMe).not.toHaveBeenCalled();
    expect(message).toContain(`${variable} is not set`);
  });

  it("refuses a run with no key before any request", async () => {
    const { message, readMe } = await refusal({ ...HANDED_OVER, PIPELEX_E2E_API_KEY: "" });

    expect(readMe).not.toHaveBeenCalled();
    expect(message).toContain("PIPELEX_E2E_API_KEY is not set, so no request was sent");
  });

  it("never reads the other tools' pair or their expectations", async () => {
    const { readMe } = await refusal({
      PIPELEX_API_KEY: KEY,
      PIPELEX_API_KEY_EXPECTED_ORG_ID: ORG_ID,
      PIPELEX_API_KEY_EXPECTED_ROLE: "member",
      PIPELEX_API_KEY_EXPECTED_EMAIL: EMAIL,
    });

    expect(readMe).not.toHaveBeenCalled();
  });
});

describe("missingExpectations", () => {
  it("lists the unset and empty expectations in a fixed order", () => {
    expect(
      missingExpectations({
        PIPELEX_E2E_API_KEY_EXPECTED_ROLE: "member",
        PIPELEX_E2E_API_KEY_EXPECTED_EMAIL: "",
      }),
    ).toEqual(["PIPELEX_E2E_API_KEY_EXPECTED_ORG_ID", "PIPELEX_E2E_API_KEY_EXPECTED_EMAIL"]);
    expect(missingExpectations(HANDED_OVER)).toEqual([]);
  });
});

describe("requireLiveAccount", () => {
  it("returns the confirmed account", async () => {
    await expect(
      requireLiveAccount({ env: HANDED_OVER, readMe: reading(meAnswer({})) }),
    ).resolves.toBe(`QA Workshop (dev) (${ORG_ID}), as member`);
  });

  it("throws the stop message as a LiveAccountError", async () => {
    const pending = requireLiveAccount({
      env: HANDED_OVER,
      readMe: reading(meAnswer({ organization: null })),
    });

    await expect(pending).rejects.toBeInstanceOf(LiveAccountError);
    await expect(pending).rejects.toThrow(/acts for no organization/);
  });
});
