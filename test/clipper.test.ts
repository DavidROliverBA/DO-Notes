import { expect, test } from "bun:test";
import { formFor, quoteFor, send } from "../clipper/clip.js";

test("a selection is a quote, line by line, with its page linked", () => {
  expect(quoteFor("Feed the starter\n\nthe night before. ", "Bread [1]", "https://e.com/b")).toBe("> Feed the starter\n>\n> the night before.\n— [Bread 1](https://e.com/b)");
});

test("each kind of clip is the form the share sheet sends", () => {
  const page = formFor({ kind: "page", url: "https://e.com/b", title: "  Bread\n" });
  expect([...page.entries()]).toEqual([["item", "https://e.com/b"], ["url", "https://e.com/b"], ["title", "Bread"]]);
  const sel = formFor({ kind: "selection", url: "https://e.com/b", title: "Bread", selection: "Knead" });
  expect(sel.get("item")).toBe("> Knead\n— [Bread](https://e.com/b)");
  const img = formFor({ kind: "image", url: "https://e.com/b", image: new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), imageName: "loaf.jpg" });
  expect((img.get("photo") as File).name).toBe("loaf.jpg");
  // An empty selection saves the page instead.
  expect(formFor({ kind: "selection", url: "https://e.com/b", selection: "  " }).get("url")).toBe("https://e.com/b");
});

test("the token goes in the header, never the address; problems are said plainly", async () => {
  let seen = { url: "", auth: null as string | null };
  const ok = async (url: URL, init: RequestInit) => {
    seen = { url: String(url), auth: new Headers(init.headers).get("authorization") };
    return Response.json({ ok: true, message: "Saved it to Inbox" });
  };
  expect(await send({ server: "https://skein.example", token: "cpc_x" }, { kind: "page", url: "https://e.com" }, ok)).toEqual({ ok: true, message: "Saved it to Inbox" });
  expect(seen).toEqual({ url: "https://skein.example/api/capture", auth: "Bearer cpc_x" });
  expect((await send({ server: "", token: "" }, { kind: "page", url: "https://e.com" })).message).toContain("Set up the clipper");
  const down = async () => {
    throw new TypeError("network");
  };
  expect((await send({ server: "https://skein.example", token: "t" }, { kind: "page", url: "https://e.com" }, down)).message).toBe("Couldn't reach DO Notes, so nothing was saved.");
});
