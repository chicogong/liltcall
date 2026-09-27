import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pseudoTypes = new Set(["cameraUpdate", "restoreCheckpoint", "delete"]);

export function headingIds(markdown) {
  const seen = new Map();
  return new Set(withoutCode(markdown).split("\n").flatMap((line) => {
    const match = /^#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line);
    if (!match) return [];
    const slug = match[1].toLowerCase().replace(/<[^>]+>/g, "")
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "").replace(/\s/g, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    return [count ? `${slug}-${count}` : slug];
  }));
}

function withoutCode(markdown) {
  return markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
}

// Check only publishable repository files. This is not a remote URL checker,
// a full Markdown parser, a secret scanner, or visual proof of a fresh export.
export function auditFiles(contents) {
  const errors = [];
  for (const [file, text] of contents) {
    if (/(^|\/)(?:\.private|\.venv|node_modules|\.vercel|\.wrangler)(\/|$)/.test(file)
      || /(?:^|\/)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?)$/.test(file) && !file.endsWith(".example")
      || /\.(?:pem|key|p8|p12)$/.test(file)
      || file === "apps/edge/wrangler.production.jsonc") errors.push(`${file}: private/generated file in publication set`);
    if (file.endsWith(".md")) {
      for (const match of withoutCode(text).matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)) {
        const href = match[1];
        if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) continue;
        let target, fragment;
        try {
          const hash = href.indexOf("#");
          target = decodeURIComponent(hash < 0 ? href : href.slice(0, hash));
          fragment = hash < 0 ? "" : decodeURIComponent(href.slice(hash + 1));
        } catch { errors.push(`${file}: malformed link ${href}`); continue; }
        const resolved = target ? path.posix.normalize(path.posix.join(path.posix.dirname(file), target)) : file;
        if (target.startsWith("/") || resolved.startsWith("../") || !contents.has(resolved)) {
          errors.push(`${file}: missing/unpublishable link ${href}`);
        } else if (fragment && resolved.endsWith(".md") && !headingIds(contents.get(resolved)).has(fragment)) {
          errors.push(`${file}: missing heading ${href}`);
        }
      }
    }
    if (file.endsWith(".excalidraw")) {
      try {
        const scene = JSON.parse(text);
        if (scene.type !== "excalidraw" || !Array.isArray(scene.elements) || !scene.elements.length) throw new Error("invalid native scene");
        if (scene.files && Object.keys(scene.files).length) throw new Error("embedded files are not allowed in public diagrams");
        const ids = new Set();
        for (const element of scene.elements) {
          if (!element.id || ids.has(element.id) || pseudoTypes.has(element.type) || "label" in element) throw new Error("duplicate/missing ID or MCP-only element");
          ids.add(element.id);
        }
        if (!contents.has(file.replace(/\.excalidraw$/, ".png"))) throw new Error("missing PNG preview");
      } catch (error) { errors.push(`${file}: ${error.message}`); }
    }
  }
  return errors;
}

export function verifyRepository() {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const contents = new Map([...new Set(files)].map((file) => [file,
    /\.(?:md|excalidraw)$/.test(file) ? readFileSync(path.join(root, file), "utf8") : ""]));
  const errors = auditFiles(contents);
  if (errors.length) throw new Error(errors.join("\n"));
  return { files: contents.size, documents: files.filter((f) => f.endsWith(".md")).length,
    diagrams: files.filter((f) => f.endsWith(".excalidraw")).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log("Documentation/publication checks passed:", verifyRepository()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
