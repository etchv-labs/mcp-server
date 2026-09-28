import { constants } from "node:fs";
import { open, realpath, lstat, unlink } from "node:fs/promises";
import { resolve, relative, isAbsolute, basename, sep } from "node:path";
import { createHash } from "node:crypto";

// The API's largest input (images); PDFs and videos are limited to 20 MiB there.
export const MAX_UPLOAD = 50 * 1024 * 1024;
export const MAX_DOWNLOAD = 512 * 1024 * 1024;
export class SafeError extends Error {}

export async function fileAccess(configuredRoot: string | undefined) {
  if (!configuredRoot || !isAbsolute(configuredRoot))
    throw new SafeError(
      "ETCHV_FILES_ROOT must be an existing absolute directory.",
    );
  const root = await realpath(configuredRoot).catch(() => {
    throw new SafeError("ETCHV_FILES_ROOT must be an existing directory.");
  });
  if (!(await lstat(root)).isDirectory())
    throw new SafeError("ETCHV_FILES_ROOT must be a directory.");
  async function checked(path: string) {
    const full = resolve(root, path);
    const rel = relative(root, full);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new SafeError("File path must be inside ETCHV_FILES_ROOT.");
    // Reject symlinks in every existing component, including the final file.
    let current = root;
    const parts = rel.split(sep);
    for (let i = 0; i < parts.length; i++) {
      current = resolve(current, parts[i]);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink())
          throw new SafeError("Symlink paths are not supported.");
        if (i < parts.length - 1 && !stat.isDirectory())
          throw new SafeError("Parent must be a directory.");
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) ||
          i !== parts.length - 1
        )
          throw error;
      }
    }
    return full;
  }
  return {
    async read(path: string) {
      const full = await checked(path);
      const file = await open(
        full,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || !stat.size || stat.size > MAX_UPLOAD)
          throw new SafeError(
            "Upload must be a regular file between 1 byte and 50 MiB.",
          );
        const bytes = Buffer.alloc(MAX_UPLOAD + 1);
        let size = 0;
        while (size < bytes.length) {
          const { bytesRead } = await file.read(
            bytes,
            size,
            bytes.length - size,
          );
          if (!bytesRead) break;
          size += bytesRead;
        }
        if (size > MAX_UPLOAD || !size)
          throw new SafeError("Upload must be between 1 byte and 50 MiB.");
        return { bytes: bytes.subarray(0, size), filename: basename(full) };
      } finally {
        await file.close();
      }
    },
    async reserve(path: string) {
      const full = await checked(path);
      // Exclusive creation also prevents concurrent requests overwriting each other.
      const file = await open(
        full,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      let saved = false;
      return {
        async save(response: Response) {
          let size = 0;
          const hash = createHash("sha256");
          if (!response.body)
            throw new SafeError("API returned an empty file.");
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > MAX_DOWNLOAD)
              throw new SafeError(
                "Download exceeds the MCP server limit of 512 MiB.",
              );
            hash.update(chunk);
            await file.writeFile(chunk);
          }
          if (!size) throw new SafeError("API returned an empty file.");
          saved = true;
          return {
            output_path: full,
            size_bytes: size,
            sha256: hash.digest("hex"),
            content_type: response.headers.get("content-type"),
          };
        },
        async close() {
          await file.close();
          if (!saved) await unlink(full).catch(() => {});
        },
      };
    },
  };
}
