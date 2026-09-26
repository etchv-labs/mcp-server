import { SafeError } from "./io.ts";
import { USER_AGENT } from "./version.ts";

const messages: Record<number, string> = {
  400: "Invalid request. Check the media and options.",
  401: "API key is invalid or expired.",
  402: "Insufficient credits.",
  403: "API key scope, role or plan does not allow this operation.",
  404: "Resource was not found in this organization.",
  409: "Conflict: check the job, idempotency key, asset version or delivery state.",
  410: "The result or download has expired.",
  413: "The upload exceeds API limits.",
  415: "Media format or encoding is unsupported.",
  422: "The API rejected the file or request fields. Check the format limits in the documentation.",
  429: "Rate limit reached. Retry after the indicated delay.",
};
export class ApiError extends SafeError {
  status: number;
  request_id?: string;
  retry_after_seconds?: number;
  constructor(response: Response) {
    super(
      messages[response.status] ||
        `Etchv request failed (HTTP ${response.status}).`,
    );
    this.status = response.status;
    const id = response.headers.get("x-request-id");
    this.request_id = /^req_[a-f0-9]{64}$/.test(id ?? "") ? id! : undefined;
    const retry = response.headers.get("retry-after");
    this.retry_after_seconds = /^\d{1,6}$/.test(retry ?? "")
      ? Number(retry)
      : undefined;
  }
}
export interface ApiConfig {
  apiKey?: string;
  baseUrl?: string;
  /** Deadline in milliseconds for the API to return response headers. */
  timeout?: number;
  /** Deadline in milliseconds for reading a response body, such as a download. */
  bodyTimeout?: number;
}
export interface RequestOptions {
  method?: string;
  body?: FormData | Record<string, unknown>;
  query?: Record<string, string | number | boolean | undefined>;
  idempotency_key?: string;
  signal?: AbortSignal;
}
export function apiClient({
  apiKey,
  baseUrl = "https://api.etchv.com",
  timeout = 45000,
  bodyTimeout = 600000,
}: ApiConfig) {
  if (!apiKey || /[\r\n]/.test(apiKey))
    throw new SafeError("Set ETCHV_API_KEY to an Etchv API key.");
  const key = apiKey;
  const base = new URL(baseUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    (base.protocol !== "https:" &&
      !(
        base.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
      ))
  ) {
    throw new SafeError(
      "ETCHV_API_BASE_URL must be an HTTPS origin (HTTP is allowed for localhost).",
    );
  }
  return {
    async request(
      path: string,
      {
        method = "GET",
        body,
        query,
        idempotency_key,
        signal,
      }: RequestOptions = {},
    ) {
      const url = new URL(path, base);
      if (url.origin !== base.origin) throw new SafeError("Invalid API route.");
      for (const [key, value] of Object.entries(query ?? {}))
        if (value != null) url.searchParams.set(key, String(value));
      const headers: Record<string, string> = {
        "X-API-Key": key,
        "User-Agent": USER_AGENT,
      };
      let requestBody: string | FormData | undefined;
      if (idempotency_key) headers["Idempotency-Key"] = idempotency_key;
      if (body !== undefined && !(body instanceof FormData)) {
        headers["Content-Type"] = "application/json";
        requestBody = JSON.stringify(body);
      } else requestBody = body;
      // Headers must arrive within `timeout`; large bodies get a separate deadline.
      const deadline = new AbortController();
      const expire = () =>
        deadline.abort(new DOMException("Request timed out", "TimeoutError"));
      let timer = setTimeout(expire, timeout);
      // Do not retry mutations automatically. The caller reuses its idempotency key.
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          body: requestBody,
          headers,
          redirect: "manual",
          signal: AbortSignal.any([
            deadline.signal,
            ...(signal ? [signal] : []),
          ]),
        });
      } finally {
        clearTimeout(timer);
      }
      timer = setTimeout(expire, bodyTimeout);
      timer.unref();
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiError(response);
      }
      return response;
    },
  };
}
export async function jsonResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  if (response.status === 204) return { success: true };
  let size = 0;
  const chunks = [];
  if (!response.body)
    throw new SafeError("API returned an empty JSON response.");
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024)
      throw new SafeError(
        "API response exceeds 2 MiB. Request a smaller page.",
      );
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object") throw new Error();
    return Array.isArray(value) ? { items: value } : value;
  } catch {
    throw new SafeError("API returned an invalid JSON object.");
  }
}
export function errorResult(error: unknown, idempotency_key?: string) {
  const message =
    error instanceof SafeError
      ? error.message
      : error instanceof Error && error.name === "TimeoutError"
        ? "Etchv API request timed out. A submitted job may still be running; retry submissions with the same idempotency key."
        : error instanceof TypeError && error.message === "fetch failed"
          ? "Could not reach the Etchv API. Check the network connection and ETCHV_API_BASE_URL."
          : error instanceof Error && "code" in error && error.code === "EEXIST"
            ? "Output file already exists. Choose a new output path."
            : error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              ? "File or parent directory does not exist inside ETCHV_FILES_ROOT."
              : "Operation could not complete. A submitted job may still be running; retry submissions with the same idempotency key.";
  return {
    error: message,
    ...(error instanceof ApiError
      ? {
          http_status: error.status,
          request_id: error.request_id,
          retry_after_seconds: error.retry_after_seconds,
        }
      : {}),
    ...(idempotency_key ? { idempotency_key } : {}),
  };
}
