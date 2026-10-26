import { basename, extname } from "node:path";
import { SafeError } from "./io.ts";

/** Files per batch, as the API enforces. */
export const MAX_BATCH_ITEMS = 100;
const MIB = 1024 * 1024;
/** Batch file types by extension, with the API's per-kind size caps. */
const KINDS: Record<string, "image" | "document" | "video"> = {
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".tif": "image",
  ".tiff": "image",
  ".psd": "image",
  ".psb": "image",
  ".gif": "image",
  ".bmp": "image",
  ".ppm": "image",
  ".webp": "image",
  ".pdf": "document",
  ".docx": "document",
  ".pptx": "document",
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".mkv": "video",
  ".mpg": "video",
  ".mpeg": "video",
  ".ts": "video",
  ".avi": "video",
};
const LIMITS = { image: 50 * MIB, document: 20 * MIB, video: 20 * MIB };
/** PDFs take 50 MiB, like images; DOCX and PPTX keep the document cap. */
const PDF_LIMIT = 50 * MIB;
/** States after which a batch makes no further progress. */
export const BATCH_DONE = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

export const isBatchFile = (path: string) =>
  extname(path).toLowerCase() in KINDS;

/** Upload size cap for a batch file, or an error naming the file. */
export function batchLimit(path: string) {
  const kind = KINDS[extname(path).toLowerCase()];
  if (!kind)
    throw new SafeError(
      `${path}: unsupported file type. Batches take images, PDF, DOCX and PPTX documents, and MP4, MOV, WebM, Matroska, MPEG or AVI videos.`,
    );
  return extname(path).toLowerCase() === ".pdf" ? PDF_LIMIT : LIMITS[kind];
}

/** Replace {filename}, {stem} and {index} in every string value. */
export function fillTemplate(
  value: unknown,
  vars: { filename: string; stem: string; index: string },
): unknown {
  if (typeof value === "string")
    return value.replace(
      /\{(filename|stem|index)\}/g,
      (_, name: keyof typeof vars) => vars[name],
    );
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, vars));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fillTemplate(v, vars)]),
    );
  return value;
}

export function checkData(data: unknown, label: string) {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !Object.keys(data).length ||
    Buffer.byteLength(JSON.stringify(data)) > 8192
  )
    throw new SafeError(
      `${label}: data must be a non-empty JSON object up to 8 KiB.`,
    );
  return data as Record<string, unknown>;
}

export const stemOf = (filename: string) =>
  basename(filename, extname(filename));

/** The API's file stem rule: other characters become -, trimmed, 180 at most. */
export function safeStem(filename: string) {
  const name = filename.split(/[\\/]/).pop() ?? "";
  const stem = name.slice(0, name.length - extname(name).length);
  return (
    stem
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 180) || "image"
  );
}

/**
 * Local name for a downloaded item, the same as its entry in the batch zip:
 * NNN- plus the result's own file name (from Content-Disposition), or the
 * name the API derives from the uploaded file when the header has none.
 */
export function outputName(
  index: number,
  filename: string,
  disposition?: string | null,
) {
  const prefix = `${String(index).padStart(3, "0")}-`;
  const given = /filename="([A-Za-z0-9._-]{1,240})"/.exec(
    disposition ?? "",
  )?.[1];
  if (given && !given.startsWith(".")) return prefix + given;
  const ext = extname(filename.split(/[\\/]/).pop() ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "");
  return `${prefix}${safeStem(filename)}-watermarked${ext}`;
}

type Item = Record<string, unknown>;
/** The batch without signed upload URLs, which are credentials. */
export function publicBatch(view: Record<string, unknown>) {
  const items = Array.isArray(view.items) ? (view.items as Item[]) : undefined;
  return {
    ...view,
    ...(items
      ? {
          items: items.map(({ upload, ...item }) => ({
            ...item,
            ...(upload ? { awaiting_upload: true } : {}),
          })),
        }
      : {}),
  };
}

/** Items of a finished batch that did not succeed, with their error codes. */
export function failedItems(view: Record<string, unknown>) {
  const items = Array.isArray(view.items) ? (view.items as Item[]) : [];
  return items
    .filter((item) => item.status !== "succeeded")
    .map(({ index, filename, status, error_code, error_detail }) => ({
      index,
      filename,
      status,
      error_code,
      error_detail,
    }));
}
