import { constants } from "node:fs";
import { glob, open, realpath, lstat, unlink } from "node:fs/promises";
import { resolve, relative, isAbsolute, basename, sep } from "node:path";
import { createHash } from "node:crypto";

// The API's largest input (images); PDFs and videos are limited to 20 MiB there.
export const MAX_UPLOAD = 50 * 1024 * 1024;
/** Detection takes delivered files, up to 192 MiB through an upload session. */
export const MAX_DETECT_UPLOAD = 192 * 1024 * 1024;
export const MAX_DOWNLOAD = 512 * 1024 * 1024;
/** Directory entries a glob may visit before input_dir is refused as too large. */
export const MAX_WALK = 200000;
/** A batch archive holds up to 1 GiB of results plus its manifest. */
export const MAX_ARCHIVE_DOWNLOAD = 1100 * 1024 * 1024;
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
  async function checked(path: string, allowRoot = false) {
    const full = resolve(root, path);
    const rel = relative(root, full);
    if (!rel && allowRoot) return full;
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
  async function directory(path: string, label: string) {
    const full = await checked(path, true);
    const stat = await lstat(full).catch(() => null);
    if (!stat?.isDirectory())
      throw new SafeError(`${label} must be an existing directory.`);
    return full;
  }
  return {
    directory,
    async read(path: string, limit = MAX_UPLOAD) {
      const full = await checked(path);
      const file = await open(
        full,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        const mib = Math.round(limit / 1024 / 1024);
        if (!stat.isFile() || !stat.size || stat.size > limit)
          throw new SafeError(
            `Upload must be a regular file between 1 byte and ${mib} MiB.`,
          );
        const bytes = Buffer.alloc(Math.min(limit, stat.size) + 1);
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
        if (size > limit || size > stat.size || !size)
          throw new SafeError(`Upload must be between 1 byte and ${mib} MiB.`);
        return { bytes: bytes.subarray(0, size), filename: basename(full) };
      } finally {
        await file.close();
      }
    },
    /**
     * Files under a directory inside the root that match a glob and `keep`, as
     * paths relative to the root, sorted. Symlinks and directories are skipped.
     * Stops after `max` + 1 matches (`more` is then true); a directory with
     * more than MAX_WALK entries is refused rather than listed in part.
     */
    async list(
      dir: string,
      pattern: string,
      keep: (path: string) => boolean,
      max: number,
      walkLimit = MAX_WALK,
    ) {
      // Braces are refused because expansion such as {..,x} could leave the directory.
      if (
        isAbsolute(pattern) ||
        /[{}\\\x00-\x1f]/.test(pattern) ||
        pattern.split("/").includes("..")
      )
        throw new SafeError(
          "glob must be a relative pattern without .., braces, backslashes or control characters.",
        );
      const full = await directory(dir, "input_dir");
      const found: string[] = [];
      let seen = 0;
      for await (const entry of glob(pattern, {
        cwd: full,
        withFileTypes: true,
      })) {
        if (++seen > walkLimit)
          throw new SafeError(
            `input_dir holds more than ${walkLimit} entries matching the glob. Choose a smaller directory or a narrower glob.`,
          );
        if (!entry.isFile() || !keep(entry.name)) continue;
        const path = resolve(full, entry.parentPath, entry.name);
        const rel = relative(root, path);
        const inDir = relative(full, path);
        // Keep only files inside input_dir, reached without a symlink. Nothing
        // outside the root is ever returned or named in an error.
        if (
          !rel ||
          !inDir ||
          [rel, inDir].some(
            (r) => r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r),
          ) ||
          !(await checked(rel).then(
            () => true,
            () => false,
          ))
        )
          continue;
        found.push(rel);
        if (found.length > max) return { files: found.sort(), more: true };
      }
      return { files: found.sort(), more: false };
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
        async save(response: Response, limit = MAX_DOWNLOAD) {
          let size = 0;
          const hash = createHash("sha256");
          if (!response.body)
            throw new SafeError("API returned an empty file.");
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > limit)
              throw new SafeError(
                `Download exceeds the MCP server limit of ${Math.round(limit / 1024 / 1024)} MiB.`,
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
