import { expect, test } from "bun:test";
import { cleanTask, namesPerson, remindAt } from "../src/reminders";

test("a task names a person by @first name, @full name or a link to them, in any case", () => {
  expect(namesPerson("Ring the plumber @david", "David Oliver")).toBe(true);
  expect(namesPerson("Ask @David Oliver", "David Oliver")).toBe(true);
  expect(namesPerson("For [[David Oliver]] 📅 2026-11-02", "David Oliver")).toBe(true);
  expect(namesPerson("For [[David Oliver|Dad]]", "David Oliver")).toBe(true);
  expect(namesPerson("Ask @davidson", "David Oliver")).toBe(false);
  expect(namesPerson("David will do it", "David Oliver")).toBe(false);
  expect(namesPerson("anything", " ")).toBe(false);
});

test("the task's own time wins; otherwise the person's time on the due date", () => {
  expect(remindAt("Vet ⏰ 14:30 📅 2026-11-02", "2026-11-02", "09:00")).toBe("2026-11-02T14:30");
  expect(remindAt("Vet ⏰ 2026-11-01 8:05 📅 2026-11-02", "2026-11-02", "09:00")).toBe("2026-11-01T08:05");
  expect(remindAt("Vet 📅 2026-11-02", "2026-11-02", "07:30")).toBe("2026-11-02T07:30");
});

test("what an alert says leaves out the Tasks format's markers", () => {
  expect(cleanTask("Call the vet ⏰ 14:30 📅 2026-11-02 ⏫")).toBe("Call the vet");
  expect(cleanTask("Pay rent 🔁 every month 📅 2026-11-02")).toBe("Pay rent");
  expect(cleanTask("Plain words")).toBe("Plain words");
});
