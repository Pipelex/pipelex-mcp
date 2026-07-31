import { PipelexApiClient, RejectedAssetError } from "@pipelex/sdk";
import { describe, expect, it, vi } from "vitest";

import { uploadClient } from "./attachments.js";
import { prepareClient } from "./prepare.js";
import {
  MAX_UPLOAD_BYTES,
  SizeGuardedPipelexApiClient,
  base64DecodedLength,
  formatMib,
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

describe("both upload paths are wired to the guard", () => {
  it("mthds_prepare_inputs (workshop) constructs a size-guarded client", () => {
    expect(prepareClient({ baseUrl: "https://api.pipelex.test" })).toBeInstanceOf(
      SizeGuardedPipelexApiClient,
    );
  });

  it("mthds_upload_attachments constructs a size-guarded client", () => {
    expect(uploadClient({ baseUrl: "https://api.pipelex.test" })).toBeInstanceOf(
      SizeGuardedPipelexApiClient,
    );
  });

  it("still honours an injected test client", () => {
    const fake = { uploadFile: () => Promise.reject(new Error("unused")) };
    expect(uploadClient({ baseUrl: "https://api.pipelex.test", client: fake })).toBe(fake);
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
    // Reported as the same 413 the gateway would have produced, so every
    // downstream classifier keeps working unchanged.
    expect((error as RejectedAssetError).status).toBe(413);
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
