import { ApiResponseError } from "@pipelex/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  METHOD_VERSIONS_HANDSHAKE_MS,
  METHOD_VERSIONS_TTL_MS,
  createMethodVersionsMemories,
  createMethodVersionsMemory,
  forgetMethodVersionsSupported,
  linkageSuffixError,
  methodContentSentence,
  methodVersionsMemoryFor,
  methodVersionsOf,
  methodVersionsSupport,
  noteMethodVersionsSupported,
  noteSelectorRefusal,
  planById,
  planMethodSelector,
  readMethodSelector,
  runContentReport,
  versionReaderOf,
} from "./method-versions.js";
import type {
  MethodVersionReport,
  MethodVersionsSupport,
  SelectorPlan,
} from "./method-versions.js";
import { problemOf } from "./shared.js";

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
): Promise<{ plan: SelectorPlan; asked: number; reads: MethodVersionReport | undefined }> {
  let asked = 0;
  const plan = planMethodSelector(
    value,
    async () => {
      asked += 1;
      return support;
    },
    { needBareReport },
  );
  return { plan, asked, reads: await plan.reads };
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

  it("asks again once a handshake has missed its deadline, while that request still hangs", async () => {
    vi.useFakeTimers();
    const memory = createMethodVersionsMemory();
    let calls = 0;
    const read = (): Promise<unknown> => {
      calls += 1;
      // The first request hangs well past the deadline; the platform then recovers.
      return calls === 1 ? new Promise(() => undefined) : Promise.resolve(UNSUPPORTED);
    };

    const first = methodVersionsSupport(memory, read);
    await vi.advanceTimersByTimeAsync(METHOD_VERSIONS_HANDSHAKE_MS);
    expect(await first).toBe("unknown");

    // Holding the timed-out answer until the request ends would serve
    // `unknown` to every call meanwhile: a cached `unknown` in all but name.
    expect(await methodVersionsSupport(memory, read)).toBe("unsupported");
    expect(calls).toBe(2);
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

    await vi.advanceTimersByTimeAsync(METHOD_VERSIONS_TTL_MS - 1_000);
    expect(await methodVersionsSupport(memory, reader.read)).toBe("supported");
    expect(reader.calls()).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(await methodVersionsSupport(memory, reader.read)).toBe("supported");
    expect(reader.calls()).toBe(2);
  });

  it("never caches unsupported, since it is the answer that goes stale dangerously", async () => {
    const memory = createMethodVersionsMemory();
    const reader = counting(UNSUPPORTED);

    expect(await methodVersionsSupport(memory, reader.read)).toBe("unsupported");
    expect(await methodVersionsSupport(memory, reader.read)).toBe("unsupported");
    expect(reader.calls()).toBe(2);
    expect(memory.cached).toBeUndefined();
  });

  it("asks again the moment the platform starts resolving selectors", async () => {
    // The transition a cached `unsupported` would have hidden: the next call
    // reads the new answer, so a bare id is never reported as the draft after it.
    const memory = createMethodVersionsMemory();
    let answer: unknown = UNSUPPORTED;
    const client = { version: async (): Promise<unknown> => answer };

    const before = planById("mt_a", memory, client, { needBareReport: true });
    expect(await before.reads).toBe("draft");

    answer = SUPPORTED;
    const after = planById("mt_a", memory, client, { needBareReport: true });
    expect(await after.reads).toBe("latest");
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

describe("the workshop's memory, one per base URL", () => {
  it("keeps one memory per base URL and none without a shared memory", () => {
    const memories = createMethodVersionsMemories();
    const one = methodVersionsMemoryFor(memories, "https://one.pipelex.test");

    expect(methodVersionsMemoryFor(memories, "https://one.pipelex.test")).toBe(one);
    expect(methodVersionsMemoryFor(memories, "https://two.pipelex.test")).not.toBe(one);
    expect(methodVersionsMemoryFor(undefined, "https://one.pipelex.test")).toBeUndefined();
    expect(
      methodVersionsOf({ baseUrl: "https://one.pipelex.test", methodVersions: memories }),
    ).toBe(one);
  });

  it("never answers for one platform with another's cached supported", async () => {
    // A session whose base URL moves, because the key saved in the home `.env`
    // came with another one, must ask the new platform rather than believe
    // the old one's ten-minute answer.
    const memories = createMethodVersionsMemories();
    const one = counting(SUPPORTED);
    const two = counting(UNSUPPORTED);

    expect(
      await methodVersionsSupport(methodVersionsMemoryFor(memories, "https://one.test"), one.read),
    ).toBe("supported");
    expect(
      await methodVersionsSupport(methodVersionsMemoryFor(memories, "https://two.test"), two.read),
    ).toBe("unsupported");
    expect(two.calls()).toBe(1);

    // The first platform's answer is still its own.
    expect(
      await methodVersionsSupport(methodVersionsMemoryFor(memories, "https://one.test"), one.read),
    ).toBe("supported");
    expect(one.calls()).toBe(1);
  });
});

describe("planMethodSelector", () => {
  it("sends an opaque id untouched, without asking", async () => {
    const { plan, asked, reads } = await planned("not-an-id", "unsupported");
    expect(plan).toMatchObject({ send: "not-an-id" });
    expect(reads).toBeUndefined();
    expect(asked).toBe(0);
  });

  it("asks about a bare id only when the result must say what it read", async () => {
    expect((await planned("mt_a", "supported", false)).asked).toBe(0);

    expect(await planned("mt_a", "supported")).toMatchObject({
      plan: { send: "mt_a" },
      reads: "latest",
    });
    expect(await planned("mt_a", "unsupported")).toMatchObject({
      plan: { send: "mt_a" },
      reads: "draft",
    });
    expect((await planned("mt_a", "unknown")).reads).toBeUndefined();
  });

  it("plans a bare id at once, and settles what it read beside the request", async () => {
    // Nothing sent depends on the platform's answer, so the plan does not wait
    // for it: awaiting it first cost every by-id call a handshake, up to its
    // deadline on a platform that never caches its answer.
    let answer: (support: MethodVersionsSupport) => void = () => undefined;
    const plan = planMethodSelector(
      "mt_a",
      () =>
        new Promise<MethodVersionsSupport>((resolve) => {
          answer = resolve;
        }),
      { needBareReport: true },
    );
    expect(plan.send).toBe("mt_a");
    let settled = false;
    void plan.reads.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    answer("unsupported");
    expect(await plan.reads).toBe("draft");
  });

  it("settles a bare id's answer as unknown when asking fails, never rejecting", async () => {
    const plan = planMethodSelector("mt_a", () => Promise.reject(new Error("down")), {
      needBareReport: true,
    });
    expect(await plan.reads).toBeUndefined();
  });

  it("sends every suffix as it was given, on every platform, without asking", async () => {
    // Rewritten by a stale answer, @draft sent as the bare id would read or
    // run the latest published version; a platform that cannot read a suffix
    // refuses it instead, and its refusal says so.
    for (const support of ["supported", "unsupported", "unknown"] as const) {
      expect(await planned("mt_a@draft", support)).toMatchObject({
        plan: { send: "mt_a@draft" },
        reads: "draft",
        asked: 0,
      });
      expect(await planned("mt_a@3", support)).toMatchObject({
        plan: { send: "mt_a@3" },
        reads: 3,
        asked: 0,
      });
    }
  });
});

describe("what a tooling result says it read", () => {
  it("names the content, or says it could not tell", async () => {
    const sentence = async (value: string, support: MethodVersionsSupport) => {
      const { plan, reads } = await planned(value, support);
      return methodContentSentence(plan, reads, "validated");
    };

    expect(await sentence("mt_a", "supported")).toContain(
      "validated the latest published version of `mt_a`",
    );
    expect(await sentence("mt_a", "unsupported")).toContain(
      "this platform does not resolve versions yet, so a bare id reads the draft",
    );
    expect(await sentence("mt_a", "unknown")).toContain("could not ask the platform");
    expect(await sentence("mt_a@draft", "unsupported")).toBe("This validated the draft of `mt_a`.");
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
    expect(report).toMatchObject({ ran: "draft", proved: false, disproved: true });
    expect(report.sentence).toContain("names no version");
  });

  it("reports an accepted suffix as what it named, acknowledged or not", async () => {
    // A platform that does not resolve suffixes refuses one before a run
    // exists, so an accepted one ran what it named.
    const draft = runContentReport((await planned("mt_a@draft", "unknown")).plan, undefined);
    expect(draft).toMatchObject({ ran: "draft", proved: false });
    expect(draft.disproved).toBeUndefined();
    expect(draft.sentence).toBe("It runs the draft of `mt_a`.");
    const third = runContentReport((await planned("mt_a@3", "unknown")).plan, undefined);
    expect(third).toMatchObject({ ran: 3, proved: false });
    expect(third.disproved).toBeUndefined();
  });

  it("ignores an acknowledgement version it cannot read", async () => {
    const { plan } = await planned("mt_a@3", "supported");
    expect(runContentReport(plan as SelectorPlan, "3").proved).toBe(false);
    expect(runContentReport(plan as SelectorPlan, 0).proved).toBe(false);
    expect(runContentReport(plan as SelectorPlan, 3)).toMatchObject({ ran: 3, proved: true });
  });
});

describe("noteSelectorRefusal", () => {
  const START_URL = "https://api-dev.pipelex.com/v1/start";

  /** A platform refusal carrying its problem document, as the SDK throws it. */
  function refusal(
    status: number,
    problem: { code: string; title: string; detail: string; domain: string } & Record<
      string,
      unknown
    >,
  ): ApiResponseError {
    return new ApiResponseError(
      `HTTP ${status}`,
      START_URL,
      status,
      "Refused",
      JSON.stringify({
        type: `https://docs.pipelex.com/errors/${problem.code}`,
        status,
        retry: "no",
        next_step: { kind: "change_input", detail: "Change the call." },
        ...problem,
      }),
    );
  }

  /** The catalog's miss of `resource`: a method, or a version of one. */
  const missOf = (resource: "method" | "version") =>
    refusal(404, {
      code: "pipelex.catalog.not_found",
      title: "The saved method does not exist",
      detail: `No such ${resource} of mt_a in the organization's catalog.`,
      domain: "input",
      params: { resource, method_id: "mt_a", ...(resource === "version" ? { version: 3 } : {}) },
    });

  /**
   * How a platform that predates problem documents refuses the `@` on its run
   * route, by its body pattern: the SDK cannot read that body, so the problem
   * is `client.response_unreadable` at 422, naming no field.
   */
  const patternRefusal = () =>
    new ApiResponseError(
      "HTTP 422",
      START_URL,
      422,
      "Unprocessable Entity",
      JSON.stringify({
        code: "validation_failed",
        message: "Invalid request.",
        errors: [{ field: "method_id", code: "string_pattern_mismatch" }],
      }),
    );

  /** What every caller passes: the problem the error relays. */
  async function noted(
    err: ApiResponseError,
    plan: SelectorPlan,
    memory: ReturnType<typeof createMethodVersionsMemory> | undefined,
  ) {
    const problem = problemOf(err);
    return { problem, noted: await noteSelectorRefusal(problem, plan, memory) };
  }

  it("reads a refusal of the @ it cannot read by the platform's answer, and never as proof either way", async () => {
    const fresh = createMethodVersionsMemory();
    const old = planById(
      "mt_a@draft",
      fresh,
      { version: async () => UNSUPPORTED },
      { needBareReport: true },
    );
    const said = await noted(patternRefusal(), old, fresh);
    // The SDK's problem stands; the note closes this server's message.
    expect(said.noted).toMatchObject({
      code: "client.response_unreadable",
      domain: said.problem.domain,
      retry: said.problem.retry,
      params: { status: 422 },
    });
    expect(said.noted.message).toContain(
      "this platform refused `mt_a@draft` because it does not resolve version suffixes yet",
    );
    expect(said.noted.message).toContain("a bare `mt_a` reads the draft");

    // Where the memory says the platform resolves suffixes, the refusal is
    // left as it is, and an answer the SDK could not read contradicts nothing.
    const memory = createMethodVersionsMemory();
    noteMethodVersionsSupported(memory);
    const { plan } = await planned("mt_a@draft", "unknown");
    const kept = await noted(patternRefusal(), plan, memory);
    expect(kept.noted).toBe(kept.problem);
    expect(memory.cached?.support).toBe("supported");
  });

  it("reads a miss by what the platform answers: plain where it resolves suffixes, explained where it does not", async () => {
    const memory = createMethodVersionsMemory();
    noteMethodVersionsSupported(memory);
    const resolving = planById("mt_a@3", memory, {}, { needBareReport: true });
    // A platform that resolves suffixes misses a method that does not exist
    // the same way: the miss contradicts nothing, and the memory stays.
    const plain = await noted(missOf("method"), resolving, memory);
    expect(plain.noted).toBe(plain.problem);
    expect(memory.cached?.support).toBe("supported");

    const fresh = createMethodVersionsMemory();
    const old = planById(
      "mt_a@3",
      fresh,
      { version: async () => UNSUPPORTED },
      { needBareReport: true },
    );
    // A 404 with no problem document, as such a platform answers, is read as
    // the SDK reads it: request.not_found.
    const oldMiss = new ApiResponseError(
      "HTTP 404",
      START_URL,
      404,
      "Not Found",
      JSON.stringify({ code: "not_found", message: "Method not found." }),
    );
    const explained = await noted(oldMiss, old, fresh);
    expect(explained.noted).toMatchObject({ code: "request.not_found" });
    expect(explained.noted.message).toContain(
      "If `mt_a` exists, this platform refused `mt_a@3` because it does not resolve version suffixes yet",
    );

    const silent = planById("mt_a@3", createMethodVersionsMemory(), {}, { needBareReport: true });
    const hedged = await noted(missOf("method"), silent, undefined);
    expect(hedged.noted).toMatchObject({
      code: "pipelex.catalog.not_found",
      detail: "No such method of mt_a in the organization's catalog.",
    });
    expect(hedged.noted.message).toContain("may have refused `mt_a@3`");
  });

  it("takes a missed version as proof, and leaves its problem as it is", async () => {
    const memory = createMethodVersionsMemory();
    const { plan } = await planned("mt_a@3", "unknown");

    const said = await noted(missOf("version"), plan, memory);

    expect(said.noted).toBe(said.problem);
    expect(memory.cached?.support).toBe("supported");
  });

  it("names the method's own draft when a bare id meets a never-published method, and takes it as proof", async () => {
    const memory = createMethodVersionsMemory();
    const { plan } = await planned("mt_a", "unknown", false);

    const said = await noted(
      refusal(409, {
        code: "pipelex.catalog.not_published",
        title: "The saved method has no published version",
        detail: "mt_a has no published version.",
        domain: "input",
        params: { method_id: "mt_a" },
      }),
      plan,
      memory,
    );

    expect(said.noted).toMatchObject({
      code: "pipelex.catalog.not_published",
      domain: "input",
      retry: "no",
      detail: "mt_a has no published version.",
    });
    expect(said.noted.message).toContain("`mt_a@draft`");
    expect(memory.cached?.support).toBe("supported");
  });

  it("reads nothing about suffixes into a refusal about something else, or a bare id's miss", async () => {
    const memory = createMethodVersionsMemory();
    noteMethodVersionsSupported(memory);
    const { plan } = await planned("mt_a@draft", "unknown");
    for (const err of [
      refusal(409, {
        code: "pipelex.catalog.being_deleted",
        title: "The saved method is being deleted",
        detail: "mt_a is being deleted.",
        domain: "input",
      }),
      refusal(422, {
        code: "request.invalid",
        title: "The request is invalid",
        detail: "The inputs are missing.",
        domain: "input",
        location: { field: "inputs" },
      }),
    ]) {
      const said = await noted(err, plan, memory);
      expect(said.noted).toBe(said.problem);
    }
    const bare = (await planned("mt_a", "supported")).plan;
    const bareMiss = await noted(missOf("method"), bare, memory);
    expect(bareMiss.noted).toBe(bareMiss.problem);
    expect(memory.cached?.support).toBe("supported");
  });
});

describe("linkageSuffixError", () => {
  it("refuses a suffix beside files, and lets the bare id through", () => {
    expect(linkageSuffixError("mt_a")).toBeUndefined();
    expect(linkageSuffixError("not-an-id")).toBeUndefined();
    for (const value of ["mt_a@draft", "mt_a@2"]) {
      const problem = linkageSuffixError(value);
      expect(problem).toMatchObject({
        code: "client.argument_invalid",
        domain: "input",
        params: { argument: "method_id", reason: "suffix_on_linkage" },
        location: { field: "method_id" },
      });
      expect(problem?.message).toContain('Pass method_id "mt_a"');
    }
    expect(linkageSuffixError("mt_a@2", "method_dir")?.message).toContain("drop method_dir");
  });
});
