// The source scope: which configured collection the library shows.
//
// The behaviour that matters is the *default*. With two collections in one
// library, a source you didn't pick must stay out of the list — and therefore
// out of the play queue, which is exactly the visible order. Mixing is opt-in.
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { FIXTURE_XM } from "../../../../packages/player/testing/playback-smoke";
import type { Track } from "../src/lib/api";
import { mockLibrary } from "./mock-api";

const BYTES = readFileSync(FIXTURE_XM);

const mk = (id: number, collection: string, group: string, ext: string) => ({
  id,
  hash: `h${id}`,
  md5: `h${id}`,
  path: `${group}/tune${id}.${ext}`,
  collection,
  group,
  artist: null,
  filename: `tune${id}.${ext}`,
  ext,
  size: BYTES.length,
  title: `Tune ${id}`,
  type_long: "Module",
  tracker: "PT",
  duration: 10,
  channels: 4,
  instruments: 0,
  samples: 0,
  favorite: false,
  play_count: 0,
});

const tracks = [
  mk(1, "mods", "Alpha", "mod"),
  mk(2, "mods", "Beta", "mod"),
  mk(3, "hvsc", "Hubbard", "sid"),
] as unknown as Track[];

const TWO_ROOTS = {
  roots: [
    { id: "mods", label: "Mods", kind: "scan", path: "/mods", count: 2 },
    { id: "hvsc", label: "HVSC", kind: "hvsc", path: "/hvsc", count: 1 },
  ],
  hvsc: {
    hvsc: { version: 85, tunes: 61157, subtunes: 87868, indexed_at: "2026-08-05T10:00:00Z" },
  },
};

async function mock(
  context: import("@playwright/test").BrowserContext,
  status: import("./mock-api").StatusOverrides = TWO_ROOTS,
) {
  await mockLibrary(context, tracks, status);
  await context.route("**/api/playlists", (r) => r.fulfill({ json: { playlists: [] } }));
}

test("defaults to the primary collection — an unpicked source stays out", async ({
  context,
  page,
}) => {
  await mock(context);
  await page.goto("/");
  // Only the mods groups; the HVSC tune is not in the list, so shuffle can't
  // reach it either (the queue is the visible order).
  await expect(page.locator(".grp-name")).toHaveText(["Alpha", "Beta"]);
  await expect(page.getByRole("button", { name: /^Mods/ })).toHaveAttribute("aria-pressed", "true");
});

test("switching source scopes the list; All mixes on purpose", async ({ context, page }) => {
  await mock(context);
  await page.goto("/");

  await page.getByRole("button", { name: /^HVSC/ }).click();
  await expect(page.locator(".grp-name")).toHaveText(["Hubbard"]);

  await page.getByRole("button", { name: "All" }).click();
  await expect(page.locator(".grp-name")).toHaveText(["Alpha", "Beta", "Hubbard"]);
});

test("the chosen source survives a reload", async ({ context, page }) => {
  await mock(context);
  await page.goto("/");
  await page.getByRole("button", { name: /^HVSC/ }).click();
  await expect(page.locator(".grp-name")).toHaveText(["Hubbard"]);

  await page.reload();
  // Persisted: a scope you picked yesterday is still the scope today, which is
  // what stops an unexpected collection turning up in shuffle.
  await expect(page.locator(".grp-name")).toHaveText(["Hubbard"]);
});

test("the selector is hidden when only one collection is configured", async ({ context, page }) => {
  await mockLibrary(context, tracks.slice(0, 2));
  await context.route("**/api/playlists", (r) => r.fulfill({ json: { playlists: [] } }));
  await page.goto("/");
  await expect(page.locator(".grp-name")).toHaveText(["Alpha", "Beta"]);
  await expect(page.locator("nav[aria-label='collection']")).toHaveCount(0);
});

test("the HVSC chip carries its release number", async ({ context, page }) => {
  await mock(context);
  await page.goto("/");
  // The release is what makes "is my collection current?" answerable at a
  // glance, and it's the anchor the update dot hangs off.
  await expect(page.getByRole("button", { name: /^HVSC/ })).toContainText("#85");
});

test("reindex acts on the shown collection only, and reports what it did", async ({
  context,
  page,
}) => {
  await mock(context);
  let reindexed: string | null = null;
  await context.route("**/api/rescan/*", (r) => {
    reindexed = new URL(r.request().url()).pathname.split("/").pop() ?? null;
    return r.fulfill({ json: { indexed: 61157, subtunes: 87868, removed: 0, hashed: 0 } });
  });
  await page.goto("/");

  // Scoped to an HVSC source: a scan root rebuilds by walking, which is the
  // expensive operation this button is explicitly *not*.
  await expect(page.getByRole("button", { name: "Reindex" })).toHaveCount(0);

  await page.getByRole("button", { name: /^HVSC/ }).click();
  await page.getByRole("button", { name: "Reindex" }).click();

  await expect(page.locator(".toast")).toContainText("61,157 tunes");
  expect(reindexed).toBe("hvsc");
});

test("a failed reindex says why instead of appearing to do nothing", async ({ context, page }) => {
  await mock(context);
  // What a root pointed at a half-copied collection actually answers.
  await context.route("**/api/rescan/*", (r) =>
    r.fulfill({ status: 400, body: 'root "hvsc" has no DOCUMENTS/Songlengths.md5' }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: /^HVSC/ }).click();
  await page.getByRole("button", { name: "Reindex" }).click();

  await expect(page.locator(".toast.err")).toContainText("Songlengths.md5");
});

test("nothing HVSC-specific renders without a configured HVSC root", async ({ context, page }) => {
  // Two roots, but both scan roots — the selector shows, the HVSC affordances
  // must not. That absence is the feature flag.
  await mock(context, {
    roots: [
      { id: "mods", label: "Mods", kind: "scan", path: "/mods", count: 2 },
      { id: "extra", label: "Extra", kind: "scan", path: "/extra", count: 1 },
    ],
  });
  await page.goto("/");
  await expect(page.locator("nav[aria-label='collection']")).toBeVisible();
  await page.getByRole("button", { name: /^Extra/ }).click();
  await expect(page.getByRole("button", { name: "Reindex" })).toHaveCount(0);
});

test.describe("on a phone", () => {
  // A locale that separates thousands with a space (`61 157`) — the widest the
  // counts ever render, and the condition the overflow was first seen under.
  test.use({ viewport: { width: 320, height: 568 }, locale: "fi-FI" });

  test("every control fits on screen, none scrolled out of reach", async ({ context, page }) => {
    // The row scrolls horizontally with no scrollbar, so anything past the edge
    // is both invisible and silent — which is where `Reindex` ended up: the
    // counts pushed the row to 352px inside a 320px viewport.
    await mock(context, {
      roots: [
        { id: "mods", label: "Mods", kind: "scan", path: "/mods", count: 6478 },
        { id: "hvsc", label: "HVSC", kind: "hvsc", path: "/hvsc", count: 61157 },
      ],
      hvsc: {
        hvsc: { version: 85, tunes: 61157, subtunes: 87868, indexed_at: "2026-08-05T10:00:00Z" },
      },
    });
    await page.goto("/");
    await page.getByRole("button", { name: /^HVSC/ }).click();
    await expect(page.getByRole("button", { name: "Reindex" })).toBeVisible();

    const nav = page.locator("nav.sources");
    expect(
      await nav.evaluate((n) => n.scrollWidth - n.clientWidth),
      "the source row overflows its own width",
    ).toBe(0);

    const box = (await nav.boundingBox())!;
    for (const name of [/^Mods/, /^HVSC/, "All", "Reindex"] as const) {
      const r = await page.getByRole("button", { name }).boundingBox();
      expect(r, `${name} has no box`).not.toBeNull();
      expect(r!.x, `${name} starts off the left edge`).toBeGreaterThanOrEqual(0);
      expect(r!.x + r!.width, `${name} runs past the right edge`).toBeLessThanOrEqual(
        box.x + box.width + 1,
      );
    }
  });

  test("the chips still say which collection, and which release", async ({ context, page }) => {
    // What dropping the counts had to preserve: each source is still
    // identifiable, and HVSC still shows what it's a release of.
    await mock(context);
    await page.goto("/");
    await expect(page.getByRole("button", { name: /^Mods/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^HVSC/ })).toContainText("#85");
  });
});
