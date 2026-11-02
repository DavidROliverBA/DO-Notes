// How a share becomes inbox lines (src/capture.ts), for the shapes the iPhone Shortcut sends; and
// src/weblinks.ts reading a page's title and refusing private addresses. No database needed.

import { describe, expect, test } from "bun:test";
import { appendEntries, entryFor, linkFor, plan } from "../src/capture";

const shared = (o: Partial<Parameters<typeof plan>[0]>) => ({ files: [], fileTexts: [], texts: [], urls: [], title: "", ...o });

describe("capture", () => {
  test("a bare link becomes a titled link; without a title, its address names it", () => {
    expect(plan(shared({ texts: ["https://example.com/a"], urls: ["https://example.com/a"], title: "A guide" })).lines).toEqual(["[A guide](https://example.com/a)"]);
    expect(linkFor("https://www.bbc.co.uk/news/", "")).toBe("[bbc.co.uk/news](https://www.bbc.co.uk/news/)");
    expect(linkFor("https://x.org/a (b)", "[odd] title")).toBe("[odd title](https://x.org/a%20%28b%29)");
  });

  test("a web page's whole text, sent alongside its link, is replaced by the link", () => {
    const page = "Lorem ipsum ".repeat(200);
    expect(plan(shared({ texts: [page], urls: ["https://example.com/p"] })).lines).toEqual(["[example.com/p](https://example.com/p)"]);
  });

  test("a note with a link in it is kept as written, not doubled", () => {
    const t = "Look at https://example.com/x before Friday";
    expect(plan(shared({ texts: [t], urls: ["https://example.com/x"] })).lines).toEqual([t]);
  });

  test("photos win over the text field, which is only the photo's name", () => {
    const photo = new File([new Uint8Array(4)], "IMG_1.HEIC");
    const p = plan(shared({ files: [photo], texts: ["IMG_1"] }));
    expect(p.files).toEqual([photo]);
    expect(p.lines).toEqual([]);
  });

  test("entries are to-dos with the time; extra lines are indented into the item", () => {
    expect(entryFor("Call Sam\nabout tiles\n\nsoon", "11 Oct 09:15")).toBe("- [ ] Call Sam · 11 Oct 09:15\n  about tiles\n\n  soon");
  });

  test("appending keeps the list together and the intro apart", () => {
    expect(appendEntries("# Inbox\n\nIntro.\n", ["- [ ] a"])).toBe("# Inbox\n\nIntro.\n\n- [ ] a\n");
    expect(appendEntries("# Inbox\n\n- [ ] a\n\n\n", ["- [ ] b"])).toBe("# Inbox\n\n- [ ] a\n- [ ] b\n");
    expect(appendEntries("- [ ] a\n  more", ["- [ ] b"])).toBe("- [ ] a\n  more\n- [ ] b\n");
    expect(appendEntries("", ["- [ ] a"])).toBe("- [ ] a\n");
  });
});

describe("weblinks: reading pages, and never fetching private addresses", () => {
  const { parseMeta, decodeEntities } = require("../src/weblinks");
  const { isPrivateAddress } = require("../src/addresses");
  test("Open Graph first, then the page's own title and description; relative pictures made absolute", () => {
    const html = `<head><title>Plain &amp; simple</title><meta name="description" content='Just the page'><meta property="og:image" content="img/c.jpg"></head>`;
    expect(parseMeta(html, "https://www.example.org/a/b")).toEqual({ title: "Plain & simple", description: "Just the page", site: "example.org", image: "https://www.example.org/a/img/c.jpg", url: "https://www.example.org/a/b" });
    const og = `<meta content="OG title" property="og:title"><meta property="og:site_name" content="Site"><meta property="og:image" content="javascript:alert(1)">`;
    expect(parseMeta(og, "https://x.com/")).toMatchObject({ title: "OG title", site: "Site", image: null });
    expect(decodeEntities("&#x2019;&#8216;&pound;5 &hellip;")).toBe("’‘£5 …");
  });
  test("loopback, private, link-local (cloud metadata), CGNAT and unique-local addresses are refused", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "nonsense",
      // IPv6 spellings of private IPv4 addresses, as new URL() writes them
      "::ffff:7f00:1", "[::ffff:a9fe:a9fe]", "::7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "0:0:0:0:0:ffff:7f00:1",
      "198.18.0.1", "192.0.0.8", "240.0.0.1", "ff02::1"]) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "151.101.0.81", "172.32.0.1", "2a00:1450:4009::200e", "::ffff:808:808", "2002:808:808::"]) expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("egress: connections go to the address that was checked (DNS rebinding)", () => {
  const { safeFetch } = require("../src/weblinks");
  const { pinnedFetch, vetAddresses } = require("../src/egress");
  const { callAddresses } = require("../src/llm");

  /** A resolver that answers with a public address the first time and a private one after, as a
   *  rebinding name does; it counts how often it's asked. */
  const rebinding = () => {
    const asked: string[] = [];
    const resolve = async (host: string) => {
      asked.push(host);
      return asked.filter((h) => h === host).length === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
    };
    return { asked, resolve };
  };
  /** A fetch that records where it was sent and answers with the queued responses. */
  const recorder = (...answers: (() => Response)[]) => {
    const sent: { url: string; host: string | null; serverName?: string }[] = [];
    const fetch = async (url: string, init: any) => {
      sent.push({ url, host: new Headers(init.headers).get("host"), serverName: init.tls?.serverName });
      return (answers.shift() ?? (() => new Response("<title>ok</title>", { headers: { "content-type": "text/html" } })))();
    };
    return { sent, fetch };
  };

  test("a weblink is fetched from the checked address, with its own name as Host and TLS server name; the name is looked up once", async () => {
    const { asked, resolve } = rebinding();
    const { sent, fetch } = recorder();
    const { res, url } = await safeFetch("https://rebind.example/a?b=1", "text/html", { resolve, fetch });
    expect(res.status).toBe(200);
    expect(url.toString()).toBe("https://rebind.example/a?b=1");
    expect(asked).toEqual(["rebind.example"]); // the second (private) answer is never asked for
    expect(sent).toEqual([{ url: "https://93.184.216.34/a?b=1", host: "rebind.example", serverName: "rebind.example" }]);
  });

  test("every redirect is looked up, checked and pinned again: a hop to a name that answers privately is refused", async () => {
    const { asked, resolve } = rebinding();
    const resolveNext = async (h: string) => (h === "next.example" ? ["10.0.0.5"] : resolve(h));
    const { sent, fetch } = recorder(() => new Response(null, { status: 302, headers: { location: "http://next.example/b" } }));
    await expect(safeFetch("http://rebind.example/a", "text/html", { resolve: resolveNext, fetch })).rejects.toMatchObject({ status: 400 });
    expect(sent.map((s) => s.url)).toEqual(["http://93.184.216.34/a"]);
    expect(asked).toEqual(["rebind.example"]);

    const ok = recorder(() => new Response(null, { status: 301, headers: { location: "https://[2a00:1450:4009::200e]/c" } }), () => new Response(null, { status: 302, headers: { location: "/d" } }));
    const r2 = await safeFetch("http://rebind.example/a", "text/html", { resolve: rebinding().resolve, fetch: ok.fetch });
    expect(r2.url.toString()).toBe("https://[2a00:1450:4009::200e]/d");
    expect(ok.sent).toEqual([
      { url: "http://93.184.216.34/a", host: "rebind.example", serverName: undefined },
      { url: "https://[2a00:1450:4009::200e]/c", host: "[2a00:1450:4009::200e]", serverName: undefined }, // an address needs no SNI
      { url: "https://[2a00:1450:4009::200e]/d", host: "[2a00:1450:4009::200e]", serverName: undefined },
    ]);
  });

  test("a name with any private address among its answers is refused before anything is sent", async () => {
    const { sent, fetch } = recorder();
    await expect(safeFetch("https://mixed.example/", "text/html", { resolve: async () => ["93.184.216.34", "169.254.169.254"], fetch })).rejects.toMatchObject({ status: 400 });
    expect(sent).toEqual([]);
    await expect(vetAddresses(new URL("https://nowhere.example/"), { resolve: async () => [] })).rejects.toMatchObject({ reason: "unresolved" });
    expect(await vetAddresses(new URL("http://[::1]:3000/"), { allowPrivate: true })).toEqual(["::1"]);
  });

  test("the next checked address is tried when one can't be reached; the name is never looked up again", async () => {
    const tried: string[] = [];
    const res = await pinnedFetch(new URL("https://two.example/x"), ["2001:db8::1", "93.184.216.34"], { redirect: "manual" }, async (url: string) => {
      tried.push(url);
      if (tried.length === 1) throw new Error("ECONNREFUSED");
      return new Response("ok");
    });
    expect(await res.text()).toBe("ok");
    expect(tried).toEqual(["https://[2001:db8::1]/x", "https://93.184.216.34/x"]);
    await expect(pinnedFetch(new URL("https://two.example/x"), ["93.184.216.34"], {})).rejects.toThrow(/redirects/);
  });

  test("assistants' base URLs: resolved at call time, private answers refused, local models only where allowed", async () => {
    await expect(callAddresses(new URL("https://api.rebind.example/v1"), async () => ["10.1.2.3"])).rejects.toMatchObject({ status: 400 });
    await expect(callAddresses(new URL("http://api.example.com/v1"), async () => ["93.184.216.34"])).rejects.toMatchObject({ status: 400 }); // https only
    expect(await callAddresses(new URL("https://api.example.com/v1"), async () => ["93.184.216.34"])).toEqual(["93.184.216.34"]);
    const env = { ...process.env };
    try {
      process.env.NODE_ENV = "production";
      delete process.env.ALLOW_LOCAL_AI;
      await expect(callAddresses(new URL("http://localhost:11434/v1"))).rejects.toMatchObject({ status: 400 });
      process.env.ALLOW_LOCAL_AI = "true";
      expect(await callAddresses(new URL("http://localhost:11434/v1"))).toEqual(["127.0.0.1", "::1"]);
    } finally {
      process.env.NODE_ENV = env.NODE_ENV;
      if (env.ALLOW_LOCAL_AI === undefined) delete process.env.ALLOW_LOCAL_AI;
      else process.env.ALLOW_LOCAL_AI = env.ALLOW_LOCAL_AI;
    }
  });

  // The real thing: Bun's fetch, pinned to 127.0.0.1, against a TLS server whose certificate is for
  // pinned.test. It must send pinned.test as Host and SNI and check the certificate against that
  // name (not the address), so pinning keeps https exactly as strict.
  const tmp = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "cp-tls-"));
  const made = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", `${tmp}/key.pem`, "-out", `${tmp}/cert.pem`, "-days", "2", "-subj", "/CN=pinned.test", "-addext", "subjectAltName=DNS:pinned.test"], { stderr: "ignore", stdout: "ignore" });
  test.skipIf(!made.success)("over real TLS: the pinned connection sends the name and checks the certificate against it", async () => {
    const cert = require("node:fs").readFileSync(`${tmp}/cert.pem`, "utf8");
    const key = require("node:fs").readFileSync(`${tmp}/key.pem`, "utf8");
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { cert, key }, fetch: (req) => new Response(`host=${req.headers.get("host")}`) });
    try {
      const at = (name: string) => new URL(`https://${name}:${server.port}/`);
      const res = await pinnedFetch(at("pinned.test"), ["127.0.0.1"], { redirect: "manual", tls: { ca: cert } });
      expect(await res.text()).toBe(`host=pinned.test:${server.port}`);
      // The same address under another name: the certificate doesn't match, so it's refused.
      await expect(pinnedFetch(at("evil.test"), ["127.0.0.1"], { redirect: "manual", tls: { ca: cert } })).rejects.toThrow();
    } finally {
      server.stop(true);
      require("node:fs").rmSync(tmp, { recursive: true, force: true });
    }
  });
});
