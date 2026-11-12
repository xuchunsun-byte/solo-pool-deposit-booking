import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { APP_ROOT } from "./env.js";

const cache = new Map();

export function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function apply(template, vars) {
  return template
    .replaceAll(/\{\{\{([\w.]+)\}\}\}/g, (_, key) => String(lookup(vars, key) ?? ""))
    .replaceAll(/\{\{([\w.]+)\}\}/g, (_, key) => escapeHtml(lookup(vars, key) ?? ""));
}

function lookup(vars, key) {
  return key.split(".").reduce((acc, part) => (acc == null ? acc : acc[part]), vars);
}

export function render(name, vars = {}) {
  const path = resolve(APP_ROOT, "templates", name);
  if (!cache.has(path)) cache.set(path, readFileSync(path, "utf8"));
  const body = apply(cache.get(path), vars);
  if (name === "layout.html") return body;
  const layout = render("layout.html", { ...vars, body });
  return layout;
}

export function clearViewCache() {
  cache.clear();
}
