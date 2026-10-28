import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { isIP, type LookupFunction } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { basename } from "node:path";
import { SafeError } from "./io.ts";
import { USER_AGENT } from "./version.ts";

/** Redirects a URL fetch follows, each one checked like the first URL. */
export const MAX_REDIRECTS = 3;

export interface Fetched {
  bytes: Buffer;
  /** From Content-Disposition, else the last segment of the final URL path. */
  filename?: string;
  content_type?: string;
}
/** Fetches a URL for submission; injectable so tests need no network. */
export type Fetcher = (
  url: string,
  options: { limit: number; signal?: AbortSignal },
) => Promise<Fetched>;
export interface Address {
  address: string;
  family: number;
}
export interface FetchOptions {
  limit: number;
  signal?: AbortSignal;
  /** Resolves a host name to every address it has. */
  resolve?: (host: string) => Promise<Address[]>;
  /** Whether an address may be connected to. Defaults to isPublicAddress. */
  allow?: (address: string) => boolean;
  /** The request function; tests pass node:http's to avoid certificates. */
  transport?: (options: RequestOptions) => ClientRequest;
  /** Deadline from sending the request to receiving all response headers, in ms. */
  timeout?: number;
  /** Longest pause while the body streams, in ms. */
  idleTimeout?: number;
  /** Deadline for the whole fetch including the body, in ms. */
  totalTimeout?: number;
}

const v4 = (ip: string) =>
  ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
const cidr4 = (base: string, bits: number) => {
  const size = 2 ** (32 - bits);
  const start = v4(base);
  return (n: number) => n >= start && n < start + size;
};
/** IPv4 ranges that are not public unicast addresses. */
const BLOCKED_V4 = [
  cidr4("0.0.0.0", 8), // this network, unspecified
  cidr4("10.0.0.0", 8), // private
  cidr4("100.64.0.0", 10), // carrier-grade NAT
  cidr4("127.0.0.0", 8), // loopback
  cidr4("169.254.0.0", 16), // link-local
  cidr4("172.16.0.0", 12), // private
  cidr4("192.0.0.0", 24), // IETF protocol assignments
  cidr4("192.0.2.0", 24), // documentation
  cidr4("192.31.196.0", 24), // AS112
  cidr4("192.52.193.0", 24), // AMT
  cidr4("192.88.99.0", 24), // 6to4 relay anycast
  cidr4("192.168.0.0", 16), // private
  cidr4("192.175.48.0", 24), // AS112 direct delegation
  cidr4("198.18.0.0", 15), // benchmarking
  cidr4("198.51.100.0", 24), // documentation
  cidr4("203.0.113.0", 24), // documentation
  cidr4("224.0.0.0", 4), // multicast
  cidr4("240.0.0.0", 4), // reserved and broadcast
];
const publicV4 = (n: number) => !BLOCKED_V4.some((inRange) => inRange(n));

/** The 16 bytes of an IPv6 address, or undefined when it is not one. */
function v6Bytes(ip: string): number[] | undefined {
  if (isIP(ip) !== 6) return undefined;
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  // A trailing dotted IPv4 part becomes two hextets.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const n = v4(dotted[1]);
    text =
      text.slice(0, -dotted[1].length) +
      `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const hextets =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return hextets.flatMap((h) => {
    const n = parseInt(h, 16);
    return [n >> 8, n & 0xff];
  });
}
const v4At = (b: number[], i: number) =>
  ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const prefix = (b: number[], bytes: number[]) =>
  bytes.every((value, i) => b[i] === value);

/**
 * Whether an address is public unicast, safe to fetch a user's URL from.
 * IPv6 must be global unicast (2000::/3) outside documentation and special
 * ranges; forms that embed an IPv4 address (IPv4-mapped, NAT64, 6to4 and
 * Teredo) are judged by the IPv4 address they carry.
 */
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) return publicV4(v4(ip));
  const b = v6Bytes(ip);
  if (!b) return false;
  // ::ffff:0:0/96 IPv4-mapped. IPv4-compatible ::/96 (deprecated) falls
  // outside 2000::/3 below and is always refused.
  if (prefix(b, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]))
    return publicV4(v4At(b, 12));
  // 64:ff9b::/96 well-known NAT64 prefix.
  if (prefix(b, [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0]))
    return publicV4(v4At(b, 12));
  // 2002::/16 6to4 carries the IPv4 address in the next 32 bits.
  if (prefix(b, [0x20, 0x02])) return publicV4(v4At(b, 2));
  // 2001::/32 Teredo: server IPv4, then the client's IPv4 inverted.
  if (prefix(b, [0x20, 0x01, 0, 0]))
    return publicV4(v4At(b, 4)) && publicV4(~v4At(b, 12) >>> 0);
  // Only global unicast 2000::/3 remains; this excludes ::, ::1, ULA fc00::/7,
  // link-local fe80::/10, multicast ff00::/8 and 64:ff9b:1::/48.
  if ((b[0] & 0xe0) !== 0x20) return false;
  // 2001::/23 IETF special-purpose assignments (other than Teredo above).
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] < 0x02) return false;
  // 2001:db8::/32 and 3fff::/20 documentation.
  if (prefix(b, [0x20, 0x01, 0x0d, 0xb8])) return false;
  if (b[0] === 0x3f && b[1] === 0xff && b[2] < 0x10) return false;
  return true;
}

/** A file name from a Content-Disposition header, without any directory. */
export function dispositionName(header: string | null | undefined) {
  if (!header) return undefined;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  let name: string | undefined;
  if (extended) {
    try {
      name = decodeURIComponent(extended[1].trim());
    } catch {
      name = undefined;
    }
  }
  name ??= /filename\s*=\s*"([^"]*)"/.exec(header)?.[1];
  name ??= /filename\s*=\s*([^;\s]+)/.exec(header)?.[1];
  return cleanName(name);
}
function cleanName(name: string | undefined) {
  const clean = basename((name ?? "").replace(/\\/g, "/"))
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 255);
  return clean && clean !== "." && clean !== ".." ? clean : undefined;
}
function urlName(url: URL) {
  try {
    return cleanName(decodeURIComponent(url.pathname.split("/").pop() ?? ""));
  } catch {
    return undefined;
  }
}

/** Check a URL before connecting: HTTPS, no credentials, a public literal IP. */
export function checkUrl(value: string | URL, allow = isPublicAddress) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SafeError("input_url must be an absolute HTTPS URL.");
  }
  if (url.protocol !== "https:")
    throw new SafeError("input_url must use HTTPS.");
  if (url.username || url.password)
    throw new SafeError("input_url must not contain a user name or password.");
  // Node does not call lookup for a literal IP, so check it here.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !allow(host))
    throw new SafeError(
      "input_url must point to a public internet address, not a private, local or reserved one.",
    );
  return url;
}

const defaultResolve = (host: string) =>
  dnsLookup(host, { all: true, verbatim: true });

/**
 * A lookup that resolves once, refuses the host if any address is not public,
 * and hands only those vetted addresses to the connection, so a second DNS
 * answer (rebinding) can never be used.
 */
function vettedLookup(
  resolve: (host: string) => Promise<Address[]>,
  allow: (address: string) => boolean,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        const wanted = options.family === 6 ? 6 : options.family === 4 ? 4 : 0;
        const usable = addresses.filter((a) => !wanted || a.family === wanted);
        if (!addresses.length || !usable.length)
          return callback(
            Object.assign(new Error("No address"), { code: "ENOTFOUND" }),
            "",
          );
        if (!addresses.every((a) => allow(a.address)))
          return callback(
            new SafeError(
              "input_url must point to a public internet address, not a private, local or reserved one.",
            ),
            "",
          );
        if (options.all) callback(null, usable);
        else callback(null, usable[0].address, usable[0].family);
      },
      (error: Error) => callback(error as NodeJS.ErrnoException, ""),
    );
  };
}

/**
 * Fetch a public HTTPS URL into memory, up to `limit` bytes. Follows up to
 * three redirects, checking each target like the first. Sends no credentials:
 * only a User-Agent goes with the request.
 */
export async function fetchUrl(
  input: string,
  {
    limit,
    signal,
    resolve = defaultResolve,
    allow = isPublicAddress,
    transport = httpsRequest,
    timeout = 30000,
    idleTimeout = 30000,
    totalTimeout = 600000,
  }: FetchOptions,
): Promise<Fetched> {
  const deadline = AbortSignal.any([
    AbortSignal.timeout(totalTimeout),
    ...(signal ? [signal] : []),
  ]);
  const lookup = vettedLookup(resolve, allow);
  let url = checkUrl(input, allow);
  for (let redirects = 0; ; redirects++) {
    const response = await get(url, lookup, transport, deadline, timeout);
    const status = response.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      // Never drain: an endless redirect or error body would keep downloading.
      response.destroy();
      const location = response.headers.location;
      if (!location)
        throw new SafeError(
          `input_url redirected (HTTP ${status}) without a location.`,
        );
      if (redirects >= MAX_REDIRECTS)
        throw new SafeError(
          `input_url redirected more than ${MAX_REDIRECTS} times.`,
        );
      url = checkUrl(new URL(location, url), allow);
      continue;
    }
    if (status !== 200) {
      // Never drain: an endless redirect or error body would keep downloading.
      response.destroy();
      throw new SafeError(`input_url returned HTTP ${status}.`);
    }
    const mib = Math.round(limit / 1024 / 1024);
    const tooLarge = () =>
      new SafeError(
        `The file at input_url exceeds the ${mib} MiB limit for this operation.`,
      );
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      response.destroy();
      throw tooLarge();
    }
    response.setTimeout(idleTimeout, () =>
      response.destroy(
        new SafeError("Downloading input_url stalled. Try again later."),
      ),
    );
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of response as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > limit) throw tooLarge();
        chunks.push(chunk);
      }
    } catch (error) {
      response.destroy();
      throw timedOut(error, deadline);
    }
    if (!size) throw new SafeError("input_url returned an empty file.");
    const type = response.headers["content-type"];
    return {
      bytes: Buffer.concat(chunks, size),
      filename:
        dispositionName(response.headers["content-disposition"]) ??
        urlName(url),
      ...(type ? { content_type: type.split(";")[0].trim() } : {}),
    };
  }
}

function timedOut(error: unknown, deadline: AbortSignal) {
  if (error instanceof SafeError) return error;
  if (deadline.aborted && deadline.reason?.name === "TimeoutError")
    return new SafeError("Downloading input_url timed out.");
  if (deadline.aborted) return deadline.reason;
  return new SafeError("Could not download input_url.");
}

function get(
  url: URL,
  lookup: LookupFunction,
  transport: (options: RequestOptions) => ClientRequest,
  deadline: AbortSignal,
  timeout: number,
) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    if (deadline.aborted) return reject(timedOut(undefined, deadline));
    const request = transport({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "*/*",
        "Accept-Encoding": "identity",
      },
      lookup,
      agent: false,
      signal: deadline,
    } as RequestOptions);
    // A real deadline, not a socket idle timeout: a server that trickles header
    // bytes cannot hold the call open.
    const slow = setTimeout(
      () =>
        request.destroy(new SafeError("input_url did not respond in time.")),
      timeout,
    );
    request.once("response", (response) => {
      clearTimeout(slow);
      resolve(response);
    });
    request.once("error", (error) => {
      clearTimeout(slow);
      reject(
        error instanceof SafeError
          ? error
          : (error as NodeJS.ErrnoException).code === "ENOTFOUND"
            ? new SafeError("The host in input_url could not be found.")
            : timedOut(error, deadline),
      );
    });
    request.end();
  });
}
