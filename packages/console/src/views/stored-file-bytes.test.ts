import { describe, expect, it, vi } from "vitest";

import { INLINE_SAVE_MAX_BYTES, base64Of, storedFileReader } from "./stored-file-bytes.js";

const STORED =
  "https://pipelex-app-dev.s3.amazonaws.com/org/runs/r/generated/a.png?X-Amz-Signature=abc";
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function answering(response: Response) {
  return vi.fn<typeof fetch>().mockResolvedValue(response);
}

describe("storedFileReader", () => {
  it("reads a stored file's bytes as base64, from the link unchanged", async () => {
    const fetchImpl = answering(new Response(PNG_HEAD));
    expect(await storedFileReader(fetchImpl)(STORED)).toBe("iVBORw0KGgo=");
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(STORED);
  });

  it("reads nothing from a link to anywhere but an app bucket", async () => {
    const fetchImpl = answering(new Response(PNG_HEAD));
    expect(await storedFileReader(fetchImpl)("https://example.com/a.png")).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads nothing from a refused link", async () => {
    const fetchImpl = answering(new Response("AccessDenied", { status: 403 }));
    expect(await storedFileReader(fetchImpl)(STORED)).toBeUndefined();
  });

  it("reads nothing when the fetch itself fails, as a CORS refusal does", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await storedFileReader(fetchImpl)(STORED)).toBeUndefined();
  });

  it("leaves a file past the cap unread when its declared length says so", async () => {
    const response = new Response(PNG_HEAD, {
      headers: { "content-length": String(INLINE_SAVE_MAX_BYTES + 1) },
    });
    const read = vi.spyOn(response, "arrayBuffer");
    expect(await storedFileReader(answering(response))(STORED)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("drops a file past the cap that declared no length", async () => {
    const response = new Response(PNG_HEAD);
    vi.spyOn(response, "arrayBuffer").mockResolvedValue(new ArrayBuffer(INLINE_SAVE_MAX_BYTES + 1));
    expect(await storedFileReader(answering(response))(STORED)).toBeUndefined();
  });
});

describe("base64Of", () => {
  it("encodes bytes across the slices it builds the string in", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 3).map((_, index) => index % 256);
    expect(base64Of(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
