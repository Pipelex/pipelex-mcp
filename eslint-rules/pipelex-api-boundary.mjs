/**
 * Lint rules that keep every call this server makes to the Pipelex API identified.
 *
 * The server names itself to the platform with a `User-Agent`
 * (`docs/client-identification.md`), which `@pipelex/sdk` builds from the
 * `appInfo` its client is constructed with. One factory passes it —
 * `createPipelexApiClient` in `src/capabilities/shared.ts` — and these rules
 * make that factory the only way to reach the API:
 *
 * - `pipelex/sdk-client-factory`: an SDK client (`PipelexApiClient`,
 *   `MthdsApiClient`, however imported) or any class whose name ends in
 *   `ApiClient` (a local subclass such as `SizeGuardedPipelexApiClient`) is
 *   constructed only by the factory. Subclassing an SDK client is refused too,
 *   unless the file is configured with `{ allowExtends: true }`.
 * - `pipelex/no-raw-fetch`: a bare `fetch(…)` (or `globalThis.fetch(…)`) is
 *   refused outside the files that fetch third-party links, because a raw
 *   request to the API would carry the runtime's default `User-Agent` and be
 *   counted as `raw_http`.
 *
 * The files each rule exempts are declared in `eslint.config.mjs`.
 */

const SDK_MODULES = new Set(["@pipelex/sdk", "mthds"]);
const SDK_CLIENTS = new Set(["PipelexApiClient", "MthdsApiClient"]);
const CLIENT_NAME = /ApiClient$/;
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global"]);

/** @type {import('eslint').Rule.RuleModule} */
const sdkClientFactory = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Construct a Pipelex API client only through createPipelexApiClient, which passes appInfo.",
    },
    schema: [
      {
        type: "object",
        properties: { allowExtends: { type: "boolean" } },
        additionalProperties: false,
      },
    ],
    messages: {
      construct:
        "`{{name}}` is built only by `createPipelexApiClient` (`src/capabilities/shared.ts`), which passes the shell's `appInfo` so every request carries the pipelex-mcp User-Agent. Pass a subclass as its second argument. See docs/client-identification.md.",
      extend:
        "Subclassing `{{name}}` is allowed only where the lint config says so. Add the subclass there and construct it through `createPipelexApiClient`. See docs/client-identification.md.",
    },
  },
  create(context) {
    const allowExtends = context.options[0]?.allowExtends === true;
    // Local name -> imported client name, so an aliased import
    // (`import { PipelexApiClient as Api }`) is caught too. A namespace import
    // (`sdk.PipelexApiClient`) is caught by the member arm's name test.
    const clients = new Map();
    const clientName = (callee) => {
      if (!callee) return undefined;
      if (callee.type === "Identifier") {
        if (clients.has(callee.name)) return clients.get(callee.name);
        return CLIENT_NAME.test(callee.name) ? callee.name : undefined;
      }
      if (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.property.type === "Identifier" &&
        CLIENT_NAME.test(callee.property.name)
      ) {
        return callee.property.name;
      }
      return undefined;
    };
    const checkExtends = (node) => {
      if (allowExtends) return;
      const name = clientName(node.superClass);
      if (name !== undefined) context.report({ node, messageId: "extend", data: { name } });
    };
    return {
      ImportDeclaration(node) {
        if (!SDK_MODULES.has(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          const imported = specifier.imported.name ?? specifier.imported.value;
          if (SDK_CLIENTS.has(imported)) clients.set(specifier.local.name, imported);
        }
      },
      NewExpression(node) {
        const name = clientName(node.callee);
        if (name !== undefined) context.report({ node, messageId: "construct", data: { name } });
      },
      ClassDeclaration: checkExtends,
      ClassExpression: checkExtends,
    };
  },
};

/** @type {import('eslint').Rule.RuleModule} */
const noRawFetch = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Reach the Pipelex API only through the SDK client, so every request carries the pipelex-mcp User-Agent.",
    },
    schema: [],
    messages: {
      fetch:
        "A bare `fetch` bypasses the SDK client, so a request to the Pipelex API would go out without the pipelex-mcp User-Agent. Call the API through `createPipelexApiClient`; a fetch of a third-party link belongs in a file the lint config exempts. See docs/client-identification.md.",
    },
  },
  create(context) {
    const isGlobalFetch = (callee) => {
      if (callee.type === "Identifier") return callee.name === "fetch";
      return (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.object.type === "Identifier" &&
        GLOBAL_OBJECTS.has(callee.object.name) &&
        callee.property.type === "Identifier" &&
        callee.property.name === "fetch"
      );
    };
    return {
      CallExpression(node) {
        if (isGlobalFetch(node.callee)) context.report({ node, messageId: "fetch" });
      },
    };
  },
};

const plugin = {
  meta: { name: "pipelex-api-boundary" },
  rules: {
    "sdk-client-factory": sdkClientFactory,
    "no-raw-fetch": noRawFetch,
  },
};

export default plugin;
