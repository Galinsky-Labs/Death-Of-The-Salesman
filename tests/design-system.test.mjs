import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../apps/web/app/styles.css", import.meta.url), "utf8");
const page = await readFile(new URL("../apps/web/app/page.tsx", import.meta.url), "utf8");
const primitives = await readFile(new URL("../apps/web/app/ui-primitives.tsx", import.meta.url), "utf8");

const hexToRgb = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

const luminance = (hex) => {
  const channels = hexToRgb(hex).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

const contrast = (foreground, background) => {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
};

test("dark and light text tokens meet WCAG AA contrast", () => {
  assert.ok(contrast("#f4f7fb", "#08111f") >= 4.5);
  assert.ok(contrast("#b7c3d4", "#08111f") >= 4.5);
  assert.ok(contrast("#132033", "#f4f7fb") >= 4.5);
  assert.ok(contrast("#4c5d72", "#f4f7fb") >= 4.5);
  assert.match(css, /:root\[data-theme="light"\]/);
  assert.match(css, /:root\[data-density="compact"\]/);
});

test("theme supports accessible responsive interaction states", () => {
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /max-width: 767px/);
  assert.match(css, /max-width: 359px/);
  assert.match(page, /state=\{service\.state\}/);
  for (const label of ["Ready", "Local only", "Disabled"]) assert.match(page, new RegExp(label));
});

test("shell contains no decorative salesman quote", () => {
  assert.doesNotMatch(page, /quote|quotation|blockquote/i);
});

test("reusable primitives retain native keyboard and screen-reader contracts", () => {
  assert.match(primitives, /<button className="command-button" type="button"/);
  assert.match(primitives, /<details className="popover">/);
  assert.match(primitives, /<summary>\{label\}<\/summary>/);
  assert.match(primitives, /role="dialog"/);
  assert.match(primitives, /aria-modal="false"/);
  assert.match(primitives, /<figure className="metric-chart"/);
  assert.match(primitives, /<figcaption/);
  assert.match(primitives, /role="status" aria-live="polite"/);
  assert.match(primitives, /aria-label=\{\`Review \$\{name\} details\`\}/);
});

test("status, charts, avatars, loading and overlays expose readable evidence", () => {
  assert.match(primitives, /<span>\{label\}<\/span>/, "status chip must render a text label beside its light");
  assert.match(primitives, /aria-hidden="true"/);
  assert.match(page, /Waiting — no provider/);
  assert.match(page, /Inactive — dispatch disabled/);
  assert.match(page, /Synthetic work evidence/);
  assert.match(page, /Loading synthetic campaign summary/);
  assert.match(page, /Approval details/);
  assert.doesNotMatch(page, /<img|https?:\/\//, "preview must not introduce unlicensed remote avatar imagery");
});

test("primitive layout is responsive and focus states do not depend on hover", () => {
  assert.match(css, /\.agent-grid, \.primitive-grid/);
  assert.match(css, /max-width: 900px/);
  assert.match(css, /max-width: 520px/);
  assert.match(css, /\.command-button:hover/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});


test("workspace navigation exposes keyboard and screen-reader contracts", async () => {
  const navigation = await readFile(new URL("../apps/web/app/workspace-navigation.tsx", import.meta.url), "utf8");
  assert.match(navigation, /aria-label="Workspace navigation"/);
  assert.match(navigation, /aria-expanded=\{!collapsed\}/);
  assert.match(navigation, /aria-controls="primary-navigation"/);
  assert.match(navigation, /role="search"/);
  assert.match(navigation, /htmlFor="project-search"/);
  assert.match(navigation, /aria-label=\{preview \? "Notifications, 2 unread" : "Notifications not loaded"\}/);
  assert.match(navigation, /<details className="user-controls">/);
  assert.match(navigation, /aria-label="Mobile workspace tabs"/);
});

test("workspace navigation covers every required responsive width without hover dependency", () => {
  for (const width of ["1024px", "768px", "390px", "320px"]) {
    assert.match(css, new RegExp(`max-width: ${width.replace(".", "\\.")}`));
  }
  assert.match(css, /grid-template-columns: 248px minmax\(0, 1fr\)/);
  assert.match(css, /\.workspace-body \{ min-width: 0; \}/);
  assert.match(css, /\.mobile-tabs \{[\s\S]*display: none;/);
  assert.match(css, /\.mobile-tabs[\s\S]*position: fixed/);
});

