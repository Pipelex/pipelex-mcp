import { RejectedAssetError } from "@pipelex/sdk/upload";
import type { UploadGrant, UploadWithGrantOptions } from "@pipelex/sdk/upload";
import { describe, expect, it } from "vitest";

import { UPLOAD_GRANT_META_KEY } from "../capabilities/upload-grant-shape.js";
import {
  UploadFailure,
  clearChangedFields,
  uploadPickedFile,
  uploadTimeoutMs,
  valueAtFieldId,
  withoutField,
} from "./run-graph-upload.js";
import type { GrantRefusal, GrantRequest, GrantToolResponse } from "./run-graph-upload.js";

const GRANT: UploadGrant = {
  uri: "pipelex-storage://org_1/assets/0f1e2d3c.pdf",
  url: "https://pipelex-app-dev.s3.amazonaws.com/org_1/assets/0f1e2d3c.pdf?X-Amz-Signature=deadbeef",
  headers: { "If-None-Match": "*", "Content-Type": "application/pdf" },
  expires_at: "2026-09-23T15:00:00Z",
  max_bytes: 1_000,
};

const granted: GrantToolResponse = {
  structuredContent: { status: "ok" },
  meta: { [UPLOAD_GRANT_META_KEY]: GRANT },
};

function pdf(size = 125, name = "report.pdf", type = "application/pdf"): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe("uploadPickedFile", () => {
  it("asks for a grant with the file's name, type and size, sends it, and returns the reference", async () => {
    const requests: GrantRequest[] = [];
    const sent: { grant: UploadGrant; file: Blob; options: UploadWithGrantOptions }[] = [];
    const file = pdf();

    const uploaded = await uploadPickedFile(file, {
      requestGrant: async (request) => {
        requests.push(request);
        return granted;
      },
      send: async (grant, blob, options) => {
        sent.push({ grant, file: blob, options });
        return { uri: grant.uri };
      },
    });

    expect(requests).toEqual([
      { filename: "report.pdf", content_type: "application/pdf", size: 125 },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.grant).toEqual(GRANT);
    expect(sent[0]?.file).toBe(file);
    // The SDK sets no timeout of its own, so the view must bound the PUT.
    expect(sent[0]?.options.signal).toBeInstanceOf(AbortSignal);
    expect(uploaded).toEqual({ url: GRANT.uri, filename: "report.pdf", maxBytes: 1_000 });
  });

  it("omits a type the browser does not know", async () => {
    const requests: GrantRequest[] = [];

    await uploadPickedFile(pdf(3, "data.xyz", ""), {
      requestGrant: async (request) => {
        requests.push(request);
        return granted;
      },
      send: async (grant) => ({ uri: grant.uri }),
    });

    expect(requests).toEqual([{ filename: "data.xyz", size: 3 }]);
  });

  it("refuses a file over a cap it already knows, before any call", async () => {
    let called = false;

    const upload = uploadPickedFile(pdf(2 * 1024 * 1024), {
      requestGrant: async () => {
        called = true;
        return granted;
      },
      knownMaxBytes: 1024 * 1024,
    });

    await expect(upload).rejects.toThrow(UploadFailure);
    await expect(upload).rejects.toThrow('"report.pdf" is 2 MiB, over the 1 MiB');
    expect(called).toBe(false);
  });

  it("says why the console refused the grant", async () => {
    const upload = uploadPickedFile(pdf(), {
      requestGrant: async () => ({
        structuredContent: {
          status: "error",
          errors: [{ message: "Declared file size exceeds the 50 MiB limit." }],
        },
      }),
    });

    await expect(upload).rejects.toThrow(
      'Could not upload "report.pdf": Declared file size exceeds the 50 MiB limit.',
    );
    // The console answered, so the connector is fine: re-adding it fixes nothing.
    const failure: unknown = await upload.catch((err: unknown) => err);
    expect((failure as Error).message).not.toContain("re-add");
  });

  function refusedWith(error: GrantRefusal): Promise<unknown> {
    return uploadPickedFile(pdf(), {
      requestGrant: async () => ({ structuredContent: { status: "error", errors: [error] } }),
    }).catch((err: unknown) => err);
  }

  it("adds the hint to a refusal about the file, whose message alone says nothing useful", async () => {
    const failure = await refusedWith({
      class: "input_domain",
      message: "Request body failed validation. See `errors` for the per-field breakdown.",
      hint: "Pipelex storage refused the file's name, type or size as given. Rename the file, or pick another one.",
    });

    expect((failure as Error).message).toBe(
      'Could not upload "report.pdf": Request body failed validation. See `errors` for the per-field breakdown. ' +
        "Pipelex storage refused the file's name, type or size as given. Rename the file, or pick another one.",
    );
  });

  it("adds the reconnect hint to a rejected sign-in, ending the message with a full stop first", async () => {
    const failure = await refusedWith({
      class: "config",
      location: "authorization",
      message: "Unauthorized",
      hint: "reconnect the Pipelex connector and sign in again.",
    });

    expect((failure as Error).message).toBe(
      'Could not upload "report.pdf": Unauthorized. reconnect the Pipelex connector and sign in again.',
    );
  });

  it("adds the plan hint to a paywall refusal", async () => {
    const failure = await refusedWith({
      class: "config",
      kind: "paywall",
      message: "Subscription required.",
      hint: "The organization's plan does not cover this call.",
    });

    expect((failure as Error).message).toContain("does not cover this call");
  });

  it("keeps an operator's hint off the form", async () => {
    const failure = await refusedWith({
      class: "config",
      location: "PIPELEX_BASE_URL",
      message: "The Pipelex API could not be reached.",
      hint: "Start pipelex-api locally or set PIPELEX_BASE_URL.",
    });

    expect((failure as Error).message).toBe(
      'Could not upload "report.pdf": The Pipelex API could not be reached.',
    );
  });

  it("refuses to send when the answer carries no usable grant", async () => {
    let sent = false;

    const upload = uploadPickedFile(pdf(), {
      // A host that dropped the result's _meta on its way to the view.
      requestGrant: async () => ({ structuredContent: { status: "ok" } }),
      send: async (grant) => {
        sent = true;
        return { uri: grant.uri };
      },
    });

    await expect(upload).rejects.toThrow("carried no usable upload grant");
    expect(sent).toBe(false);
  });

  it("tells the user to re-add the connector when the host refuses the call", async () => {
    let sent = false;

    const upload = uploadPickedFile(pdf(), {
      // What ChatGPT answered, from its stored tool list, on a connector added
      // before the tool existed.
      requestGrant: async () => {
        throw new Error("MCP error -32000: MCP Resource not found");
      },
      send: async (grant) => {
        sent = true;
        return { uri: grant.uri };
      },
    });

    await expect(upload).rejects.toThrow(UploadFailure);
    await expect(upload).rejects.toThrow(
      'Could not upload "report.pdf": this app could not store the file here. ' +
        "Remove and re-add the Pipelex connector in your chat app's settings, then pick the file again. " +
        "You can also paste a link to the file into this field, or on ChatGPT attach the file to your message instead. " +
        "(MCP error -32000: MCP Resource not found)",
    );
    expect(sent).toBe(false);
  });

  it("says to pick the file again first when the call timed out, since a re-add fixes nothing", async () => {
    const upload = uploadPickedFile(pdf(), {
      // The view's own request timeout, as the MCP SDK words it.
      requestGrant: async () => {
        throw new Error("MCP error -32001: Request timed out");
      },
    });

    await expect(upload).rejects.toThrow(
      'Could not upload "report.pdf": the call to the console did not go through. ' +
        "Pick the file again; if it keeps failing, remove and re-add the Pipelex connector in your chat app's settings. " +
        "You can also paste a link to the file into this field, or on ChatGPT attach the file to your message instead. " +
        "(MCP error -32001: Request timed out)",
    );
  });

  it("gives the retry-first advice, with no detail, when the host's error carries no message", async () => {
    const upload = uploadPickedFile(pdf(), {
      requestGrant: async () => {
        throw new Error("");
      },
    });

    await expect(upload).rejects.toThrow(/Pick the file again;.*to your message instead\.$/);
  });

  it("relays storage's refusal as the SDK words it", async () => {
    const refusal = new RejectedAssetError(
      'Storage refused the upload of "report.pdf" (412 PreconditionFailed): this grant was already used.',
      "report.pdf",
      412,
      { code: "grant_used" },
    );

    const upload = uploadPickedFile(pdf(), {
      requestGrant: async () => granted,
      send: async () => {
        throw refusal;
      },
    });

    await expect(upload).rejects.toThrow(UploadFailure);
    await expect(upload).rejects.toThrow("this grant was already used");
  });

  it("says a stalled upload timed out", async () => {
    const upload = uploadPickedFile(pdf(), {
      requestGrant: async () => granted,
      send: async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    });

    await expect(upload).rejects.toThrow('The upload of "report.pdf" timed out after 61 seconds');
  });
});

describe("uploadTimeoutMs", () => {
  it("gives a minute to start and a second per 128 KiB", () => {
    expect(uploadTimeoutMs(0)).toBe(60_000);
    expect(uploadTimeoutMs(131_072)).toBe(61_000);
    // The platform's 50 MiB cap: 400 seconds on top of the minute.
    expect(uploadTimeoutMs(50 * 1024 * 1024)).toBe(460_000);
  });
});

describe("per-field upload errors", () => {
  const failures = {
    cv: 'Could not upload "cv.pdf": storage refused it.',
    job_offer: 'Could not upload "offer.pdf": storage refused it.',
  };

  it("reads a field's value down the dotted path the panel writes, list indices included", () => {
    const values = { applicant: { photo: { url: "https://a/p.png" } }, documents: ["x", "y"] };

    expect(valueAtFieldId(values, "applicant.photo")).toEqual({ url: "https://a/p.png" });
    expect(valueAtFieldId(values, "documents.1")).toBe("y");
    expect(valueAtFieldId(values, "missing.path")).toBeUndefined();
    // An inherited key is not a field's value.
    expect(valueAtFieldId(values, "constructor")).toBeUndefined();
  });

  it("keeps a field's failure while another field is edited or uploaded", () => {
    const previous = { cv: undefined, job_offer: undefined, note: "a" };
    const next = { ...previous, note: "ab", job_offer: { url: "pipelex-storage://o/j.pdf" } };

    expect(clearChangedFields({ cv: failures.cv }, previous, next)).toEqual({ cv: failures.cv });
  });

  it("drops the failure of a field the user fixed by pasting a link", () => {
    const previous = { cv: undefined, job_offer: undefined };
    const next = { ...previous, cv: { url: "https://example.com/cv.pdf" } };

    expect(clearChangedFields(failures, previous, next)).toEqual({
      job_offer: failures.job_offer,
    });
  });

  it("keeps each field's failure when two uploads fail", () => {
    let errors = withoutField({}, "cv");
    errors = { ...errors, cv: failures.cv };
    errors = { ...withoutField(errors, "job_offer"), job_offer: failures.job_offer };

    expect(errors).toEqual(failures);
  });

  it("drops only the retried field's failure", () => {
    expect(withoutField(failures, "cv")).toEqual({ job_offer: failures.job_offer });
  });

  it("returns the same object when nothing is dropped, so React sees no change", () => {
    const values = { cv: undefined };

    expect(clearChangedFields(failures, values, { ...values })).toBe(failures);
    expect(withoutField(failures, "note")).toBe(failures);
  });

  it("treats a rebuilt but equal value as unchanged", () => {
    const previous = { applicant: { photo: { url: "https://a/p.png" }, name: "A" } };
    const next = { applicant: { photo: { url: "https://a/p.png" }, name: "Ab" } };

    expect(clearChangedFields({ "applicant.photo": "failed" }, previous, next)).toEqual({
      "applicant.photo": "failed",
    });
  });
});
