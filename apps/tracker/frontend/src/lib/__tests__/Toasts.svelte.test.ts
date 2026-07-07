import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";

import Toasts from "$lib/Toasts.svelte";

test("renders the current toast message", async () => {
  render(Toasts, { props: { toast: { msg: "Added to Faves", kind: "ok" } } });
  await expect.element(page.getByText("Added to Faves")).toBeVisible();
});

test("error toasts carry the .err modifier", async () => {
  render(Toasts, { props: { toast: { msg: "Couldn't add", kind: "err" } } });
  await expect.element(page.getByRole("status")).toHaveClass(/err/);
});

test("renders nothing when there is no toast", async () => {
  render(Toasts, { props: { toast: null } });
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
});
