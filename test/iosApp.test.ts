import { expect, test } from "bun:test";
import { appSiteAssociation } from "../src/iosApp";

test("the iPhone app opens the app's pages, not the API, published sites or sign-ins", () => {
  const a = appSiteAssociation(["ABCDE12345.com.davidroliver.commonplace"]);
  const d = a.applinks.details[0]!;
  expect(d.appIDs).toEqual(["ABCDE12345.com.davidroliver.commonplace"]);
  const excluded = d.components.filter((c) => "exclude" in c).map((c) => c["/"]);
  expect(excluded).toEqual(expect.arrayContaining(["/api/*", "/p/*", "/oauth/*"]));
  // The catch-all comes last: Apple applies the first component that matches.
  expect(d.components.at(-1)).toEqual({ "/": "/*" });
  expect(a.webcredentials.apps).toEqual(["ABCDE12345.com.davidroliver.commonplace"]);
});
