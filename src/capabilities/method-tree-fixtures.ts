import type { MethodTreeSource } from "@pipelex/sdk";
import { sha256Hex, treeDigest } from "mthds";
import path from "node:path";

import type { FileResolver } from "./shared.js";

/**
 * Fixtures for a method's tree as the method-taking tools send it, shared by
 * their tests: a fake resolver standing for a working directory at `/w`, and
 * readers of the tree a fake client was handed. Only tests import this module,
 * so the bundle never reaches it.
 */

/** A file's bytes, from text or as given. */
export function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

/**
 * A resolver over two fixed maps, by path: `files`, the `{ path }` items it
 * reads, each found at `/w/<path>` with `/w` the working directory, and
 * `folder`, the tree every `method_dir` lists, found at `/w/<method_dir>`. A
 * path in neither is missing. Paths are POSIX, whatever the platform.
 */
export function fakeMethodResolver(
  options: {
    files?: Record<string, string | Uint8Array>;
    folder?: Record<string, string | Uint8Array>;
  } = {},
): FileResolver {
  const { files = {}, folder = {} } = options;
  return {
    resolve: () => Promise.reject(new Error("a method's files are read as bytes, never as text")),
    async statMethodFile(submitted) {
      const content = files[submitted];
      if (content === undefined) {
        return { ok: false, message: `File not found: ${submitted}`, remedy: "Check the path." };
      }
      const absolute = path.posix.resolve("/w", submitted);
      return {
        ok: true,
        absolute,
        relative: path.posix.relative("/w", absolute),
        size: bytesOf(content).byteLength,
      };
    },
    async readMethodFile(submitted, options) {
      const content = files[submitted];
      if (content === undefined) {
        return { ok: false, message: `File not found: ${submitted}`, remedy: "Check the path." };
      }
      const bytes = bytesOf(content);
      if (bytes.byteLength > options.maxBytes) {
        return { ok: false, message: `File is too large: ${submitted}`, remedy: "Shrink it." };
      }
      return { ok: true, bytes };
    },
    async locateMethodDir(methodDir) {
      return { ok: true, folder: `/w/${methodDir}`, methodDir };
    },
    async readMethodTree() {
      const bytes = new Map(
        Object.entries(folder)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([treePath, content]) => [treePath, bytesOf(content)] as const),
      );
      const listing = [...bytes].map(([treePath, read]) => ({
        path: treePath,
        size: read.byteLength,
        sha256: sha256Hex(read),
      }));
      return { ok: true, files: listing, digest: treeDigest(listing), bytes };
    },
  };
}

/** Every file of a tree a client was handed, as text, by tree path. */
export async function contentsOf(
  tree: MethodTreeSource | null | undefined,
): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  for (const file of tree?.files ?? []) {
    contents[file.path] = new TextDecoder().decode(await tree!.readFile(file.path));
  }
  return contents;
}

/**
 * A request a client was handed, as a test compares it: its tree, when it
 * carries one, replaced by its files' text by tree path, since the tree's
 * reader is a function no two requests share.
 */
export async function comparableRequest<R extends { tree?: MethodTreeSource | null }>(
  request: R | undefined,
): Promise<(Omit<R, "tree"> & { tree?: Record<string, string> }) | undefined> {
  if (request === undefined) return undefined;
  const { tree, ...rest } = request;
  return tree === undefined || tree === null ? rest : { ...rest, tree: await contentsOf(tree) };
}
