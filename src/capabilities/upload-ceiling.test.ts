import { PipelexApiClient, RejectedAssetError, UploadTransportError } from "@pipelex/sdk";
import { describe, expect, it, vi } from "vitest";

import { prepareClient } from "./prepare.js";
import { problemOf } from "./shared.js";
import {
  MAX_UPLOAD_BYTES,
  SizeGuardedPipelexApiClient,
  base64DecodedLength,
  formatMib,
  formatSizeOverLimit,
} from "./upload-ceiling.js";

describe("MAX_UPLOAD_BYTES", () => {
  it("sits just under the 7.5 MiB wall measured against the live API", () => {
    // Measured 2026-07-31: 7.4 MiB uploads, 7.5 MiB is a 413. The wall is AWS
    // API Gateway's 10 MiB request quota divided by base64's 4/3 inflation —
    // NOT the app-level 50 MiB MAX_UPLOAD_MIB, which is unreachable through
    // the public gateway.
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(7.4 * 1024 * 1024);
    expect(MAX_UPLOAD_BYTES).toBeLessThan(7.5 * 1024 * 1024);
  });

  it("keeps the base64 payload plus its envelope inside the gateway quota", () => {
    const base64Length = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;
    expect(base64Length).toBeLessThan(10 * 1024 * 1024);
  });
});

describe("base64DecodedLength", () => {
  it("matches the real decoded length across padding cases", () => {
    for (const size of [0, 1, 2, 3, 4, 100, 1023, 4096]) {
      const bytes = new Uint8Array(size);
      const encoded = Buffer.from(bytes).toString("base64");
      expect(base64DecodedLength(encoded)).toBe(size);
    }
  });
});

describe("formatMib", () => {
  it("renders a limit a caller can act on", () => {
    expect(formatMib(7 * 1024 * 1024)).toBe("7.0 MiB");
    expect(formatMib(MAX_UPLOAD_BYTES)).toBe("7.5 MiB");
  });
});

describe("formatSizeOverLimit", () => {
  it("prints MiB when the size and the limit read apart", () => {
    expect(formatSizeOverLimit(9 * 1024 * 1024, MAX_UPLOAD_BYTES)).toEqual({
      size: "9.0 MiB",
      limit: "7.5 MiB",
    });
  });

  it("never prints a size equal to the limit it exceeds: exact bytes when MiB would match", () => {
    const shown = formatSizeOverLimit(MAX_UPLOAD_BYTES + 1, MAX_UPLOAD_BYTES);

    expect(shown.size).not.toBe(shown.limit);
    expect(shown).toEqual({
      size: `${(MAX_UPLOAD_BYTES + 1).toLocaleString("en-US")} bytes`,
      limit: `${MAX_UPLOAD_BYTES.toLocaleString("en-US")} bytes`,
    });
  });
});

describe("the upload path is wired to the guard", () => {
  it("mthds_prepare_inputs constructs a size-guarded client", () => {
    expect(prepareClient({ baseUrl: "https://api.pipelex.test" })).toBeInstanceOf(
      SizeGuardedPipelexApiClient,
    );
  });
});

describe("SizeGuardedPipelexApiClient", () => {
  it("refuses an oversize upload locally, before spending a round-trip", async () => {
    const client = new SizeGuardedPipelexApiClient({ baseUrl: "https://api.pipelex.test" });
    const wire = vi
      .spyOn(PipelexApiClient.prototype, "upload")
      .mockRejectedValue(new Error("the wire must not be touched"));

    const oversize = "A".repeat(Math.ceil(((MAX_UPLOAD_BYTES + 1024) / 3) * 4));

    await expect(
      client.upload({ filename: "huge.pdf", data: oversize, content_type: "application/pdf" }),
    ).rejects.toBeInstanceOf(RejectedAssetError);
    expect(wire).not.toHaveBeenCalled();

    wire.mockRestore();
  });

  it("names the real limit and the offending size, where the server's 413 cannot", async () => {
    const client = new SizeGuardedPipelexApiClient({ baseUrl: "https://api.pipelex.test" });
    const oversize = "A".repeat(Math.ceil(((9 * 1024 * 1024) / 3) * 4));

    const error = await client
      .upload({ filename: "huge.pdf", data: oversize, content_type: "application/pdf" })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RejectedAssetError);
    expect((error as RejectedAssetError).message).toContain("huge.pdf");
    expect((error as RejectedAssetError).message).toContain("9.0 MiB");
    expect((error as RejectedAssetError).message).toContain(formatMib(MAX_UPLOAD_BYTES));
    // Reported as the same 413 the gateway would have produced, with the
    // reason the SDK gives a real one, and the problem of a refusal made
    // before anything was sent.
    expect((error as RejectedAssetError).status).toBe(413);
    expect((error as RejectedAssetError).reason).toBe("too_large");
    expect((error as RejectedAssetError).problem).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      retry: "no",
      params: { argument: "inputs", reason: "upload_too_large" },
      location: { field: "inputs" },
    });
  });

  it("names an upload just over the limit apart from the limit itself", async () => {
    const client = new SizeGuardedPipelexApiClient({ baseUrl: "https://api.pipelex.test" });
    // A whole number of base64 quanta, so the decoded length is exact.
    const decoded = MAX_UPLOAD_BYTES + 3 - (MAX_UPLOAD_BYTES % 3);
    const justOver = "A".repeat((decoded / 3) * 4);

    const error = await client
      .upload({ filename: "edge.pdf", data: justOver, content_type: "application/pdf" })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RejectedAssetError);
    expect((error as RejectedAssetError).message).toBe(
      `"edge.pdf" is ${decoded.toLocaleString("en-US")} bytes, over the ${MAX_UPLOAD_BYTES.toLocaleString("en-US")} bytes Pipelex upload limit.`,
    );
  });

  it("reaches the caller of uploadFile as a refused argument, not as a retryable transport fault", async () => {
    // Every real caller uploads through `uploadFile`, which wraps what
    // `upload()` throws in an UploadTransportError; read as that, an
    // oversize file told the agent to retry. The wrapper carries its
    // cause's problem.
    const client = new SizeGuardedPipelexApiClient({ baseUrl: "https://api.pipelex.test" });
    const wire = vi
      .spyOn(PipelexApiClient.prototype, "upload")
      .mockRejectedValue(new Error("the wire must not be touched"));

    const error = await client
      .uploadFile(new Uint8Array(9 * 1024 * 1024), { filename: "huge.pdf" })
      .catch((err: unknown) => err);

    expect(wire).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(UploadTransportError);
    expect((error as UploadTransportError).cause).toBeInstanceOf(RejectedAssetError);
    expect(problemOf(error)).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      retry: "no",
      location: { field: "inputs" },
      message: expect.stringContaining(
        `over the ${formatMib(MAX_UPLOAD_BYTES)} Pipelex upload limit`,
      ),
    });

    wire.mockRestore();
  });

  it("lets an upload at the ceiling through to the wire", async () => {
    const client = new SizeGuardedPipelexApiClient({ baseUrl: "https://api.pipelex.test" });
    const wire = vi
      .spyOn(PipelexApiClient.prototype, "upload")
      .mockResolvedValue({ uri: "pipelex-storage://asset/ok", filename: "ok.pdf" });

    const atCap = Buffer.from(new Uint8Array(MAX_UPLOAD_BYTES)).toString("base64");
    await expect(
      client.upload({ filename: "ok.pdf", data: atCap, content_type: "application/pdf" }),
    ).resolves.toEqual({ uri: "pipelex-storage://asset/ok", filename: "ok.pdf" });
    expect(wire).toHaveBeenCalledOnce();

    wire.mockRestore();
  });
});
