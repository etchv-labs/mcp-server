import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type RequestOptions,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  checkUrl,
  dispositionName,
  fetchUrl,
  isPublicAddress,
  MAX_REDIRECTS,
  type Address,
} from "../src/fetch.ts";
import { VERSION } from "../src/version.ts";

test("isPublicAddress blocks every non-public range", () => {
  const blocked = [
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "127.255.0.9",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.10",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.5",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    // IPv6 unspecified, loopback, ULA, link-local, multicast, documentation
    "::",
    "::1",
    "fc00::1",
    "fd12:3456:789a::1",
    "fe80::1",
    "fe80::1%en0",
    "febf::1",
    "ff02::1",
    "ff0e::1",
    "2001:db8::1",
    "3fff::1",
    "2001:2::1",
    "2001:10::1",
    "64:ff9b:1::1",
    // IPv4-mapped and IPv4-compatible forms of blocked addresses
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:0:0",
    "::127.0.0.1",
    "::8.8.8.8",
    // NAT64, 6to4 and Teredo that embed a blocked IPv4 address
    "64:ff9b::7f00:1",
    "64:ff9b::192.168.0.1",
    "2002:c0a8:0101::1",
    "2002:7f00:1::",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", // client 192.0.2.45
    "2001:0:c0a8:101::1", // server 192.168.1.1
    // Not an address at all
    "example.com",
    "",
  ];
  for (const address of blocked)
    assert.equal(isPublicAddress(address), false, address);
  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "100.63.255.255",
    "100.128.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "192.0.3.1",
    "198.17.255.255",
    "223.255.255.254",
    "2606:4700:4700::1111",
    "2a00:1450:4001::1",
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "64:ff9b::808:808",
    "2002:0808:0808::1",
    "2001:0:808:808:0:0:f7f7:f7f7", // server and client 8.8.8.8
  ];
  for (const address of allowed)
    assert.equal(isPublicAddress(address), true, address);
});

test("checkUrl requires HTTPS, no credentials and a public literal IP", () => {
  assert.equal(
    checkUrl("https://example.com/a.png").href,
    "https://example.com/a.png",
  );
  assert.equal(checkUrl("https://8.8.8.8/a.png").hostname, "8.8.8.8");
  const refused: [string, RegExp][] = [
    ["http://example.com/a.png", /HTTPS/],
    ["ftp://example.com/a.png", /HTTPS/],
    ["file:///etc/passwd", /HTTPS/],
    ["not a url", /absolute HTTPS URL/],
    ["https://user:pass@example.com/a.png", /user name or password/],
    ["https://user@example.com/a.png", /user name or password/],
    ["https://127.0.0.1/a.png", /public internet address/],
    ["https://2130706433/a.png", /public internet address/],
    ["https://0x7f.1/a.png", /public internet address/],
    ["https://[::1]/a.png", /public internet address/],
    ["https://[::ffff:10.0.0.1]/a.png", /public internet address/],
    ["https://[fd00::1]/a.png", /public internet address/],
    ["https://169.254.169.254/latest/meta-data/", /public internet address/],
  ];
  for (const [url, message] of refused)
    assert.throws(() => checkUrl(url), message, url);
});

test("dispositionName prefers filename*, strips directories", () => {
  assert.equal(
    dispositionName(
      `attachment; filename="asset.png"; filename*=UTF-8''Spring%20photo.png`,
    ),
    "Spring photo.png",
  );
  assert.equal(dispositionName('inline; filename="report.pdf"'), "report.pdf");
  assert.equal(dispositionName("attachment; filename=plain.jpg"), "plain.jpg");
  assert.equal(
    dispositionName('attachment; filename="../../etc/x.png"'),
    "x.png",
  );
  assert.equal(dispositionName('attachment; filename=".."'), undefined);
  assert.equal(dispositionName("attachment"), undefined);
  assert.equal(dispositionName(null), undefined);
});

/**
 * A plain HTTP server standing in for HTTPS hosts: URLs say https:// and name
 * test hosts, the resolver maps them, and the transport speaks HTTP to it.
 */
async function origin(
  handle: (path: string, response: ServerResponse) => void,
) {
  const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
  const http = createServer((incoming, response) => {
    seen.push({ path: incoming.url!, headers: incoming.headers });
    handle(incoming.url!, response);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  const hosts: Record<string, Address[]> = {
    "files.test": [{ address: "127.0.0.1", family: 4 }],
    "private.test": [{ address: "10.0.0.5", family: 4 }],
    "mixed.test": [
      { address: "127.0.0.1", family: 4 },
      { address: "192.168.1.20", family: 4 },
    ],
    "mapped.test": [{ address: "::ffff:169.254.169.254", family: 6 }],
  };
  const resolved: string[] = [];
  const options = {
    resolve: async (host: string) => {
      resolved.push(host);
      const found = hosts[host];
      if (!found)
        throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return found;
    },
    // The fake origin is on loopback; every other address keeps the real rule.
    allow: (address: string) =>
      address === "127.0.0.1" || isPublicAddress(address),
    transport: (o: RequestOptions) => httpRequest({ ...o, protocol: "http:" }),
  };
  return {
    seen,
    resolved,
    options,
    url: (host: string, path: string) => `https://${host}:${port}${path}`,
    close: () => {
      http.closeAllConnections();
      http.close();
    },
  };
}

test("fetchUrl downloads with only a user agent, and names the file", async (t) => {
  const body = Buffer.from("public file bytes");
  const server = await origin((path, response) => {
    if (path === "/named")
      response.writeHead(200, {
        "content-type": "image/png; charset=binary",
        "content-disposition": 'attachment; filename="from-header.png"',
      });
    else response.writeHead(200, { "content-type": "image/png" });
    response.end(body);
  });
  t.after(server.close);
  const named = await fetchUrl(server.url("files.test", "/named"), {
    limit: 1024,
    ...server.options,
  });
  assert.deepEqual(named.bytes, body);
  assert.equal(named.filename, "from-header.png");
  assert.equal(named.content_type, "image/png");
  const plain = await fetchUrl(
    server.url("files.test", "/photos/My%20Photo.png?size=large"),
    { limit: 1024, ...server.options },
  );
  assert.equal(plain.filename, "My Photo.png");
  assert.equal(server.seen[1].path, "/photos/My%20Photo.png?size=large");
  for (const { headers } of server.seen) {
    assert.equal(
      headers["user-agent"],
      `etchv-mcp-server/${VERSION} node/${process.versions.node}`,
    );
    assert.equal(headers["x-api-key"], undefined);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.cookie, undefined);
  }
});

test("fetchUrl refuses hosts that resolve to any non-public address", async (t) => {
  const server = await origin((_, response) => response.end("x"));
  t.after(server.close);
  for (const host of ["private.test", "mixed.test", "mapped.test"])
    await assert.rejects(
      fetchUrl(server.url(host, "/a.png"), { limit: 1024, ...server.options }),
      /public internet address/,
      host,
    );
  await assert.rejects(
    fetchUrl(server.url("missing.test", "/a.png"), {
      limit: 1024,
      ...server.options,
    }),
    /could not be found/,
  );
  assert.equal(server.seen.length, 0);
});

test("fetchUrl re-checks every redirect and stops after three", async (t) => {
  let target = "";
  const server = await origin((path, response) => {
    const hop = /^\/hop\/(\d+)$/.exec(path);
    if (hop && Number(hop[1]) > 0)
      response.writeHead(302, { location: `/hop/${Number(hop[1]) - 1}` });
    else if (path === "/away") response.writeHead(307, { location: target });
    else if (path === "/nowhere") response.writeHead(301);
    else response.writeHead(200);
    response.end("done");
  });
  t.after(server.close);
  const fetch = (path: string) =>
    fetchUrl(server.url("files.test", path), {
      limit: 1024,
      ...server.options,
    });
  const ok = await fetch(`/hop/${MAX_REDIRECTS}`);
  assert.equal(ok.bytes.toString(), "done");
  assert.equal(ok.filename, "0");
  await assert.rejects(fetch(`/hop/${MAX_REDIRECTS + 1}`), /more than 3 times/);
  await assert.rejects(fetch("/nowhere"), /without a location/);
  for (const [location, message] of [
    [server.url("private.test", "/x.png"), /public internet address/],
    [server.url("mapped.test", "/x.png"), /public internet address/],
    ["https://169.254.169.254/latest/meta-data/", /public internet address/],
    ["https://[::ffff:127.0.0.1]/x.png", /public internet address/],
    [server.url("files.test", "/x.png").replace("https:", "http:"), /HTTPS/],
    [
      server.url("files.test", "/x.png").replace("//", "//user:pw@"),
      /user name or password/,
    ],
  ] as const) {
    target = location;
    const before = server.seen.length;
    await assert.rejects(fetch("/away"), message, location);
    // Only the redirecting request reached the origin.
    assert.equal(server.seen.length, before + 1);
  }
  assert(server.resolved.includes("private.test"));
});

test("fetchUrl enforces the byte cap, status and timeouts", async (t) => {
  const server = await origin((path, response) => {
    if (path === "/declared") {
      response.writeHead(200, { "content-length": "2048" });
      response.end(Buffer.alloc(2048));
    } else if (path === "/chunked") {
      response.writeHead(200);
      for (let i = 0; i < 8; i++) response.write(Buffer.alloc(256));
      response.end();
    } else if (path === "/exact") {
      response.writeHead(200);
      response.end(Buffer.alloc(1024));
    } else if (path === "/empty") {
      response.writeHead(200);
      response.end();
    } else if (path === "/missing") {
      response.writeHead(404);
      response.end("no");
    } else if (path === "/stall") {
      response.writeHead(200);
      response.write("partial");
    }
    // /hang never answers
  });
  t.after(server.close);
  const fetch = (path: string, extra = {}) =>
    fetchUrl(server.url("files.test", path), {
      limit: 1024,
      ...server.options,
      ...extra,
    });
  await assert.rejects(fetch("/declared"), /exceeds the 0 MiB limit/);
  await assert.rejects(fetch("/chunked"), /exceeds/);
  assert.equal((await fetch("/exact")).bytes.length, 1024);
  await assert.rejects(fetch("/empty"), /empty file/);
  await assert.rejects(fetch("/missing"), /HTTP 404/);
  await assert.rejects(fetch("/hang", { timeout: 100 }), /did not respond/);
  await assert.rejects(fetch("/stall", { idleTimeout: 100 }), /stalled/);
  await assert.rejects(
    fetch("/stall", { totalTimeout: 150, idleTimeout: 5000 }),
    /timed out/,
  );
  const cancel = new AbortController();
  const pending = fetch("/hang", { signal: cancel.signal });
  cancel.abort(new Error("cancelled by client"));
  await assert.rejects(pending, /cancelled by client/);
});

test("fetchUrl drops endless redirect and error bodies, and headers have a real deadline", async (t) => {
  const closed: Record<string, number> = {};
  const server = await origin((path, response) => {
    if (path === "/endless-redirect" || path === "/endless-error") {
      response.writeHead(path === "/endless-redirect" ? 302 : 404, {
        location: "/exact",
      });
      let sent = 0;
      const pump = () => {
        if (response.destroyed) return;
        sent += 64 * 1024;
        if (response.write(Buffer.alloc(64 * 1024))) setImmediate(pump);
        else response.once("drain", pump);
      };
      response.once("close", () => (closed[path] = sent));
      pump();
    } else if (path === "/exact") {
      response.writeHead(200);
      response.end(Buffer.alloc(1024));
    } else if (path === "/trickle") {
      // One header byte every 50 ms: never idle, never finished.
      const socket = response.socket!;
      const head = "HTTP/1.1 200 OK\r\ncontent-length: 1\r\n\r\nx";
      let i = 0;
      const timer = setInterval(() => {
        if (socket.destroyed || i >= head.length) return clearInterval(timer);
        socket.write(head[i++]);
      }, 50);
      socket.once("close", () => clearInterval(timer));
    }
  });
  t.after(server.close);
  const fetch = (path: string, extra = {}) =>
    fetchUrl(server.url("files.test", path), {
      limit: 1024,
      ...server.options,
      ...extra,
    });
  assert.equal((await fetch("/endless-redirect")).bytes.length, 1024);
  await assert.rejects(fetch("/endless-error"), /HTTP 404/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (const path of ["/endless-redirect", "/endless-error"]) {
    assert.ok(path in closed, `${path} was not closed`);
    assert.ok(closed[path] < 64 * 1024 * 1024, `${path} kept downloading`);
  }
  const started = Date.now();
  await assert.rejects(
    fetch("/trickle", { timeout: 300, totalTimeout: 10000 }),
    /did not respond/,
  );
  assert.ok(Date.now() - started < 2000);
});
