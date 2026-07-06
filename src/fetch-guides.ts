/**
 * Build-time fetcher for the bundled OpenL reference documentation.
 *
 * `npm run build` runs this (as dist/fetch-guides.js) after tsc. It downloads
 * the documentation folders from the openl-tablets product repository at the
 * PINNED ref configured in package.json (`openlDocs`) — the release tag
 * matching the OpenL Studio version this server targets — and writes the
 * guides/ bundle at the package root: an index.json manifest plus one markdown
 * body per document. {@link file://./guides-registry.ts} reads that bundle at
 * runtime for the openl_list_guides / openl_get_guides tools.
 *
 * The bundle is a build artifact: git-ignored here, shipped in the npm package.
 * The docs are deliberately NOT committed to this repository, and never fetched
 * at runtime — embedding at build time keeps the server offline-friendly and
 * the docs version-matched to the product.
 *
 * The download is a shallow, blob-filtered sparse git clone (a few MB) rather
 * than per-file HTTP: raw.githubusercontent.com rate-limits unauthenticated
 * clients far below the ~90 files needed, while the git protocol has no such
 * limit. A bundle already at the configured repo+ref is left untouched so
 * repeat builds are offline; pass --force to refetch.
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { GuideEntry, GuidesIndex, GuideType } from "./guides-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Where the documentation lives inside the product repository, per document type. */
const DOC_SOURCES: ReadonlyArray<{ type: GuideType; repoDir: string }> = [
  { type: "specification", repoDir: "Docs/ref" },
  { type: "guide", repoDir: "Docs/user-guides/reference-guide" },
];

/** The GitHub repository (owner/name) and ref the documentation is fetched at. */
export interface DocsOrigin {
  repo: string;
  ref: string;
}

/** One source markdown document handed to {@link buildGuideBundle}. */
export interface GuideSource {
  type: GuideType;
  /** Directory of this source set inside the product repo, e.g. 'Docs/ref'. */
  repoDir: string;
  /** Path of the file relative to repoDir, posix separators. */
  relPath: string;
  content: string;
}

/** Strip a numeric ordering prefix from a path segment: '03-basic-concepts' → 'basic-concepts'. */
export function stripOrderPrefix(segment: string): string {
  return segment.replace(/^\d+-/, "");
}

/**
 * Derive a document's stable id from its source path: drop the .md extension,
 * strip the numeric ordering prefix from every segment, and prefix with the
 * type namespace — 'guide/01-introduction/03-basic-concepts.md' →
 * 'guide/introduction/basic-concepts'. Ordering prefixes are stripped so that
 * re-numbering chapters upstream does not break published ids.
 */
export function deriveGuideId(type: GuideType, relPath: string): string {
  const prefix = type === "specification" ? "spec" : "guide";
  const slug = relPath
    .replace(/\.md$/, "")
    .split("/")
    .map(stripOrderPrefix)
    .join("/");
  return `${prefix}/${slug}`;
}

/**
 * Walk a markdown document's lines with fenced code blocks masked out, so
 * headers and links inside ``` fences (code examples) are never mistaken for
 * document structure. `fn` receives each prose line and returns its
 * replacement; fence lines and fenced content pass through unchanged.
 */
function mapProseLines(markdown: string, fn: (line: string) => string): string {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : fn(line);
    })
    .join("\n");
}

/**
 * The document's first markdown (ATX) header outside code fences, with inline
 * code/emphasis markers stripped — per EPBDS-16156 this doubles as the
 * document's description. Undefined when the document has no header.
 */
export function extractFirstHeader(markdown: string): string | undefined {
  let title: string | undefined;
  mapProseLines(markdown, (line) => {
    if (title === undefined) {
      const match = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
      if (match) {
        title = match[1].replace(/[`*]/g, "").trim();
      }
    }
    return line;
  });
  return title;
}

/** Fallback title for a document with no header, from its file name: '02-what-is-openl.md' → 'What is openl'. */
export function titleFromFilename(relPath: string): string {
  const base = stripOrderPrefix(posix.basename(relPath, ".md"));
  const words = base.split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Rewrite relative markdown link/image targets to absolute GitHub URLs, so the
 * bundled bodies stay self-contained: the referenced images and neighbouring
 * documents are NOT part of the bundle, and a relative path would dangle.
 * Images point at raw content (renderable/fetchable), other links at the blob
 * page. Absolute URLs, anchors, and mailto:/data: targets are left untouched,
 * as is anything inside fenced code blocks. Targets escaping the repository
 * root are left unchanged (nothing sensible to point at).
 *
 * @param sourceDir - Directory of the document inside the product repo, used
 *                    to resolve relative targets.
 */
export function rewriteRelativeUrls(markdown: string, sourceDir: string, origin: DocsOrigin): string {
  const resolveTarget = (target: string, isImage: boolean): string => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("//")) {
      return target;
    }
    const [path, fragment] = splitFragment(target);
    if (path === "") {
      return target;
    }
    const resolved = posix.normalize(posix.join(sourceDir, path));
    if (resolved.startsWith("..")) {
      return target;
    }
    const base = isImage
      ? `https://raw.githubusercontent.com/${origin.repo}/${origin.ref}/`
      : `https://github.com/${origin.repo}/blob/${origin.ref}/`;
    return base + resolved + fragment;
  };

  return mapProseLines(markdown, (line) =>
    line
      // Images first, then links; the lookbehind keeps the link pass off the
      // (already rewritten) image syntax.
      .replace(
        /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g,
        (_m, text: string, target: string, title: string | undefined) =>
          `![${text}](${resolveTarget(target, true)}${title ?? ""})`,
      )
      .replace(
        /(?<!!)\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g,
        (_m, text: string, target: string, title: string | undefined) =>
          `[${text}](${resolveTarget(target, false)}${title ?? ""})`,
      ),
  );
}

/** Split '#fragment' off a link target; returns ['path', '#fragment' | '']. */
function splitFragment(target: string): [string, string] {
  const hash = target.indexOf("#");
  return hash === -1 ? [target, ""] : [target.slice(0, hash), target.slice(hash)];
}

/**
 * Turn the source documents into the bundle: index entries plus the (URL-
 * rewritten) bodies keyed by id. Entries are ordered specifications first,
 * then guides in the source documentation's reading order (paths sort in
 * reading order thanks to the zero-padded numeric prefixes).
 *
 * @throws Error when two documents derive the same id (e.g. '01-foo.md' and
 *         '02-foo.md' in one folder) — ids are the public contract, so the
 *         build must fail rather than silently drop a document.
 */
export function buildGuideBundle(
  sources: GuideSource[],
  origin: DocsOrigin,
  generatedAt: string,
): { index: GuidesIndex; bodies: Map<string, string> } {
  const ordered = [...sources].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "specification" ? -1 : 1;
    }
    return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;
  });

  const entries: GuideEntry[] = [];
  const bodies = new Map<string, string>();
  const idSources = new Map<string, string>();

  for (const source of ordered) {
    const id = deriveGuideId(source.type, source.relPath);
    const sourcePath = `${source.repoDir}/${source.relPath}`;
    const conflict = idSources.get(id);
    if (conflict) {
      throw new Error(
        `Guide id collision: '${conflict}' and '${sourcePath}' both derive the id '${id}'. ` +
          `Ids are stable references — rename one of the source files upstream.`,
      );
    }
    idSources.set(id, sourcePath);

    const body = rewriteRelativeUrls(source.content, posix.dirname(sourcePath), origin);
    entries.push({
      id,
      type: source.type,
      title: extractFirstHeader(body) ?? titleFromFilename(source.relPath),
      path: `${id}.md`,
      source_path: sourcePath,
      size_bytes: Buffer.byteLength(body, "utf-8"),
    });
    bodies.set(id, body);
  }

  return {
    index: {
      schema_version: 1,
      source_repo: origin.repo,
      source_ref: origin.ref,
      generated_at: generatedAt,
      guides: entries,
    },
    bodies,
  };
}

/**
 * The pinned docs origin from package.json (`openlDocs: { repo, ref }`), the
 * single place stating which product version's docs get bundled. OPENL_DOCS_REF
 * overrides the ref for one-off builds against another tag.
 */
function readDocsOrigin(): DocsOrigin {
  const pkg = createRequire(import.meta.url)("../package.json") as {
    openlDocs?: { repo?: string; ref?: string };
  };
  const repo = pkg.openlDocs?.repo;
  const ref = process.env.OPENL_DOCS_REF || pkg.openlDocs?.ref;
  if (!repo || !ref) {
    throw new Error("package.json is missing the 'openlDocs' { repo, ref } configuration.");
  }
  return { repo, ref };
}

/** Whether the existing bundle was already generated from this repo+ref. */
function bundleIsFresh(outDir: string, origin: DocsOrigin): boolean {
  try {
    const index = JSON.parse(readFileSync(join(outDir, "index.json"), "utf-8")) as GuidesIndex;
    return index.source_repo === origin.repo && index.source_ref === origin.ref;
  } catch {
    return false;
  }
}

function runGit(args: string[]): void {
  try {
    execFileSync("git", args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: Buffer };
    if (e.code === "ENOENT") {
      throw new Error("git is required to fetch the OpenL docs bundle but was not found on PATH.");
    }
    const stderr = e.stderr ? e.stderr.toString("utf-8").trim() : e.message;
    throw new Error(`git ${args[0]} failed: ${stderr}`);
  }
}

/**
 * Shallow, blob-filtered sparse clone of just the documentation folders —
 * a few MB instead of the full product repository.
 */
function cloneDocsSparse(origin: DocsOrigin, tmpDir: string): void {
  runGit([
    "clone",
    "--depth",
    "1",
    "--branch",
    origin.ref,
    "--filter=blob:none",
    "--sparse",
    `https://github.com/${origin.repo}.git`,
    tmpDir,
  ]);
  runGit(["-C", tmpDir, "sparse-checkout", "set", ...DOC_SOURCES.map((s) => s.repoDir)]);
}

/**
 * Relative posix paths of every markdown document under `root`, sorted.
 * `index.md` files are tables of contents — openl_list_guides IS the index,
 * so they are excluded rather than bundled as near-duplicate content.
 */
function listMarkdownFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md")
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

function writeBundle(outDir: string, index: GuidesIndex, bodies: Map<string, string>): void {
  rmSync(outDir, { recursive: true, force: true });
  for (const entry of index.guides) {
    const body = bodies.get(entry.id);
    if (body === undefined) {
      throw new Error(`No body built for guide '${entry.id}'.`);
    }
    const file = join(outDir, ...entry.path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body, "utf-8");
  }
  writeFileSync(join(outDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf-8");
}

/** Build-script progress output (stdout is fine here — this never runs inside the MCP server). */
function print(message: string): void {
  process.stdout.write(`${message}\n`);
}

function main(): void {
  const force = process.argv.includes("--force");
  const origin = readDocsOrigin();
  const outDir = join(__dirname, "..", "guides");

  if (!force && bundleIsFresh(outDir, origin)) {
    print(`Guides bundle already at ${origin.repo}@${origin.ref}; skipping fetch (--force to refetch).`);
    return;
  }

  print(`Fetching OpenL documentation from ${origin.repo}@${origin.ref}...`);
  const tmpDir = mkdtempSync(join(tmpdir(), "openl-docs-"));
  try {
    cloneDocsSparse(origin, tmpDir);

    const sources: GuideSource[] = [];
    for (const { type, repoDir } of DOC_SOURCES) {
      const root = join(tmpDir, ...repoDir.split("/"));
      for (const relPath of listMarkdownFiles(root)) {
        sources.push({
          type,
          repoDir,
          relPath,
          content: readFileSync(join(root, ...relPath.split("/")), "utf-8"),
        });
      }
    }

    const { index, bodies } = buildGuideBundle(sources, origin, new Date().toISOString());
    writeBundle(outDir, index, bodies);

    const specCount = index.guides.filter((g) => g.type === "specification").length;
    const totalKb = Math.round(index.guides.reduce((sum, g) => sum + g.size_bytes, 0) / 1024);
    print(
      `Bundled ${specCount} specifications and ${index.guides.length - specCount} guides ` +
        `(${totalKb} KB) into ${outDir}.`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Run only when invoked directly (node dist/fetch-guides.js); importing the
// module for its pure functions (tests) must stay side-effect free.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`fetch-guides: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
