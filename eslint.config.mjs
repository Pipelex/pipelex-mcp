import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

import pipelexApiBoundary from "./eslint-rules/pipelex-api-boundary.mjs";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["**/dist/**", "coverage/**", "**/.skybridge/**", "**/.vercel/**"],
  },
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
        fetch: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        DOMException: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "no-console": "error",
    },
  },
  // Every call to the Pipelex API goes through `createPipelexApiClient`, which
  // names this server in the User-Agent (docs/client-identification.md).
  {
    files: [
      "packages/*/src/**/*.{ts,tsx}",
      "packages/*/scripts/**/*.{ts,mjs}",
      "scripts/**/*.{ts,mjs}",
      "tests/**/*.ts",
    ],
    plugins: { pipelex: pipelexApiBoundary },
    rules: {
      "pipelex/sdk-client-factory": "error",
      "pipelex/no-raw-fetch": "error",
    },
  },
  // The factory itself.
  {
    files: ["packages/core/src/capabilities/shared.ts"],
    rules: { "pipelex/sdk-client-factory": "off" },
  },
  // The one sanctioned subclass, which the factory constructs.
  {
    files: ["packages/core/src/capabilities/upload-ceiling.ts"],
    rules: { "pipelex/sdk-client-factory": ["error", { allowExtends: true }] },
  },
  // The attachment fetch boundary fetches a host-supplied third-party link,
  // whose User-Agent the spec says must not change.
  {
    files: ["packages/core/src/capabilities/attachment-fetch.ts"],
    rules: { "pipelex/no-raw-fetch": "off" },
  },
  // The bundle boot check fetches the console it has just started on loopback,
  // never the Pipelex API.
  {
    files: ["packages/console/scripts/check-server-bundle.mjs"],
    rules: { "pipelex/no-raw-fetch": "off" },
  },
  // The graph page's live check fetches the public CDN files the page pins,
  // never the Pipelex API.
  {
    files: ["packages/core/src/capabilities/graph-page.e2e.ts"],
    rules: { "pipelex/no-raw-fetch": "off" },
  },
  // Unit tests build clients directly to test them, and stub the global fetch.
  {
    files: ["**/*.test.ts"],
    rules: { "pipelex/sdk-client-factory": "off", "pipelex/no-raw-fetch": "off" },
  },
];
