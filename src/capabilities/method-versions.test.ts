import { ApiResponseError } from "@pipelex/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  METHOD_VERSIONS_HANDSHAKE_MS,
  METHOD_VERSIONS_TTL_MS,
  createMethodVersionsMemory,
  forgetMethodVersionsSupported,
  linkageSuffixError,
  methodContentSentence,
  methodVersionsSupport,
  noteMethodVersionsSupported,
  noteSelectorRefusal,
  planMethodSelector,
  readMethodSelector,
  runContentReport,
  versionReaderOf,
} from "./method-versions.js";
import type { MethodVersionsSupport, SelectorPlan } from "./method-versions.js";
import type { ToolError } from "./shared.js";

const SUPPORTED = { version: "1.0.0", extensions: ["runs", "method_versions"] };
const UNSUPPORTED = { version: "1.0.0", extensions: ["runs"] };

/** A version reader that counts its calls and answers `answer`. */
function counting(answer: unknown): { read: () => Promise<unknown>; calls: () => number } {
  let calls = 0;
  return {
    read: async () => {
      calls += 1;
      return answer;
    },
    calls: () => calls,
  };
}

async function planned(
  value: string,
  support: MethodVersionsSupport,
  needBareReport = true,
): Promise<{ plan?: SelectorPlan; error?: ToolError; summary?: string; asked: number }> {
  let asked = 0;
  const outcome = await planMethodSelector(
    value,
    async () => {
      asked += 1;
      return support;
    },
    { needBareReport },
  );
  return outcome.ok
    ? { plan: outcome.plan, asked }
    : { error: outcome.error, summary: outcome.summary, asked };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("readMethodSelector", () => {
  it("reads the bare id, the draft and a version, and passes anything else through", () => {
    expect(readMethodSelector("mt_a")).toEqual({ form: "bare", methodId: "mt_a" });
    expect(readMethodSelector("mt_a@draft")).toEqual({ form: "draft", methodId: "mt_a" });
    expect(readMethodSelector("mt_a@3")).toEqual({ form: "version", methodId: "mt_a", version: 3 });
    for (const opaque of ["mt_a@latest", "mt_a@03", "not-an-id"]) {
      expect(readMethodSelector(opaque)).toEqual({ form: "opaque", methodId: opaque });
    }
  });
});

describe("versionReaderOf", () => {
  it("reads nothing from a client without version(), and binds the one it has", async () => {
    expect(versionReaderOf({})).toBeUndefined();
    expect(versionReaderOf(undefined)).toBeUndefined();

    const client = {
      answer: SUPPORTED,
      async version() {
        return this.answer;
      },
    };
    expect(await versionReaderOf(client)?.()).toBe(SUPPORTED);
  });
});

describe("methodVersionsSupport", () => {
  it("reads the extension off GET /v1/version", async () => {
    expect(await methodVersionsSupport(undefined, counting(SUPPORTED).read)).toBe("supported");
    expect(await methodVersionsSupport(undefined, counting(UNSUPPORTED).read)).toBe("unsupported");
    expect(await methodVersionsSupport(undefined, counting({}).read)).toBe("unsupported");
  });

  it("answers unknown, never throwing, when it cannot ask or the ask fails", async () => {
    expect(await methodVersionsSupport(undefined, undefined)).toBe("unknown");
    expect(
      await methodVersionsSupport(undefined, async () => {
        throw new Error("down");
      }),
    ).toBe("unknown");
  });

  it("answers unknown when the handshake outlasts its deadline", async () => {
    vi.useFakeTimers();
    const answer = methodVersionsSupport(undefined, () => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(METHOD_VERSIONS_HANDSHAKE_MS);
    expect(await answer).toBe("unknown");
  });

  it("believes supported for its TTL, and asks once for concurrent callers", async () => {
    vi.useFakeTimers();
    const memory = createMethodVersionsMemory();
    const reader = counting(SUPPORTED);

    const [first, second] = await Promise.all([
      methodVersionsSupport(memory, reader.read),
      methodVersionsSupport(memory, reader.read),
    ]);
    expect([first, second]).toEqual(["supported", "supported"]);
    expect(reader.calls()).toBe(1);

    await vi.advanceTimersByTimeAsync(METHOD_VERSIONS_TTL_MS.supported - 1_000);
    expect(await methodVersionsSupport(memory, reader.read)).toBe("supported");
    expect(reader.calls()).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(await methodVersionsSupport(memory, reader.read)).toBe("supported");
    expect(reader.calls()).toBe(2);
  });

  it("believes unsupported only briefly, since it is the answer that goes stale dangerously", async () => {
    vi.useFakeTimers();
    const memory = createMethodVersionsMemory();
    const reader = counting(UNSUPPORTED);

    expect(await methodVersionsSupport(memory, reader.read)).toBe("unsupported");
    await vi.advanceTimersByTimeAsync(METHOD_VERSIONS_TTL_MS.unsupported + 1_000);
    expect(await methodVersionsSupport(memory, reader.read)).toBe("unsupported");
    expect(reader.calls()).toBe(2);
  });

  it("never caches unknown", async () => {
    const memory = createMethodVersionsMemory();
    let calls = 0;
    const failing = async (): Promise<unknown> => {
      calls += 1;
      throw new Error("down");
    };

    expect(await methodVersionsSupport(memory, failing)).toBe("unknown");
    expect(await methodVersionsSupport(memory, failing)).toBe("unknown");
    expect(calls).toBe(2);
  });

  it("takes a proof from a run, and drops supported on a contradiction", async () => {
    const memory = createMethodVersionsMemory();
    noteMethodVersionsSupported(memory);
    const reader = counting(UNSUPPORTED);
    expect(await methodVersionsSupport(memory, reader.read)).toBe("supported");
    expect(reader.calls()).toBe(0);

    forgetMethodVersionsSupported(memory);
    expect(await methodVersionsSupport(memory, reader.read)).toBe("unsupported");
    expect(reader.calls()).toBe(1);
  });

  it("does not let a handshake sent before a contradiction restore supported", async () => {
    const memory = createMethodVersionsMemory();
    let release: (value: unknown) => void = () => undefined;
    const pending = methodVersionsSupport(
      memory,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    forgetMethodVersionsSupported(memory);
    release(SUPPORTED);

    expect(await pending).toBe("unknown");
    expect(memory.cached).toBeUndefined();
  });
});

describe("planMethodSelector", () => {
  it("sends an opaque id untouched, without asking", async () => {
    const { plan, asked } = await planned("not-an-id", "unsupported");
    expect(plan).toMatchObject({ send: "not-an-id", support: "unknown" });
    expect(plan?.reads).toBeUndefined();
    expect(asked).toBe(0);
  });

  it("asks about a bare id only when the result must say what it read", async () => {
    expect((await planned("mt_a", "supported", false)).asked).toBe(0);

    expect((await planned("mt_a", "supported")).plan).toMatchObject({
      send: "mt_a",
      reads: "latest",
    });
    expect((await planned("mt_a", "unsupported")).plan).toMatchObject({
      send: "mt_a",
      reads: "draft",
    });
    expect((await planned("mt_a", "unknown")).plan?.reads).toBeUndefined();
  });

  it("sends @draft bare where a bare id reads the draft, and as given elsewhere", async () => {
    expect((await planned("mt_a@draft", "unsupported")).plan).toMatchObject({
      send: "mt_a",
      reads: "draft",
      translated: true,
    });
    for (const support of ["supported", "unknown"] as const) {
      expect((await planned("mt_a@draft", support)).plan).toMatchObject({
        send: "mt_a@draft",
        reads: "draft",
        translated: false,
      });
    }
  });

  it("refuses @n where nothing can read a version by its id, before anything is sent", async () => {
    const refused = await planned("mt_a@3", "unsupported");
    expect(refused.error).toMatchObject({ class: "input_domain", location: "method_id" });
    expect(refused.error?.hint).toContain('"mt_a@3"');
    expect(refused.summary).toContain("Nothing was sent");

    for (const support of ["supported", "unknown"] as const) {
      expect((await planned("mt_a@3", support)).plan).toMatchObject({
        send: "mt_a@3",
        reads: 3,
      });
    }
  });
});

describe("what a tooling result says it read", () => {
  it("names the content, or says it could not tell", async () => {
    const sentence = async (value: string, support: MethodVersionsSupport) => {
      const { plan } = await planned(value, support);
      return plan === undefined ? undefined : methodContentSentence(plan, "validated");
    };

    expect(await sentence("mt_a", "supported")).toContain(
      "validated the latest published version of `mt_a`",
    );
    expect(await sentence("mt_a", "unsupported")).toContain(
      "this platform does not resolve versions yet, so a bare id reads the draft",
    );
    expect(await sentence("mt_a", "unknown")).toContain("could not ask the platform");
    expect(await sentence("mt_a@draft", "unsupported")).toContain("the bare id was sent");
    expect(await sentence("mt_a@3", "supported")).toBe("This validated version 3 of `mt_a`.");
    expect(await sentence("not-an-id", "supported")).toBeUndefined();
  });
});

describe("runContentReport", () => {
  it("reports the version a bare id ran, from the acknowledgement", async () => {
    const { plan } = await planned("mt_a", "unknown", false);
    const report = runContentReport(plan as SelectorPlan, 4);
    expect(report).toMatchObject({ ran: 4, proved: true });
    expect(report.sentence).toContain("version 4 of `mt_a`, the latest published");
  });

  it("reports the draft, and says why, when the acknowledgement names no version", async () => {
    const { plan } = await planned("mt_a", "unknown", false);
    const report = runContentReport(plan as SelectorPlan, undefined);
    expect(report).toMatchObject({ ran: "draft", proved: false });
    expect(report.sentence).toContain("names no version");
  });

  it("warns loudly when the run executes other content than was asked", async () => {
    const { plan } = await planned("mt_a@draft", "unsupported");
    const report = runContentReport(plan as SelectorPlan, 4);
    expect(report.ran).toBe(4);
    expect(report.sentence).toMatch(
      /^WARNING: this run executes version 4 of `mt_a`, NOT the draft/,
    );
    expect(report.sentence).toContain("`mt_a@draft`");
  });

  it("ignores an acknowledgement version it cannot read", async () => {
    const { plan } = await planned("mt_a@3", "supported");
    expect(runContentReport(plan as SelectorPlan, "3").proved).toBe(false);
    expect(runContentReport(plan as SelectorPlan, 0).proved).toBe(false);
    expect(runContentReport(plan as SelectorPlan, 3)).toMatchObject({ ran: 3, proved: true });
  });
});

describe("noteSelectorRefusal", () => {
  const unknownId: ToolError = {
    class: "input_domain",
    location: "method_id",
    message: "No such method.",
    hint: "Check the id.",
    retryable: false,
  };

  function refusal(code: string): ApiResponseError {
    return new ApiResponseError(
      "refused",
      "https://api-dev.pipelex.com/v1/validate",
      404,
      "Not Found",
      "{}",
      undefined,
      "refused",
      undefined,
      code,
    );
  }

  it("reads a refused suffix as a platform that may not resolve it, and forgets supported", async () => {
    const memory = createMethodVersionsMemory();
    noteMethodVersionsSupported(memory);
    const { plan } = await planned("mt_a@3", "supported");

    const noted = noteSelectorRefusal(
      refusal("not_found"),
      unknownId,
      plan as SelectorPlan,
      memory,
    );

    expect(noted.hint).toContain("may not resolve version suffixes yet");
    expect(memory.cached).toBeUndefined();
  });

  it("leaves alone a refusal that proves the suffix was read, and a bare id's", async () => {
    const memory = createMethodVersionsMemory();
    noteMethodVersionsSupported(memory);
    const { plan } = await planned("mt_a@3", "supported");

    expect(
      noteSelectorRefusal(
        refusal("method_version_not_found"),
        unknownId,
        plan as SelectorPlan,
        memory,
      ),
    ).toBe(unknownId);
    const bare = (await planned("mt_a", "supported")).plan as SelectorPlan;
    expect(noteSelectorRefusal(refusal("not_found"), unknownId, bare, memory)).toBe(unknownId);
    expect(memory.cached?.support).toBe("supported");
  });
});

describe("linkageSuffixError", () => {
  it("refuses a suffix beside files, and lets the bare id through", () => {
    expect(linkageSuffixError("mt_a")).toBeUndefined();
    expect(linkageSuffixError("not-an-id")).toBeUndefined();
    for (const value of ["mt_a@draft", "mt_a@2"]) {
      expect(linkageSuffixError(value)).toMatchObject({
        class: "input_domain",
        location: "method_id",
      });
    }
  });
});
