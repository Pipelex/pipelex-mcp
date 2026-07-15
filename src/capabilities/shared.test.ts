import { describe, expect, it } from "vitest";

import { ApiResponseError, ApiUnreachableError, PipelineRequestError } from "@pipelex/sdk";

import { buildApiConfig, classifyError, DEFAULT_API_URL, validateRequest } from "./shared.js";

describe("buildApiConfig", () => {
  it("defaults to the hosted API with no key", () => {
    const config = buildApiConfig({});

    expect(config.baseUrl).toBe(DEFAULT_API_URL);
    expect(config.apiKey).toBeUndefined();
  });

  it("reads the base URL and key from the environment", () => {
    const config = buildApiConfig({
      PIPELEX_BASE_URL: "http://localhost:8081",
      PIPELEX_API_KEY: "secret",
    });

    expect(config.baseUrl).toBe("http://localhost:8081");
    expect(config.apiKey).toBe("secret");
  });

  it("treats an empty key as absent", () => {
    const config = buildApiConfig({ PIPELEX_API_KEY: "" });

    expect(config.apiKey).toBeUndefined();
  });

  it("falls back to the hosted default when the base URL is blank", () => {
    const config = buildApiConfig({ PIPELEX_BASE_URL: "" });

    expect(config.baseUrl).toBe(DEFAULT_API_URL);
  });
});

describe("validateRequest", () => {
  it("rejects empty file URIs", () => {
    const errors = validateRequest([
      { content: 'domain = "demo"', uri: "" },
      { content: 'main_pipe = "main"', uri: "bundle.mthds" },
    ]);

    expect(errors.map((error) => error.location)).toEqual(["files[0].uri"]);
  });

  it("rejects an empty file list", () => {
    const errors = validateRequest([]);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.class).toBe("input_domain");
    expect(errors[0]?.location).toBe("files");
  });

  it("rejects empty and whitespace-only file content", () => {
    const errors = validateRequest([
      { content: "" },
      { content: "  \n\t " },
      { content: 'domain = "demo"' },
    ]);

    expect(errors.map((error) => error.location)).toEqual(["files[0].content", "files[1].content"]);
    expect(errors.every((error) => error.class === "input_domain")).toBe(true);
  });
});

describe("classifyError", () => {
  it("classifies unreachable API failures as config", () => {
    const error = classifyError(
      new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED"),
    );

    expect(error.class).toBe("config");
    expect(error.location).toBe("PIPELEX_BASE_URL");
  });

  it("classifies API request-shape responses as input_domain", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 422",
        `${DEFAULT_API_URL}/v1/validate`,
        422,
        "Unprocessable Entity",
        "{}",
        "validation_error",
        "Bad request body",
        undefined, // validationErrors
        undefined, // code
      ),
    );

    expect(error.class).toBe("input_domain");
    expect(error.location).toBe("files");
    expect(error.message).toBe("Bad request body");
  });

  it("applies route-specific bad-request texture when provided", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 422",
        `${DEFAULT_API_URL}/v1/build/inputs`,
        422,
        "Unprocessable Entity",
        "{}",
        "validation_error",
        "Unknown pipe: demo.missing",
        undefined, // validationErrors
        undefined, // code
      ),
      {
        route: "/v1/build/inputs",
        badRequest: { location: "pipe_ref", hint: "Pass a qualified domain.pipe_code." },
      },
    );

    expect(error.class).toBe("input_domain");
    expect(error.location).toBe("pipe_ref");
    expect(error.hint).toBe("Pass a qualified domain.pipe_code.");
  });

  it("names the route in the 404 hint", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 404",
        `${DEFAULT_API_URL}/v1/build/inputs`,
        404,
        "Not Found",
        "{}",
        "not_found",
        "Not found",
        undefined, // validationErrors
        undefined, // code
      ),
      { route: "/v1/build/inputs" },
    );

    expect(error.class).toBe("config");
    expect(error.location).toBe("PIPELEX_BASE_URL");
    expect(error.hint).toContain("/v1/build/inputs");
  });

  it("classifies auth responses as config", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 401",
        `${DEFAULT_API_URL}/v1/validate`,
        401,
        "Unauthorized",
        "{}",
        "unauthorized",
        "Missing key",
        undefined, // validationErrors
        undefined, // code
      ),
    );

    expect(error.class).toBe("config");
    expect(error.location).toBe("PIPELEX_API_KEY");
  });

  it("classifies API server failures as runtime", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 500",
        `${DEFAULT_API_URL}/v1/validate`,
        500,
        "Internal Server Error",
        "{}",
        "internal",
        "Server fault",
        undefined, // validationErrors
        undefined, // code
      ),
    );

    expect(error.class).toBe("runtime");
    expect(error.message).toBe("Server fault");
  });

  it("classifies client request construction failures as config", () => {
    const error = classifyError(new PipelineRequestError("Invalid API base URL"));

    expect(error.class).toBe("config");
    expect(error.location).toBe("PIPELEX_BASE_URL");
  });
});
