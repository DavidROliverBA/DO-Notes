// Day One import (F24 release 2, src/dayone.ts): turning its entries into journal entries.
// The e2e test imports a whole export; these check the text, the times and the zip reading.

import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { entryMarkdown, localWhen, readExport } from "../src/dayone";

describe("Day One entries", () => {
  test("titles turn bold, escapes go, tags follow, attachments embed or drop", () => {
    const text = "# Church Norton\nWalked 3\\.5 miles \\- lovely\\! Mr\\. Smith\\'s dog\\_name\n\n\n![](dayone-moment://AB12)\n![](dayone-moment:/video/CD34)\n";
    expect(entryMarkdown({ uuid: "1", creationDate: "", text, tags: ["Sunday Lunch", "walks"] }, new Map([["AB12", "attachments/Day One/x.jpeg"]]))).toBe(
      "**Church Norton**\nWalked 3.5 miles - lovely! Mr. Smith\\'s dog_name\n\n![[attachments/Day One/x.jpeg]]\n\n#Sunday-Lunch #walks",
    );
    expect(entryMarkdown({ uuid: "2", creationDate: "", text: "\n" })).toBe("");
    expect(entryMarkdown({ uuid: "3", creationDate: "", text: "", tags: ["x"] })).toBe(""); // tags alone aren't an entry
  });

  test("the time is where the entry was written", () => {
    expect(localWhen("2019-07-14T23:30:00Z", "Europe/London")).toEqual({ day: "2019-07-15", time: "00:30" });
    expect(localWhen("2019-07-14T23:30:00Z", "America/Los_Angeles")).toEqual({ day: "2019-07-14", time: "16:30" });
    expect(localWhen("2019-01-14T09:05:00Z", "Not/AZone")).toEqual({ day: "2019-01-14", time: "09:05" }); // the server's zone (London, winter)
    expect(localWhen("nonsense")).toBeNull();
  });

  test("a zip of journals: every journal's entries, media matched by md5, junk refused", () => {
    const md5 = "0123456789abcdef0123456789abcdef";
    const zip = zipSync({
      "Journal.json": strToU8(JSON.stringify({ metadata: { version: "1.0" }, entries: [{ uuid: "a", creationDate: "2020-01-01T10:00:00Z", text: "One ![](dayone-moment://P1)", photos: [{ identifier: "P1", md5, type: "jpeg" }] }] })),
      "Travel.json": strToU8(JSON.stringify({ entries: [{ uuid: "b", creationDate: "2020-01-02T10:00:00Z", text: "Two" }] })),
      [`photos/${md5}.jpeg`]: new Uint8Array([1, 2, 3]),
    });
    const r = readExport("export.zip", zip);
    expect(r.entries.map((e) => e.uuid).sort()).toEqual(["a", "b"]);
    expect(r.files.get("P1")?.name).toBe(`${md5}.jpeg`);
    expect(() => readExport("x.zip", new Uint8Array([1, 2, 3]))).toThrow("isn't a zip");
    expect(() => readExport("x.zip", zipSync({ "notes.md": strToU8("# hi") }))).toThrow("No Day One entries");
  });
});
