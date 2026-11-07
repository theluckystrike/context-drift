'use strict';
/*
 * Context Drift engine. Pure CommonJS, zero runtime dependencies.
 * Finds statements in agent instruction files (AGENTS.md, CLAUDE.md, ...)
 * that no longer match the repository.
 *
 * Positions are 0-based; columns are UTF-16 code units (same as VS Code).
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const VERSION = '0.2.0';

const RULES = {
  CD001: { id: 'CD001', name: 'command-drift', defaultSeverity: 'error', description: 'A documented command does not exist in the repo. Error for `npm run X`, `pnpm run X` and `make X` checked against the manifest at the right level; warning for every heuristic form (bare `pnpm X`, `yarn X`, `npm test`, just, task, cargo, uv/poetry).' },
  CD002: { id: 'CD002', name: 'path-drift', defaultSeverity: 'warning', description: 'A referenced relative path does not exist (globs that match nothing are reported as info).' },
  CD003: { id: 'CD003', name: 'package-manager-drift', defaultSeverity: 'warning', description: 'The file uses one package manager but the lockfile / packageManager field says another.' },
  CD004: { id: 'CD004', name: 'version-drift', defaultSeverity: 'warning', description: 'A Node/Python/Go version claim contradicts .nvmrc, .node-version, engines, .python-version, requires-python or go.mod.' },
  CD005: { id: 'CD005', name: 'cross-file-conflict', defaultSeverity: 'info', description: 'Two instruction files in the same scope give different commands for the same verb (test/build/lint/format/dev/typecheck).' },
  CD007: { id: 'CD007', name: 'import-drift', defaultSeverity: 'warning', description: 'An @path import in CLAUDE.md, CLAUDE.local.md or GEMINI.md points to a file that does not exist. Claude Code and Gemini CLI skip a missing import without a warning.' },
  CD008: { id: 'CD008', name: 'codex-size-limit', defaultSeverity: 'warning', description: 'AGENTS.md or AGENTS.override.md is larger than 32 KiB, the default project_doc_max_bytes of Codex. Codex stops loading instructions at that size, so the rest of the file never reaches it.' },
  CD006: { id: 'CD006', name: 'stale-file', defaultSeverity: 'info', description: 'The instruction file has not changed for a long time while the repo kept moving. Off by default (CLI --stale, setting contextDrift.gitStaleness).' },
};

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'vendor', 'target', '.venv', 'venv',
  '__pycache__', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'coverage',
  '.gradle', '.idea', 'Pods', '.terraform', '.tox', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', 'bower_components', '.output', '.parcel-cache', '.yarn', '.pnpm-store',
  'site-packages', '.hg', '.svn', '.direnv', '.eggs',
]);

const MAX_INSTRUCTION_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_WALK_ENTRIES = 200000;
/** Lines longer than this are skipped before any regular expression runs on them. */
const MAX_LINE_CHARS = 4000;
/** At most this many globs per instruction file are checked against the file list. */
const MAX_GLOBS_PER_FILE = 200;
/** Segment comparisons allowed per instruction file for glob checks; past it, globs count as matching. */
const GLOB_WORK_PER_FILE = 3000000;
const MAX_GITIGNORE_RULES = 5000;
/** At most this many inline code spans and links per instruction file are checked. */
const MAX_SPANS_PER_FILE = 20000;

/* ------------------------------------------------------------------ */
/* Instruction file detection                                          */
/* ------------------------------------------------------------------ */

const INSTRUCTION_BASENAMES = new Set([
  'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md', 'SKILL.md',
  '.cursorrules', '.windsurfrules', '.clinerules',
  // Codex reads AGENTS.override.md before AGENTS.md; Devin Desktop (Windsurf) and Amp also read AGENTS.local.md and AGENT.md
  'AGENTS.override.md', 'AGENTS.local.md', 'AGENT.md',
]);

/** Returns a short kind string when rel (posix, relative) is an instruction file, else null. */
function classifyInstructionFile(rel) {
  const p = String(rel).replace(/\\/g, '/');
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (INSTRUCTION_BASENAMES.has(base)) return base;
  if (/(^|\/)\.cursor\/rules\/(?:[^/]+\/)*[^/]+\.mdc$/.test(p)) return 'cursor-rule';
  if (/(^|\/)\.github\/copilot-instructions\.md$/.test(p)) return 'copilot-instructions';
  if (/(^|\/)\.github\/instructions\/(?:[^/]+\/)*[^/]+\.instructions\.md$/.test(p)) return 'copilot-scoped';
  if (/(^|\/)\.clinerules\/(?:[^/]+\/)*[^/]+\.md$/.test(p)) return 'cline-rule';
  if (/(^|\/)\.windsurf\/rules\/(?:[^/]+\/)*[^/]+\.md$/.test(p)) return 'windsurf-rule';
  if (/(^|\/)\.claude\/rules\/(?:[^/]+\/)*[^/]+\.md$/.test(p)) return 'claude-rule';
  if (/(^|\/)\.devin\/rules\/(?:[^/]+\/)*[^/]+\.md$/.test(p)) return 'devin-rule';
  if (/(^|\/)\.kiro\/steering\/(?:[^/]+\/)*[^/]+\.md$/.test(p)) return 'kiro-steering';
  return null;
}

/** Directory whose files the instruction file "governs" (for CD005 grouping). */
function scopeDirOf(rel) {
  // Copilot, Cursor, Cline and Windsurf rule files govern the folder that holds .github/, .cursor/, ...;
  // an AGENTS.md or CLAUDE.md inside .github/ is about that folder only (CI workflows)
  const kind = classifyInstructionFile(rel);
  if (kind && !INSTRUCTION_BASENAMES.has(kind)) {
    const m = /^(.*?)(?:^|\/)(?:\.github|\.cursor|\.clinerules|\.windsurf|\.claude|\.devin|\.kiro)\//.exec(rel);
    if (m) return m[1];
  }
  return posixDirname(rel);
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function posixDirname(rel) {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}
function posixJoin(a, b) {
  if (!a) return normalizeRel(b);
  return normalizeRel(a + '/' + b);
}
/** Normalizes a relative posix path. Returns null when it escapes the root. */
function normalizeRel(p) {
  if (p === null || p === undefined) return null; // an inner join already escaped the root
  const out = [];
  for (const seg of String(p).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}
function ancestors(relDir) {
  const out = [];
  let d = relDir || '';
  for (;;) {
    out.push(d);
    if (!d) break;
    d = posixDirname(d);
  }
  return out;
}
function levenshtein(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function closest(name, candidates) {
  let best = null, bestD = 99;
  for (const c of candidates) {
    const d = levenshtein(name, c);
    if (d < bestD) { best = c; bestD = d; }
  }
  const limit = name.length <= 4 ? 1 : 2;
  return bestD <= limit ? best : null;
}
function isBinaryText(text) {
  const n = Math.min(text.length, 8000);
  for (let i = 0; i < n; i++) if (text.charCodeAt(i) === 0) return true;
  return false;
}
function stripBom(t) { return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t; }
function splitLines(t) { return t.split(/\r\n|\r|\n/); }

/* ---------- linear-time glob matching ---------- */
/*
 * Globs come from repository content (inline code, .mdc frontmatter, .gitignore, Taskfiles), so they
 * are never turned into regular expressions. A glob is split into path segments; each segment is a
 * token list matched with the two-pointer wildcard algorithm (O(n*m), no exponential backtracking),
 * and "**" segments are matched with a dynamic program over (pattern segment, path segment).
 */
const MAX_GLOB_CHARS = 512;
const MAX_GLOB_SEGMENTS = 64;
const MAX_BRACE_EXPANSIONS = 32;

function expandBraces(glob, out, depth) {
  if (out.length > MAX_BRACE_EXPANSIONS || depth > 8) return false;
  let open = -1, level = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') { if (level === 0) open = i; level++; }
    else if (c === '}' && level > 0) {
      level--;
      if (level === 0) {
        const body = glob.slice(open + 1, i);
        const alts = [];
        let l2 = 0, st = 0;
        for (let j = 0; j < body.length; j++) {
          const d = body[j];
          if (d === '\\') { j++; continue; }
          if (d === '{') l2++; else if (d === '}') l2--; else if (d === ',' && l2 === 0) { alts.push(body.slice(st, j)); st = j + 1; }
        }
        alts.push(body.slice(st));
        if (alts.length < 2) continue; // "{x}" is literal
        const pre = glob.slice(0, open), post = glob.slice(i + 1);
        for (const a of alts) { if (!expandBraces(pre + a + post, out, depth + 1)) return false; }
        return true;
      }
    }
  }
  out.push(glob);
  return out.length <= MAX_BRACE_EXPANSIONS;
}

function compileSegment(seg) {
  const toks = [];
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') { if (!toks.length || toks[toks.length - 1].t !== 'star') toks.push({ t: 'star' }); }
    else if (c === '?') toks.push({ t: 'any' });
    else if (c === '[') {
      const end = seg.indexOf(']', i + 2);
      if (end < 0) { toks.push({ t: 'lit', c }); continue; }
      let body = seg.slice(i + 1, end);
      let neg = false;
      if (body[0] === '!' || body[0] === '^') { neg = true; body = body.slice(1); }
      const ranges = [];
      for (let k = 0; k < body.length; k++) {
        if (body[k + 1] === '-' && k + 2 < body.length) { ranges.push([body.charCodeAt(k), body.charCodeAt(k + 2)]); k += 2; }
        else ranges.push([body.charCodeAt(k), body.charCodeAt(k)]);
      }
      toks.push({ t: 'class', neg, ranges });
      i = end;
    } else if (c === '\\' && i + 1 < seg.length) toks.push({ t: 'lit', c: seg[++i] });
    else toks.push({ t: 'lit', c });
  }
  const literal = toks.every((t) => t.t === 'lit');
  return { toks, literal, text: literal ? toks.map((t) => t.c).join('') : null };
}

function tokMatches(tok, ch) {
  if (tok.t === 'lit') return tok.c === ch;
  if (tok.t === 'any') return true;
  const code = ch.charCodeAt(0);
  let hit = false;
  for (const [a, b] of tok.ranges) if (code >= a && code <= b) { hit = true; break; }
  return tok.neg ? !hit : hit;
}

/** Two-pointer wildcard match of one path segment. Worst case O(len(seg) * len(pattern)). */
function segmentMatch(cs, s, budget) {
  if (cs.literal) return cs.text === s;
  const toks = cs.toks;
  let ti = 0, si = 0, starTi = -1, starSi = 0;
  while (si < s.length) {
    if (budget) { if (--budget.left < 0) throw GLOB_BUDGET; }
    if (ti < toks.length && toks[ti].t !== 'star' && tokMatches(toks[ti], s[si])) { ti++; si++; }
    else if (ti < toks.length && toks[ti].t === 'star') { starTi = ti++; starSi = si; }
    else if (starTi >= 0) { ti = starTi + 1; si = ++starSi; }
    else return false;
  }
  while (ti < toks.length && toks[ti].t === 'star') ti++;
  return ti === toks.length;
}

const GLOB_BUDGET = new Error('glob work budget exceeded');

/** Compiles a glob into alternatives of segment lists. Returns null when it is too large to check. */
function compileGlob(glob) {
  glob = String(glob);
  if (glob.length > MAX_GLOB_CHARS) return null;
  const alts = [];
  if (!expandBraces(glob, alts, 0)) return null;
  const out = [];
  for (const a of alts) {
    const segs = [];
    for (const raw of a.split('/')) {
      if (raw === '') continue;
      if (raw === '**') { if (segs[segs.length - 1] !== '**') segs.push('**'); continue; }
      segs.push(compileSegment(raw));
    }
    if (segs.length > MAX_GLOB_SEGMENTS) return null;
    out.push(segs);
  }
  return out;
}

function segsMatch(psegs, ssegs, budget) {
  const P = psegs.length, S = ssegs.length;
  // dp[p][s] for p from P down to 0; only two rows are needed.
  let next = new Uint8Array(S + 1);
  next[S] = 1; // p === P
  for (let p = P - 1; p >= 0; p--) {
    const cur = new Uint8Array(S + 1);
    const ps = psegs[p];
    for (let s = S; s >= 0; s--) {
      if (ps === '**') cur[s] = next[s] || (s < S && cur[s + 1]) ? 1 : 0;
      else cur[s] = s < S && next[s + 1] && segmentMatch(ps, ssegs[s], budget) ? 1 : 0;
    }
    next = cur;
  }
  return next[0] === 1;
}

/** Does the compiled glob match the posix path `p` (whole path)? */
function globMatch(compiled, p, budget) {
  if (!compiled) return false;
  const ssegs = String(p).split('/').filter(Boolean);
  for (const alt of compiled) if (segsMatch(alt, ssegs, budget)) return true;
  return false;
}
function isGlob(s) { return /[*?]|\[[^\]]+\]|\{[^{}]*,[^{}]*\}/.test(s); }

/* ------------------------------------------------------------------ */
/* Repository context (cached facts)                                   */
/* ------------------------------------------------------------------ */

function walk(root) {
  const files = [];
  const dirs = new Set(['']);
  let count = 0;
  let truncated = false;
  const stack = [''];
  while (stack.length && !truncated) {
    const rel = stack.pop();
    let ents;
    try { ents = fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true }); } catch (_) { continue; }
    if (rel && ents.some((e) => e.name === '.git')) continue; // nested repo, worktree or submodule: its own root
    for (const e of ents) {
      if (++count > MAX_WALK_ENTRIES) { truncated = true; break; }
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        dirs.add(r);
        stack.push(r);
      } else if (e.isFile()) {
        files.push(r);
      } else if (e.isSymbolicLink()) {
        try {
          const st = fs.statSync(path.join(root, r));
          if (st.isFile()) files.push(r); else if (st.isDirectory()) dirs.add(r); // never descend into symlinks
        } catch (_) { /* dangling */ }
      }
    }
  }
  return { files, dirs, truncated };
}

/**
 * Builds a cached view of the repository at `root`.
 * options: { now, git (bool), staleDays, staleCommits }
 */
function createContext(root, options) {
  options = options || {};
  root = path.resolve(root);
  const w = walk(root);
  const byBase = new Map();
  for (const f of w.files) {
    const b = f.slice(f.lastIndexOf('/') + 1);
    let arr = byBase.get(b);
    if (!arr) byBase.set(b, (arr = []));
    arr.push(f);
  }
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch (_) { /* keep */ }
  const git = gitInfo(root);
  const ctx = {
    root,
    realRoot,
    files: w.files,
    fileSet: new Set(w.files),
    dirs: w.dirs,
    truncated: w.truncated,
    byBase,
    options,
    gitRoot: git.root,
    gitDir: git.dir,
    sparse: git.sparse,
    builtAt: Date.now(),
    _cache: new Map(),
  };
  return ctx;
}

/** Drops cached manifest facts (package.json, Makefile, ...) but keeps the file list. */
function invalidateManifests(ctx) { if (ctx && ctx._cache) ctx._cache.clear(); }

/**
 * Finds the enclosing git repository without running git: { root, dir, sparse }.
 * sparse is true when core.sparseCheckout is on or <gitdir>/info/sparse-checkout exists.
 */
function gitInfo(root) {
  const out = { root: null, dir: null, sparse: false };
  let d = root;
  for (let k = 0; k < 64; k++) {
    const dotgit = path.join(d, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch (_) { /* none */ }
    if (st) {
      out.root = d;
      let gd = dotgit;
      if (st.isFile()) {
        try {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, 'utf8').slice(0, 4096));
          gd = m ? path.resolve(d, m[1].trim()) : null;
        } catch (_) { gd = null; }
      }
      out.dir = gd;
      if (gd) {
        const dirs = [gd];
        try { const c = fs.readFileSync(path.join(gd, 'commondir'), 'utf8').trim(); if (c) dirs.push(path.resolve(gd, c)); } catch (_) { /* not a worktree */ }
        for (const g of dirs) {
          if (fs.existsSync(path.join(g, 'info', 'sparse-checkout'))) out.sparse = true;
          for (const cf of ['config', 'config.worktree']) {
            try {
              const t = fs.readFileSync(path.join(g, cf), 'utf8').slice(0, 256 * 1024);
              if (/^[ \t]*sparsecheckout[ \t]*=[ \t]*true[ \t]*$/im.test(t)) out.sparse = true;
            } catch (_) { /* none */ }
          }
        }
      }
      return out;
    }
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  return out;
}

/** True when abs (after resolving symlinks) is inside the workspace root. */
function insideRoot(ctx, abs) {
  let real;
  try { real = fs.realpathSync(abs); } catch (_) { return false; }
  const r = ctx.realRoot || ctx.root;
  return real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

function memo(ctx, key, fn) {
  if (ctx._cache.has(key)) return ctx._cache.get(key);
  const v = fn();
  ctx._cache.set(key, v);
  return v;
}

function readRel(ctx, rel, maxBytes) {
  return memo(ctx, 'read:' + rel, () => {
    try {
      const abs = path.join(ctx.root, rel);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > (maxBytes || MAX_MANIFEST_BYTES)) return null;
      if (!insideRoot(ctx, abs)) return null; // never read through a symlink that leaves the workspace
      const t = fs.readFileSync(abs, 'utf8');
      if (isBinaryText(t)) return null;
      return stripBom(t);
    } catch (_) { return null; }
  });
}

/** Reads an instruction file. Returns a string, or { skipped: reason } when it is not analyzed. */
function readFresh(ctx, abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    if (!insideRoot(ctx, abs)) return { skipped: 'symlink to a file outside the workspace' };
    if (st.size > MAX_INSTRUCTION_BYTES) return { skipped: `larger than ${MAX_INSTRUCTION_BYTES / 1024 / 1024} MB` };
    const t = fs.readFileSync(abs, 'utf8');
    return isBinaryText(t) ? { skipped: 'binary file' } : stripBom(t);
  } catch (_) { return null; }
}

function hasFile(ctx, rel) {
  if (rel === null || rel === undefined) return false;
  return ctx.fileSet.has(rel);
}
function existsRel(ctx, rel) {
  if (rel === null || rel === undefined) return false;
  if (ctx.fileSet.has(rel) || ctx.dirs.has(rel)) return true;
  try { fs.statSync(path.join(ctx.root, rel)); return true; } catch (_) { return false; }
}
function isDirRel(ctx, rel) {
  if (rel === null || rel === undefined) return false;
  if (ctx.dirs.has(rel)) return true;
  try { return fs.statSync(path.join(ctx.root, rel)).isDirectory(); } catch (_) { return false; }
}
function filesNamed(ctx, ...names) {
  const out = [];
  for (const n of names) for (const f of ctx.byBase.get(n) || []) out.push(f);
  return out;
}

/* ---------- package.json ---------- */

function readPackage(ctx, dirRel) {
  return memo(ctx, 'pkg:' + dirRel, () => {
    const rel = dirRel ? dirRel + '/package.json' : 'package.json';
    if (!hasFile(ctx, rel)) return null;
    const t = readRel(ctx, rel);
    if (t === null) return { dir: dirRel, rel, invalid: true };
    try {
      const j = JSON.parse(t);
      if (!j || typeof j !== 'object') return { dir: dirRel, rel, invalid: true };
      const scripts = j.scripts && typeof j.scripts === 'object' ? j.scripts : {};
      const deps = new Set();
      for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        if (j[k] && typeof j[k] === 'object') for (const d of Object.keys(j[k])) deps.add(d);
      }
      return { dir: dirRel, rel, invalid: false, json: j, scripts, deps, text: t };
    } catch (_) { return { dir: dirRel, rel, invalid: true }; }
  });
}
function allPackages(ctx) {
  return memo(ctx, 'allpkgs', () => filesNamed(ctx, 'package.json').map((f) => readPackage(ctx, posixDirname(f))).filter(Boolean));
}

/* ---------- Makefile ---------- */

const MAKEFILE_NAMES = ['GNUmakefile', 'makefile', 'Makefile'];

function parseMakefile(ctx, rel, depth) {
  return memo(ctx, 'make:' + rel, () => {
    const res = { targets: new Set(), uncertain: false };
    const t = readRel(ctx, rel);
    if (t === null) { res.uncertain = true; return res; }
    const lines = splitLines(t);
    let inDefine = false;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      while (line.endsWith('\\') && i + 1 < lines.length && line.length <= MAX_LINE_CHARS) line = line.slice(0, -1) + ' ' + lines[++i];
      if (line.length > MAX_LINE_CHARS) { res.uncertain = true; continue; }
      if (inDefine) {
        if (/^\s*endef\b/.test(line)) inDefine = false;
        else if (!line.startsWith('\t') && splitMakeRule(line)) res.uncertain = true; // a rule template: targets are generated
        continue;
      }
      if (/^\s*define\b/.test(line)) { inDefine = true; continue; }
      if (line.startsWith('\t')) continue;
      const noComment = line.replace(/(^|[^\\])#.*$/, '$1');
      // $(eval ...), $(call ...) or $(foreach ...) at top level can create targets we cannot see
      if (/^\s*\$\((?:eval|call|foreach)\b/.test(noComment) || /\$\(eval\b/.test(noComment)) { res.uncertain = true; continue; }
      const inc = /^\s*-?(?:s?include)\s+(.+)$/.exec(noComment);
      if (inc) {
        if (depth >= 4) { res.uncertain = true; continue; }
        for (const f of inc[1].trim().split(/\s+/)) {
          if (/[$*?%]/.test(f)) { res.uncertain = true; continue; }
          const incRel = normalizeRel(posixJoin(posixDirname(rel), f));
          if (incRel === null || !hasFile(ctx, incRel)) { res.uncertain = true; continue; }
          const sub = parseMakefile(ctx, incRel, depth + 1);
          for (const x of sub.targets) res.targets.add(x);
          if (sub.uncertain) res.uncertain = true;
        }
        continue;
      }
      const head = splitMakeRule(noComment);
      if (head === null) continue;
      if (/^\s*(?:export|override|ifeq|ifneq|ifdef|ifndef|else|endif|vpath)\b/.test(head)) continue;
      for (const tg of head.trim().split(/\s+/)) {
        if (!tg) continue;
        if (tg.includes('%')) { res.uncertain = true; continue; }
        if (tg.includes('$')) { res.uncertain = true; continue; }
        if (/^\.[A-Z_]+$/.test(tg)) continue; // .PHONY, .DEFAULT ...
        res.targets.add(tg);
      }
    }
    return res;
  });
}
/**
 * Returns the target list text of a Makefile rule line ("a b: deps" -> "a b"), or null.
 * Linear scan: first ':' with no '=' or '#' before it, not followed by '=' (":=", "::=").
 */
function splitMakeRule(line) {
  if (!line || /^[\s:=#]/.test(line)) return null;
  const idx = line.indexOf(':');
  if (idx <= 0) return null;
  let head = line.slice(0, idx);
  if (head.includes('=') || head.includes('#')) return null;
  let after = idx + 1;
  if (line[after] === ':') after++;
  if (line[after] === '=' || line[after] === ':') return null;
  head = head.replace(/&\s*$/, '');
  return head.trim() ? head : null;
}

function makefileIn(ctx, dirRel) {
  for (const n of MAKEFILE_NAMES) {
    const rel = dirRel ? dirRel + '/' + n : n;
    if (hasFile(ctx, rel)) return rel;
  }
  return null;
}

/* ---------- justfile ---------- */

const JUSTFILE_NAMES = ['justfile', 'Justfile', '.justfile', 'JUSTFILE'];
function justfileIn(ctx, dirRel) {
  for (const n of JUSTFILE_NAMES) {
    const rel = dirRel ? dirRel + '/' + n : n;
    if (hasFile(ctx, rel)) return rel;
  }
  return null;
}
function parseJustfile(ctx, rel, depth) {
  return memo(ctx, 'just:' + rel, () => {
    const res = { recipes: new Set(), modules: new Set(), uncertain: false };
    const t = readRel(ctx, rel);
    if (t === null) { res.uncertain = true; return res; }
    for (const line of splitLines(t)) {
      if (line.length > MAX_LINE_CHARS) { res.uncertain = true; continue; }
      if (!line || /^\s/.test(line) || line.startsWith('#') || line.startsWith('[')) continue;
      let m = /^alias\s+([A-Za-z_][\w-]*)\s*:=/.exec(line);
      if (m) { res.recipes.add(m[1]); continue; }
      m = /^mod\??\s+([A-Za-z_][\w-]*)/.exec(line);
      if (m) { res.modules.add(m[1]); continue; }
      m = /^import\??\s+['"]([^'"]+)['"]/.exec(line);
      if (m) {
        const incRel = normalizeRel(posixJoin(posixDirname(rel), m[1]));
        if (depth < 4 && incRel && hasFile(ctx, incRel)) {
          const sub = parseJustfile(ctx, incRel, depth + 1);
          for (const r of sub.recipes) res.recipes.add(r);
          for (const r of sub.modules) res.modules.add(r);
          if (sub.uncertain) res.uncertain = true;
        } else res.uncertain = true;
        continue;
      }
      if (/^(?:set|export|alias|import|mod)\s/.test(line)) continue;
      // recipe: name [params...]: deps   (linear: name, then the first ':' that is not ':=')
      m = /^@?([A-Za-z_][\w-]*)/.exec(line);
      if (m) {
        const rest = line.slice(m[0].length);
        const c = rest.indexOf(':');
        if (c >= 0 && rest[c + 1] !== '=' && (c === 0 || /^\s/.test(rest))) res.recipes.add(m[1]);
      }
    }
    return res;
  });
}

/* ---------- Taskfile ---------- */

const TASKFILE_NAMES = ['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml', 'taskfile.yaml', 'Taskfile.dist.yml', 'Taskfile.dist.yaml'];
function taskfileIn(ctx, dirRel) {
  for (const n of TASKFILE_NAMES) {
    const rel = dirRel ? dirRel + '/' + n : n;
    if (hasFile(ctx, rel)) return rel;
  }
  return null;
}
function parseTaskfile(ctx, rel) {
  return memo(ctx, 'task:' + rel, () => {
    const res = { tasks: new Set(), patterns: [], uncertain: false };
    const t = readRel(ctx, rel);
    if (t === null) { res.uncertain = true; return res; }
    const lines = splitLines(t);
    let inTasks = false;
    let indent = -1;
    for (const line of lines) {
      if (line.length > MAX_LINE_CHARS) continue;
      if (/^\S/.test(line)) {
        inTasks = /^tasks\s*:/.test(line);
        if (/^includes\s*:/.test(line)) res.uncertain = true;
        indent = -1;
        continue;
      }
      if (!inTasks || !line.trim() || /^\s*#/.test(line)) continue;
      const m = parseTaskKey(line);
      if (!m) continue;
      if (indent < 0) indent = m.indent;
      if (m.indent !== indent) continue;
      if (m.name.includes('*')) { const g = compileGlob(m.name.replace(/:/g, '/')); if (g) res.patterns.push(g); else res.uncertain = true; }
      else res.tasks.add(m.name);
    }
    return res;
  });
}

/** "  name:" / "  'name':" -> { indent, name } (linear scan, no regex backtracking). */
function parseTaskKey(line) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i === 0 || i >= line.length) return null;
  const indent = i;
  let name, rest;
  const q = line[i];
  if (q === '"' || q === "'") {
    const end = line.indexOf(q, i + 1);
    if (end < 0) return null;
    name = line.slice(i + 1, end);
    rest = line.slice(end + 1).trimStart();
    if (rest[0] !== ':' || (rest.length > 1 && !/\s/.test(rest[1]))) return null;
  } else {
    let c = -1;
    for (let k = i; k < line.length; k++) {
      const ch = line[k];
      if (ch === '"' || ch === "'" || ch === '#') return null;
      if (ch === ':' && (k + 1 === line.length || line[k + 1] === ' ' || line[k + 1] === '\t')) { c = k; break; }
    }
    if (c < 0) return null;
    name = line.slice(i, c).trimEnd();
  }
  if (!name || /^\s/.test(name)) return null;
  return { indent, name };
}

/* ---------- minimal TOML ---------- */

/** Tolerant TOML subset reader: returns { tables: Map<tableName, Map<key, value>> }. Values: string | string[] | raw string. */
function parseTomlLite(text) {
  const tables = new Map();
  let cur = '';
  tables.set('', new Map());
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > MAX_LINE_CHARS) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let m = /^\[\[\s*([^\]]+?)\s*\]\]/.exec(trimmed);
    if (m) {
      cur = m[1].replace(/["']/g, '') + '[]';
      const k = cur + '#' + i;
      tables.set(k, new Map());
      cur = k;
      continue;
    }
    m = /^\[\s*([^\]]+?)\s*\]/.exec(trimmed);
    if (m) {
      cur = m[1].replace(/\s*\.\s*/g, '.').replace(/["']/g, '');
      if (!tables.has(cur)) tables.set(cur, new Map());
      continue;
    }
    const kv = splitTomlKey(trimmed);
    if (!kv) continue;
    const key = kv.key;
    let val = kv.val;
    if (val.startsWith('"""') || val.startsWith("'''")) {
      const q = val.slice(0, 3);
      let body = val.slice(3);
      while (!body.includes(q) && i + 1 < lines.length && body.length < MAX_MANIFEST_BYTES) body += '\n' + lines[++i];
      val = body.slice(0, body.indexOf(q));
      setTomlKey(tables, cur, key, val);
      continue;
    }
    if (val.startsWith('[')) {
      let depth = bracketDepth(val);
      while (depth > 0 && i + 1 < lines.length) { const nx = lines[++i]; if (nx.length > MAX_LINE_CHARS) continue; val += '\n' + nx; depth += bracketDepth(nx); }
      const items = [];
      const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
      let mm;
      const body = val.split('\n').map(stripTomlTrailingComment).join('\n');
      while ((mm = re.exec(body))) items.push(mm[1] !== undefined ? mm[1] : mm[2]);
      setTomlKey(tables, cur, key, items);
      continue;
    }
    const s = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(val);
    if (s) { setTomlKey(tables, cur, key, s[1] !== undefined ? s[1] : s[2]); continue; }
    const hc = val.search(/\s#/);
    setTomlKey(tables, cur, key, (hc >= 0 ? val.slice(0, hc) : val).trim());
  }
  return { tables };
}
/** Splits 'key = value' at the first '=' outside quotes. Linear. */
function splitTomlKey(t) {
  let q = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '=') {
      const rawKey = t.slice(0, i).trim();
      if (!rawKey || !/^[A-Za-z0-9_.\- "']+$/.test(rawKey)) return null;
      return { key: rawKey.replace(/["']/g, '').trim(), val: t.slice(i + 1).trim() };
    }
    if (!/[A-Za-z0-9_.\- ]/.test(c)) return null;
  }
  return null;
}
/** Same as replace(/#[^\n"']*$/, ''): drop a '#' comment that has no quote after it. */
function stripTomlTrailingComment(line) {
  const lastQuote = Math.max(line.lastIndexOf('"'), line.lastIndexOf("'"));
  const h = line.indexOf('#', lastQuote + 1);
  return h >= 0 ? line.slice(0, h) : line;
}
function bracketDepth(s) {
  let d = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '#') break;
    else if (c === '[' || c === '{') d++;
    else if (c === ']' || c === '}') d--;
  }
  return d;
}
function setTomlKey(tables, cur, key, val) {
  // dotted keys: a.b = 1 inside [t] => table t.a key b
  const parts = key.split('.').map((x) => x.trim());
  const k = parts.pop();
  const t = parts.length ? (cur ? cur + '.' : '') + parts.join('.') : cur;
  if (!tables.has(t)) tables.set(t, new Map());
  tables.get(t).set(k, val);
}
function tomlGet(toml, table, key) {
  const t = toml.tables.get(table);
  return t ? t.get(key) : undefined;
}

function readToml(ctx, rel) {
  return memo(ctx, 'toml:' + rel, () => {
    const t = readRel(ctx, rel);
    if (t === null) return null;
    try { return parseTomlLite(t); } catch (_) { return null; }
  });
}

function normPyName(n) { return String(n).toLowerCase().replace(/[-_.]+/g, '-'); }
function pep508Name(s) { const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(s); return m ? normPyName(m[1]) : null; }

function pythonFacts(ctx) {
  return memo(ctx, 'py', () => {
    const scripts = new Set();
    const deps = new Set();
    const pyprojects = filesNamed(ctx, 'pyproject.toml');
    for (const rel of pyprojects) {
      const toml = readToml(ctx, rel);
      if (!toml) continue;
      for (const [name, tbl] of toml.tables) {
        if (name === 'project.scripts' || name === 'project.gui-scripts' || name === 'tool.poetry.scripts' || name === 'tool.pdm.scripts') {
          for (const k of tbl.keys()) scripts.add(k);
        }
        if (name === 'tool.poetry.dependencies' || name === 'tool.poetry.dev-dependencies' || /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(name)) {
          for (const k of tbl.keys()) deps.add(normPyName(k));
        }
        if (name === 'project.optional-dependencies' || name === 'dependency-groups' || name === 'tool.pdm.dev-dependencies') {
          for (const v of tbl.values()) if (Array.isArray(v)) for (const s of v) { const n = pep508Name(s); if (n) deps.add(n); }
        }
      }
      for (const [table, key] of [['project', 'dependencies'], ['tool.uv', 'dev-dependencies']]) {
        const v = tomlGet(toml, table, key);
        if (Array.isArray(v)) for (const s of v) { const n = pep508Name(s); if (n) deps.add(n); }
      }
      const pname = tomlGet(toml, 'project', 'name') || tomlGet(toml, 'tool.poetry', 'name');
      if (typeof pname === 'string') { scripts.add(pname); deps.add(normPyName(pname)); }
    }
    for (const f of ctx.files) {
      const b = f.slice(f.lastIndexOf('/') + 1);
      if (!/^requirements.*\.(txt|in)$/.test(b)) continue;
      const t = readRel(ctx, f);
      if (!t) continue;
      for (const line of splitLines(t)) { const n = pep508Name(line.replace(/#.*/, '')); if (n) deps.add(n); }
    }
    return { pyprojects, scripts, deps };
  });
}

function cargoFacts(ctx) {
  return memo(ctx, 'cargo', () => {
    const packages = new Set();
    const bins = new Set();
    const aliases = new Set();
    let hasAliasTable = false;
    const manifests = filesNamed(ctx, 'Cargo.toml');
    for (const rel of manifests) {
      const toml = readToml(ctx, rel);
      if (!toml) continue;
      for (const [name, tbl] of toml.tables) {
        if (name === 'package' && typeof tbl.get('name') === 'string') { packages.add(tbl.get('name')); bins.add(tbl.get('name')); }
        if (name.startsWith('bin[]') && typeof tbl.get('name') === 'string') bins.add(tbl.get('name'));
      }
    }
    for (const f of ctx.files) {
      let m = /(?:^|\/)src\/bin\/([^/]+)\.rs$/.exec(f) || /(?:^|\/)src\/bin\/([^/]+)\/main\.rs$/.exec(f);
      if (m) bins.add(m[1]);
      if (/(?:^|\/)\.cargo\/config(?:\.toml)?$/.test(f)) {
        const toml = readToml(ctx, f);
        const tbl = toml && toml.tables.get('alias');
        if (tbl) { hasAliasTable = true; for (const k of tbl.keys()) aliases.add(k); }
      }
    }
    return { manifests, packages, bins, aliases, hasAliasTable };
  });
}

/* ------------------------------------------------------------------ */
/* Markdown scanning                                                   */
/* ------------------------------------------------------------------ */

const SHELL_LANGS = new Set(['', 'sh', 'bash', 'shell', 'zsh', 'fish', 'console', 'shell-session', 'sh-session', 'shellsession', 'terminal', 'cmd', 'bat', 'powershell', 'ps', 'ps1', 'pwsh', 'ksh', 'command', 'commands', 'cli']);
const PROMPT_LANGS = new Set(['console', 'shell-session', 'sh-session', 'shellsession', 'terminal']);

const DIRECTIVE_RE = /context-drift-disable(-next-line|-line)?(?![\w-])([^\n]*)/;
// The destination run is matched atomically ((?=(x+))\3): giving back characters can never help. It also stops
// at "](" (never part of a real target). Without both, a long line of "[a](" takes quadratic time.
const LINK_RE = /!?\[((?:[^\[\]\\]|\\.)*)\]\(\s*(<[^>\n]*>|(?=((?:[^\s)\]]|\](?!\())+))\3)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

function applyDirective(doc, text, line) {
  const m = DIRECTIVE_RE.exec(text);
  if (!m) return;
  const ids = (m[2].match(/CD\d{3}/g) || []);
  const set = ids.length ? new Set(ids) : null; // null => all rules
  if (m[1] === '-next-line') doc.pendingNext.push({ from: line, set });
  else if (m[1] === '-line') addDisabled(doc, line, set);
  else {
    if (!doc.disabled.file) doc.disabled.file = set === null ? 'all' : new Set();
    if (doc.disabled.file !== 'all') for (const id of set) doc.disabled.file.add(id);
  }
}

/** Backtick runs of a line, grouped by length, for O(log n) closing-run lookup. */
function backtickRuns(work) {
  const byLen = new Map();
  for (let k = 0; k < work.length; k++) {
    if (work[k] !== '`') continue;
    let n = 0;
    while (work[k + n] === '`') n++;
    let arr = byLen.get(n);
    if (!arr) byLen.set(n, (arr = []));
    arr.push(k);
    k += n - 1;
  }
  return byLen;
}
function firstRunAtOrAfter(arr, pos) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < pos) lo = mid + 1; else hi = mid; }
  return lo < arr.length ? arr[lo] : -1;
}

function scanDocument(text) {
  const lines = splitLines(text);
  const doc = { lines, inline: [], fence: [], fences: [], links: [], prose: [], frontmatter: null, longLines: 0, disabled: { file: null, lines: new Map() }, pendingNext: [] };

  // frontmatter (directives there are YAML comments: "# context-drift-disable-next-line CD002")
  let start = 0;
  if (lines.length && /^---\s*$/.test(lines[0])) {
    for (let i = 1; i < Math.min(lines.length, 400); i++) {
      if (/^(---|\.\.\.)\s*$/.test(lines[i])) { doc.frontmatter = { start: 0, end: i }; start = i + 1; break; }
    }
    if (doc.frontmatter) {
      for (let i = 1; i < doc.frontmatter.end; i++) {
        const l = lines[i];
        if (l.length <= MAX_LINE_CHARS && /^\s*#/.test(l)) applyDirective(doc, l, i);
      }
    }
  }

  let fence = null;
  let inComment = false;
  let commentText = '';
  let commentLine = 0;
  let heading = '';
  let heredoc = null;
  let prevProse = '';
  for (let i = start; i < lines.length; i++) {
    let line = lines[i];
    if (line.length > MAX_LINE_CHARS) { doc.longLines++; line = ''; }
    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) { fence.end = i; fence = null; heredoc = null; continue; }
      if (heredoc) { if (line.trim() === heredoc) heredoc = null; continue; }
      const hd = /<<-?\s*['"]?([A-Za-z_][\w]*)['"]?/.exec(line);
      if (/\b(?:mkdir|clone|init|create|new|degit|scaffold|generate|startproject|startapp)\b/.test(line)) fence.creates = true;
      const entry = { text: line, line: i, lang: fence.lang, heading, afterCreate: !!fence.creates, block: fence };
      if (/^\s*(?:\$|❯)\s/.test(line)) fence.hasPrompt = true;
      doc.fence.push(entry);
      if (hd) heredoc = hd[1];
      continue;
    }
    const open = /^(\s*)(`{3,}|~{3,})\s*([^\s`{]*)/.exec(line);
    if (open && !(open[2][0] === '`' && line.slice(open[1].length + open[2].length).includes('`'))) {
      fence = { ch: open[2][0], len: open[2].length, lang: open[3].toLowerCase().replace(/^\{?\.?/, ''), start: i, end: lines.length, hasPrompt: false };
      doc.fences.push(fence);
      prevProse = '';
      continue;
    }
    // strip html comments (keep columns); directives count only inside real comments
    let work = '';
    let j = 0;
    const spanCache = {};
    while (j < line.length) {
      if (inComment) {
        const e = line.indexOf('-->', j);
        if (e < 0) { commentText += line.slice(j) + '\n'; work += ' '.repeat(line.length - j); j = line.length; }
        else { commentText += line.slice(j, e); work += ' '.repeat(e + 3 - j); j = e + 3; inComment = false; applyDirective(doc, commentText, commentLine); }
      } else {
        const s2 = nextCommentStart(line, j, spanCache);
        if (s2 < 0) { work += line.slice(j); j = line.length; } else { work += line.slice(j, s2); j = s2 + 4; work += '    '; inComment = true; commentText = ''; commentLine = i; }
      }
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(work);
    if (h) heading = h[2].trim();
    // inline code spans
    const spanRoom = doc.inline.length < MAX_SPANS_PER_FILE;
    if (!spanRoom && work.includes('`')) doc.spansCapped = true;
    const runs = spanRoom && work.includes('`') ? backtickRuns(work) : null;
    let masked = '';
    let k = 0;
    let last = 0;
    const spans = [];
    while (runs && k < work.length) {
      const c = work[k];
      if (c === '\\' && k + 1 < work.length) { k += 2; continue; }
      if (c !== '`') { k++; continue; }
      let n = 0;
      while (work[k + n] === '`') n++;
      const arr = runs.get(n);
      let close = arr ? firstRunAtOrAfter(arr, k + n) : -1;
      // a closing run must be exactly n long: runs.get(n) holds maximal runs of length n only
      if (close < 0) { k += n; continue; }
      let cs = k + n, ce = close;
      let content = work.slice(cs, ce);
      if (content.length > 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim()) { cs++; ce--; content = work.slice(cs, ce); }
      spans.push({ text: content, line: i, col: cs, endCol: ce, heading });
      masked += work.slice(last, k) + ' '.repeat(close + n - k);
      k = close + n;
      last = k;
    }
    masked += work.slice(last);
    // previous line of the same paragraph or list item (for negation and "create" context)
    const newItem = /^\s*(?:[-*+]\s|\d+[.)]\s|#|\||>)/.test(work);
    const prev = newItem ? '' : prevProse;
    for (const sp of spans) { sp.lineText = work; sp.prevText = prev; doc.inline.push(sp); }
    // links
    LINK_RE.lastIndex = 0;
    let lm;
    while (masked.includes('](') && (lm = LINK_RE.exec(masked))) {
      if (doc.links.length >= MAX_SPANS_PER_FILE) { doc.spansCapped = true; break; }
      let target = lm[2];
      let tcol = lm.index + lm[0].indexOf(target, lm[1].length + 2);
      if (target.startsWith('<')) { target = target.slice(1, -1); tcol++; }
      doc.links.push({ text: target, line: i, col: tcol, endCol: tcol + target.length, heading, lineText: work, prevText: prev });
    }
    const ref = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(masked);
    if (ref) {
      let target = ref[1];
      let tcol = ref[0].lastIndexOf(target);
      if (target.startsWith('<')) { target = target.slice(1, -1); tcol++; }
      doc.links.push({ text: target, line: i, col: tcol, endCol: tcol + target.length, heading, lineText: work, prevText: prev });
    }
    doc.prose.push({ text: work, masked, line: i, heading, prevText: prev });
    prevProse = work.trim() ? work : '';
  }
  // "-next-line" directives: the next non-blank line; above a code fence they cover the whole block
  for (const p of doc.pendingNext) {
    let n = p.from + 1;
    while (n < lines.length && !lines[n].trim()) n++;
    const f = doc.fences.find((x) => x.start === n);
    if (f) for (let l = f.start; l <= Math.min(f.end, lines.length - 1); l++) addDisabled(doc, l, p.set);
    else addDisabled(doc, n, p.set);
  }
  return doc;
}
/** Next '<!--' at or after `from` that is not inside an inline code span of the raw line. */
function nextCommentStart(line, from, cache) {
  let p = line.indexOf('<!--', from);
  if (p < 0 || !line.includes('`')) return p;
  if (!cache.spans) {
    const spans = [];
    const runs = backtickRuns(line);
    for (let k = 0; k < line.length;) {
      if (line[k] === '\\') { k += 2; continue; }
      if (line[k] !== '`') { k++; continue; }
      let n = 0;
      while (line[k + n] === '`') n++;
      const close = firstRunAtOrAfter(runs.get(n), k + n);
      if (close < 0) { k += n; continue; }
      spans.push(k, close + n); // flat [start, end) pairs, sorted
      k = close + n;
    }
    cache.spans = spans;
  }
  const sp = cache.spans;
  while (p >= 0) {
    // binary search the last span starting at or before p
    let lo = 0, hi = sp.length / 2;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sp[mid * 2] <= p) lo = mid + 1; else hi = mid; }
    const idx = lo - 1;
    if (idx >= 0 && p < sp[idx * 2 + 1]) p = line.indexOf('<!--', sp[idx * 2 + 1]);
    else return p;
  }
  return p;
}
function addDisabled(doc, line, set) {
  const cur = doc.disabled.lines.get(line);
  if (set === null || cur === 'all') { doc.disabled.lines.set(line, 'all'); return; }
  const s = cur || new Set();
  for (const id of set) s.add(id);
  doc.disabled.lines.set(line, s);
}
function isDisabled(doc, ruleId, line) {
  const f = doc.disabled.file;
  if (f === 'all' || (f && f.has(ruleId))) return true;
  const l = doc.disabled.lines.get(line);
  return l === 'all' || (l && l.has(ruleId));
}

/* ---------- negation / intent heuristics ---------- */

const NEG_BEFORE = /(?:\b(?:no|not|never|don'?t|doesn'?t|do not|does not|isn'?t|aren'?t|wasn'?t|weren'?t|cannot|can'?t|won'?t|avoid|instead of|rather than|no longer|deprecated|removed|former|formerly|previously|legacy|replaced|stop using|stopped using|without|unlike|versus|vs\.?|nor|old|obsolete|used to|switched from|moved from|migrated from|renamed from|upgraded? from|migrating from|forbidden|banned|prohibited)\b|~~)[^.;!?]*$/i;
/** "is deprecated", "(removed)", "no longer works": only when the span itself is the subject (at most 3 words between). */
const NEG_AFTER = /^(?:\s*(?:[\w-]+\s+){0,3}?(?:is|was|are|were|has been|have been|got)\s+(?:now\s+)?(?:removed|deleted|deprecated|gone|renamed|replaced|obsolete|retired|dropped|forbidden|banned)\b|\s*(?:\(|—|–|-|:)?\s*(?:deprecated|removed|old|legacy|obsolete|no longer)\b|\s*(?:[\w-]+\s+){0,3}?no longer\b|\s*(?:[\w-]+\s+){0,2}?(?:doesn'?t|does not|won'?t|will not)\s+(?:exist|work)\b|\s*~~)/i;
/** Words that make the whole sentence hypothetical, an example or a pattern: anywhere earlier in the sentence. */
const CREATE_BEFORE = /\b(?:create|creates|created|creating|add|adds|adding|generate[sd]?|generating|write|writes|written|writing|emit|emits|touch|mkdir|scaffold|will be|would be|e[._]g[._]?|eg|i[._]e[._]?|for example|for instance|such as|examples?|look for|check for|search for|detect|whether|any of|optionally|optional|if (?:you )?(?:have|need|want)|if present|if it exists|save (?:it )?(?:to|as)|rename(?:d)? (?:it )?to|move(?:d)? (?:it )?to|copy (?:it )?to|produces?|goes to|lands in|named|called|make sure|ensure|ensures|expects?|may|might|could|would|regenerate[sd]?|regenerating|rebuild|exports?|retained in|re-?create[sd]?|codegen|branch(?:es)?|sibling|defaults? to|for a starter with|naming|ending in|ends? (?:with|in)|end in|emitted|suffix(?:ed)?|prefix(?:ed)?|stored|saved|persisted|cached|remembered|logged|organi[sz]ed by|by category|rewrites?|overwrites?|replays? from|reads? back|submodules?|subpaths?|wildcard)\b[^.;!?]*$/i;
/** Generic words that only count when they govern the span, within the last 4 words before it ("files like `X`",
 * "write it into `X`"). "New API handlers go in `src/api/x.ts`" and "code like the logger lives in `src/lib/logger.ts`" stay claims. */
const CREATE_NEAR = /\b(?:new|like|into|either|output|outputs|locally)\b/i;
function createdBefore(b) {
  if (CREATE_BEFORE.test(b)) return true;
  const words = b.split(/[.;!?](?:\s|$)/).pop().trim().split(/\s+/);
  return CREATE_NEAR.test(words.slice(-4).join(' '));
}
const CREATE_AFTER = /^(?:[^.;!?]*?\b(?:will be|is|are|gets|get|be)\s+(?:auto-?)?(?:created|generated|written|produced|built|emitted|downloaded|installed)\b|\s*\(?\s*(?:generated|created|gitignored|ignored|local(?:ly)?|optional|if present|if it exists|if exists|not committed|untracked|when present|once created)\b|[^.;!?]*\bif (?:it |they )?(?:exists?|present)\b|[^.;!?]*\b(?:does ?n[o']t exist yet|not exist yet|to be created)\b|[^.;!?]*\b(?:folder|directory|dir|file)?\s*exists\b|[^.;!?]*\bgenerated\b|[^.;!?]*\b(?:git )?submodule\b|[^.;!?]*\bsubpath\b|\s*(?:alias|aliases)\b|\s*\(\s*(?:state|cache|runtime|data|log|logs|output|tmp|temp|user|home|config)\s+(?:dir|directory|folder|file)\b)/i;
const EXAMPLE_HEADING = /\b(?:examples?|samples?|templates?|placeholders?|illustrations?|format|output)\b/i;
/** Text that says a command runs somewhere else: another package, the workspace root outside this repo, a library. */
const ELSEWHERE = /\b(?:(?:inside|in|from|within|under)\s+(?:its|the|each|that|a|every|their|your)\s+(?:own\s+)?(?:package|workspace|app|project|sub-?project|module|crate|playground|library)(?:\s+(?:dir(?:ectory)?|folder))?|per[- ](?:package|app|project|workspace)|(?:from|at|in)\s+(?:the\s+)?(?:workspace|monorepo|parent|outer|top-level)\s+root|outside\s+(?:this|the)\s+repo|upstream|(?:from|in)\s+the\s+(?:library|other\s+repo|parent\s+repo)|(?:separate|nested|other|another)\s+(?:nested\s+)?(?:repo|repository|package|project)|(?:library|upstream|template|vendor)'s)\b/i;

const CONTEXT_CHARS = 200;
/** The current sentence before `col` (at most 200 chars), plus the previous line of the same paragraph. */
function contextBefore(lineText, col, prevText) {
  let start = Math.max(0, col - CONTEXT_CHARS);
  if (start > 0) {
    // do not start inside a code span: an odd number of backticks before the window shifts the pairing
    let ticks = 0;
    for (let i = 0; i < start; i++) if (lineText.charCodeAt(i) === 96) ticks++;
    if (ticks % 2) { const nb = lineText.indexOf('`', start); start = nb >= 0 && nb < col ? nb + 1 : start; }
  }
  let s = lineText.slice(start, col);
  if (prevText && s.length === col && s.length < CONTEXT_CHARS) s = prevText.slice(-(CONTEXT_CHARS - s.length)) + ' ' + s;
  const cut = Math.max(s.lastIndexOf('. '), s.lastIndexOf('; '), s.lastIndexOf('! '), s.lastIndexOf('? '));
  return (cut >= 0 ? s.slice(cut + 2) : s).replace(/`+$/, ''); // drop the span's own opening backticks
}
function contextAfter(lineText, endCol) { return lineText.slice(endCol, endCol + CONTEXT_CHARS).replace(/^`+/, ''); }
/** Drops code spans, and turns dots inside words and numbers ("Node.js", "1.23") into "_" so they do not end a clause. */
function stripSpans(t) { return t.replace(/`[^`]*`/g, ' ').replace(/\.(?=[^\s.])/g, '_'); }
/** Words after which a new clause starts: "Do not open a PR until `make check` passes". */
const CLAUSE_PIVOT = /\b(?:until|unless|before|once|but|otherwise|then)\b/gi;
/** After a negation these words make a requirement: "never commit without running X", "don't forget to run X", "do not skip X". */
const NEG_FLIP = /\b(?:without|forget(?:ting)?|fail(?:ing)?\s+to|skip(?:ping)?|omit(?:ting)?|ignor(?:e|ing))\b/gi;
/** A comma clause that still belongs to what came before (a list, an example, a relative clause). */
const CONTINUES = /^\s*(?:or|and|nor|which|that|who|where|whose|e_g|i_e|eg|ie|for example|for instance|such as|like|including|especially|etc|neither|not)\b/i;
/** An imperative after a comma or "and" starts a new instruction: "Never edit generated files, run `X` instead". */
const IMPERATIVE = /^\s*(?:(?:always|just|instead|then|also|first|only|please)\s+)?(?:run|use|call|invoke|execute|regenerate|rebuild|try|prefer|start|launch|type)\b/i;
/** A clause that opens with a bare negation and an aside: "Do not, under any circumstances, run `X`" stays negated. */
const BARE_NEG = /^\s*(?:please\s+)?(?:do not|don'?t|never|not|no)(?:\s+ever)?\s*$/i;
/** An opening phrase that names the alternative: "Instead of `X`, use `Y`", "Unlike `X`, `Y` runs everything". */
const INTRO_ALT = /^\s*(?:instead of|unlike|rather than|as opposed to|compared (?:to|with))\b[^,]*$/i;
/** After a flip word, only these words may stand before the span for it to be a requirement: "skip `X`", "forget to run `X`", "without first running the `X`". */
const FLIP_DIRECT = /^\s*(?:(?:first|also|always|ever)\s+)?(?:(?:to\s+)?(?:run|running|call|calling|invoke|invoking|execute|executing|use|using)\s+)?(?:(?:the|a)\s+)?$/i;
function lastEnd(re, t) {
  re.lastIndex = 0;
  let m, end = -1;
  while ((m = re.exec(t))) end = m.index + m[0].length;
  return end;
}
const words = (t) => t.trim().split(/\s+/).filter(Boolean).length;
/** The clause that governs a span: the text after the last clause break before it. */
function governingClause(b) {
  let cut = lastEnd(CLAUSE_PIVOT, b);
  const comma = b.lastIndexOf(',');
  if (comma > cut) {
    const rest = b.slice(comma + 1);
    // a new clause after a comma: 2+ words that do not continue a list, an imperative verb,
    // or the span right after an "instead of / unlike / rather than" opening phrase
    const head = b.slice(Math.max(cut, 0)).split(',')[0];
    if (!CONTINUES.test(rest) && (words(rest) >= 2 || (IMPERATIVE.test(rest) && !BARE_NEG.test(head)))) cut = comma + 1;
    else if (words(rest) === 0 && INTRO_ALT.test(b.slice(Math.max(cut, 0), comma))) cut = comma + 1;
  }
  // "There is no Docker setup and the entry point is `src/server.ts`": a new clause with its own subject.
  // "Do not push to main and run `X`": an imperative after "and", when 4+ words come before it.
  const and = lastEnd(/\band\b/gi, b);
  if (and > cut && !CONTINUES.test(b.slice(and))) {
    const rest = b.slice(and);
    if (words(rest) >= 3 || (IMPERATIVE.test(rest) && words(b.slice(Math.max(cut, 0), and - 3)) >= 4)) cut = and;
  }
  return cut > 0 ? b.slice(cut) : b;
}
/** True when the clause before a span negates it. A negation followed by a flip word that governs the span
 * ("never commit without running `X`", "do not skip `X`") is a requirement. When the flip word has its own
 * object ("do not skip tests by calling `X`"), the span is the forbidden means and stays negated. */
function negatedBefore(b) {
  const t = governingClause(b);
  if (!NEG_BEFORE.test(t)) return false;
  NEG_FLIP.lastIndex = 0;
  let m, flip = null;
  while ((m = NEG_FLIP.exec(t))) flip = m;
  if (flip && NEG_BEFORE.test(t.slice(0, flip.index).replace(/\s+$/, ' x'))) return !FLIP_DIRECT.test(t.slice(flip.index + flip[0].length));
  return true;
}
function negated(lineText, col, endCol, prevText) {
  if (!lineText) return false;
  const b = stripSpans(contextBefore(lineText, col, prevText));
  if (negatedBefore(b)) return true;
  return NEG_AFTER.test(stripSpans(contextAfter(lineText, endCol)));
}
/** Sentence around a span, for ELSEWHERE checks. */
function sentenceAround(lineText, col, endCol, prevText) {
  const after = contextAfter(lineText, endCol);
  const stop = after.search(/[.;!?](?:\s|$)/);
  return stripSpans(contextBefore(lineText, col, prevText) + ' ' + lineText.slice(col, endCol) + ' ' + (stop >= 0 ? after.slice(0, stop) : after));
}

/* ------------------------------------------------------------------ */
/* Command tokenizer                                                   */
/* ------------------------------------------------------------------ */

/** Splits a shell-ish line into segments of tokens {v, s, e} with absolute columns. */
function tokenizeShell(str, base) {
  const segments = [];
  let toks = [];
  let i = 0;
  let dynamic = false;
  const push = () => { if (toks.length) segments.push({ toks, dynamic }); toks = []; dynamic = false; };
  while (i < str.length) {
    const c = str[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '#' ) break;
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '(' || c === ')') { push(); i++; continue; }
    let s = i, v = '';
    while (i < str.length) {
      const d = str[i];
      if (d === ' ' || d === '\t' || d === ';' || d === '|' || d === '&' || d === '\n' || d === ')' ) break;
      if (d === '(' && v === '' ) break;
      if (d === '"' || d === "'") {
        const end = str.indexOf(d, i + 1);
        if (end < 0) { v += str.slice(i + 1); i = str.length; break; }
        v += str.slice(i + 1, end);
        if (d === '"' && /\$\(|`/.test(str.slice(i + 1, end))) dynamic = true;
        i = end + 1;
        continue;
      }
      if (d === '$' && str[i + 1] === '(') dynamic = true;
      if (d === '`') dynamic = true;
      if (d === '\\' && i + 1 < str.length) { v += str[i + 1]; i += 2; continue; }
      v += d;
      i++;
    }
    if (i > s) toks.push({ v, s: base + s, e: base + i });
    else i++;
  }
  push();
  return segments;
}

const PREFIX_CMDS = new Set(['sudo', 'time', 'nohup', 'exec', 'command', 'env', 'cross-env', 'dotenv', 'caffeinate', 'timeout', 'nice', 'unbuffer', 'xvfb-run', 'op']);
function stripPrefixes(toks) {
  let i = 0;
  for (;;) {
    if (i >= toks.length) break;
    const v = toks[i].v;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) { i++; continue; }
    if (PREFIX_CMDS.has(v)) {
      i++;
      if (v === 'timeout') { while (i < toks.length && /^-|^\d/.test(toks[i].v)) i++; }
      else if (v === 'op') { if (toks[i] && toks[i].v === 'run') i++; while (i < toks.length && toks[i].v.startsWith('-')) i++; }
      else while (i < toks.length && toks[i].v.startsWith('-') && toks[i].v !== '--') i++;
      if (toks[i] && toks[i].v === '--') i++;
      continue;
    }
    break;
  }
  return toks.slice(i);
}

function isLiteralName(s) {
  return !!s && !/[<>{}$*?\[\]|`'"]|\.\.\./.test(s) && !/^(?:x+|foo|bar|baz|name|script|target|recipe|task|cmd|command|your-?\w*|my-?\w*|<.*)$/i.test(s);
}

/* ------------------------------------------------------------------ */
/* Command recognition                                                 */
/* ------------------------------------------------------------------ */

const NPM_RUN = new Set(['run', 'run-script', 'rum', 'urn']);
const NPM_VALUE_FLAGS = new Set(['-w', '--workspace', '--prefix', '-C', '--loglevel', '--userconfig', '--cache', '--registry']);
const PNPM_VALUE_FLAGS = new Set(['-F', '--filter', '-C', '--dir', '--loglevel', '--reporter', '--workspace-concurrency', '--filter-prod', '--test-pattern', '--changed-files-ignore-pattern', '--resume-from', '--cwd']);
const YARN_VALUE_FLAGS = new Set(['--cwd', '--modules-folder', '--cache-folder', '--mutex', '--network-timeout']);
const BUN_VALUE_FLAGS = new Set(['--cwd', '-c', '--config', '--filter', '-F', '--env-file', '--preload', '-r', '--tsconfig-override']);
const ANY_PKG_FLAGS = new Set(['-w', '--workspace', '--workspaces', '-ws', '--prefix', '-C', '--dir', '-F', '--filter', '-r', '--recursive', '--cwd', '--filter-prod', '--include-workspace-root', '--workspace-root']);

const PNPM_BUILTINS = new Set(['add', 'install', 'i', 'update', 'up', 'upgrade', 'remove', 'rm', 'un', 'uninstall', 'link', 'ln', 'unlink', 'import', 'rebuild', 'rb', 'prune', 'fetch', 'patch', 'patch-commit', 'patch-remove', 'audit', 'list', 'ls', 'll', 'la', 'outdated', 'why', 'licenses', 'exec', 'dlx', 'create', 'init', 'publish', 'pack', 'store', 'root', 'bin', 'setup', 'env', 'deploy', 'config', 'c', 'get', 'set', 'doctor', 'server', 'recursive', 'help', 'self-update', 'cat-file', 'cat-index', 'find-hash', 'approve-builds', 'ignored-builds', 'catalog', 'dedupe', 'completion', 'install-test', 'it', 'version', 'view', 'info', 'show', 'login', 'logout', 'whoami', 'owner', 'dist-tag', 'docs', 'home', 'repo', 'bugs', 'search', 'unpublish', 'deprecate', 'undeprecate', 'cache', 'sbom', 'x', 'restart', 'stop', 'run', 'test', 't', 'tst', 'start', 'node', 'ci', 'clean', 'update-interactive', 'add-global', 'licenses', 'runtime', 'setup', 'store-path', 'pkg', 'fund', 'ping', 'access', 'token', 'team', 'star', 'stars', 'profile', 'hook', 'edit', 'explore', 'query', 'shrinkwrap']);
const YARN_BUILTINS = new Set(['add', 'install', 'remove', 'upgrade', 'up', 'init', 'info', 'why', 'workspaces', 'workspace', 'dlx', 'exec', 'node', 'bin', 'cache', 'config', 'constraints', 'dedupe', 'explain', 'npm', 'pack', 'patch', 'patch-commit', 'plugin', 'rebuild', 'set', 'unplug', 'version', 'global', 'link', 'unlink', 'login', 'logout', 'publish', 'audit', 'autoclean', 'check', 'create', 'generate-lock-entry', 'import', 'licenses', 'list', 'outdated', 'owner', 'policies', 'tag', 'team', 'upgrade-interactive', 'help', 'run', 'test', 'start', 'stage', 'search', 'sdks', 'tsc-not', 'refresh', 'remove-unused']);
const BUN_BUILTINS = new Set(['run', 'test', 'x', 'repl', 'exec', 'init', 'create', 'c', 'install', 'i', 'add', 'a', 'remove', 'rm', 'update', 'outdated', 'link', 'unlink', 'pm', 'build', 'upgrade', 'publish', 'audit', 'info', 'patch', 'patch-commit', 'why', 'completions', 'help', 'feedback', 'discord', 'getcompletes', 'ci']);
const KNOWN_JS_BINS = new Set(['tsc', 'tsserver', 'node', 'eslint', 'prettier', 'jest', 'vitest', 'mocha', 'ava', 'tap', 'c8', 'nyc', 'playwright', 'cypress', 'webpack', 'rollup', 'vite', 'esbuild', 'tsup', 'tsx', 'ts-node', 'swc', 'babel', 'next', 'nuxi', 'nuxt', 'astro', 'remix', 'svelte-kit', 'svelte-check', 'vue-tsc', 'ng', 'nest', 'expo', 'react-native', 'turbo', 'nx', 'lerna', 'changeset', 'prisma', 'drizzle-kit', 'wrangler', 'vercel', 'netlify', 'biome', 'oxlint', 'stylelint', 'husky', 'lint-staged', 'concurrently', 'rimraf', 'serve', 'http-server', 'electron', 'electron-builder', 'tauri', 'storybook', 'sb', 'typedoc', 'jsdoc', 'knip', 'depcheck', 'syncpack', 'eslint_d', 'tsc-alias', 'vsce', 'ovsx', 'semantic-release', 'release-it', 'np', 'graphql-codegen', 'openapi-typescript', 'orval', 'size-limit', 'madge', 'commitlint', 'cz', 'sort-package-json', 'pkg', 'nodemon', 'pm2', 'zx', 'shx', 'cpy', 'del-cli', 'npm-run-all', 'run-p', 'run-s', 'wireit', 'react-scripts', 'gatsby', 'docusaurus', 'vitepress', 'vuepress', 'eleventy', 'hexo', 'ts-jest', 'tsd', 'attw', 'publint', 'api-extractor', 'lefthook', 'markdownlint', 'markdownlint-cli2', 'cspell', 'jscodeshift', 'quasar', 'ionic', 'cap', 'workbox', 'mkdirp', 'json', 'dotenv', 'env-cmd', 'kysely', 'knex', 'sequelize', 'typeorm', 'mikro-orm', 'supabase', 'firebase', 'convex', 'sst', 'cdk', 'serverless', 'sls', 'pulumi', 'cdktf', 'turbowatch', 'tsdown', 'unbuild', 'rolldown', 'rspack', 'rsbuild', 'parcel', 'snowpack', 'jiti', 'bunchee', 'microbundle', 'plop', 'hygen', 'degit', 'patch-package', 'only-allow', 'npx']);

const PY_KNOWN_BINS = new Set(['python', 'python3', 'pip', 'pip3', 'pytest', 'py.test', 'ruff', 'mypy', 'black', 'isort', 'flake8', 'pylint', 'coverage', 'tox', 'nox', 'pre-commit', 'ipython', 'jupyter', 'jupyter-lab', 'sphinx-build', 'sphinx-autobuild', 'mkdocs', 'uvicorn', 'gunicorn', 'hypercorn', 'alembic', 'django-admin', 'celery', 'pyright', 'basedpyright', 'maturin', 'fastapi', 'flask', 'streamlit', 'gradio', 'dagster', 'airflow', 'scrapy', 'locust', 'bandit', 'safety', 'pip-audit', 'twine', 'build', 'hatch', 'pdm', 'poetry', 'uv', 'pyinstaller', 'cython', 'nuitka', 'behave', 'ward', 'hypothesis', 'pydocstyle', 'autopep8', 'yapf', 'codespell', 'interrogate', 'vulture', 'radon', 'xenon', 'deptry', 'pyupgrade', 'ty', 'pyrefly', 'marimo', 'dvc', 'mlflow', 'huggingface-cli', 'modal', 'ansible', 'ansible-playbook', 'invoke', 'inv', 'doit', 'scons', 'sqlfluff', 'dbt', 'datasette', 'litestar', 'granian', 'daphne', 'textual', 'pyside6-uic', 'manage.py', 'semgrep', 'cookiecutter', 'copier', 'bumpversion', 'bump-my-version', 'towncrier', 'commitizen', 'cz', 'mike', 'griffe', 'pdoc', 'nbqa', 'jupytext', 'papermill']);

const CARGO_BUILTINS = new Set(['build', 'b', 'check', 'c', 'clean', 'doc', 'd', 'new', 'init', 'add', 'remove', 'rm', 'run', 'r', 'test', 't', 'bench', 'update', 'search', 'publish', 'install', 'uninstall', 'fmt', 'clippy', 'fix', 'tree', 'metadata', 'vendor', 'package', 'login', 'logout', 'owner', 'yank', 'help', 'version', 'generate-lockfile', 'locate-project', 'pkgid', 'report', 'rustc', 'rustdoc', 'fetch', 'verify-project', 'config', 'info', 'read-manifest', 'git-checkout', 'miri', 'nextest', 'llvm-cov', 'audit', 'deny', 'watch', 'expand', 'machete', 'insta', 'make', 'binstall', 'edit', 'udeps', 'outdated', 'criterion', 'tarpaulin', 'dist', 'release', 'hack', 'about', 'sweep', 'mutants', 'flamegraph', 'leptos', 'tauri', 'shuttle', 'lambda', 'component', 'ndk', 'apk', 'mobile', 'web', 'wasi', 'xwin', 'zigbuild', 'cross', 'semver-checks', 'msrv', 'bloat', 'asm', 'show-asm', 'geiger', 'sort', 'upgrade', 'set-version', 'workspaces', 'ws', 'smart-release', 'changelog', 'public-api', 'llvm-lines', 'fuzz', 'kani', 'pgrx', 'sqlx', 'leptosfmt', 'dylint', 'careful', 'auditable', 'cyclonedx', 'license', 'minimal-versions', 'xtask-not', 'chef', 'contracts', 'stylus', 'risczero', 'shear', 'autoinherit', 'run-script', 'make', 'cmd', 'script', 'generate', 'zisk', 'pgo', 'bundle', 'deb', 'rpm', 'wix', 'aur', 'appimage', 'ui', 'modules', 'docs-rs', 'rdme', 'readme', 'outdated', 'update-installed', 'cache', 'local-registry', 'vet', 'crev', 'supply-chain', 'acl', 'all-features', 'udeps', 'clean-all', 'sweep', 'nextest', 'insta', 'wasm', 'binutils', 'objdump', 'nm', 'size', 'strip', 'cov', 'show']);

/** Returns the instruction-relative lookup context for a command: list of candidate dirs. */
function commandDir(ctx, instrDir, cwd) {
  return cwd === undefined ? instrDir : cwd;
}

function pickPackages(ctx, dir) {
  const chain = ancestors(dir);
  const res = [];
  for (const d of chain) { const p = readPackage(ctx, d); if (p) { res.push(p); break; } }
  const rootPkg = readPackage(ctx, '');
  if (rootPkg && !res.includes(rootPkg)) res.push(rootPkg);
  return res;
}

function allDeps(ctx) {
  return memo(ctx, 'alldeps', () => {
    const s = new Set();
    for (const p of allPackages(ctx)) if (!p.invalid) for (const d of p.deps) { s.add(d); s.add(d.slice(d.lastIndexOf('/') + 1)); }
    return s;
  });
}

/* ------------------------------------------------------------------ */
/* Version helpers (CD004)                                             */
/* ------------------------------------------------------------------ */

function parseVer(s) {
  const m = /^\s*v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?/.exec(String(s));
  if (!m) return null;
  const out = [Number(m[1])];
  if (m[2] !== undefined) { if (/^\d+$/.test(m[2])) out.push(Number(m[2])); else return out; }
  if (m[3] !== undefined) { if (/^\d+$/.test(m[3])) out.push(Number(m[3])); }
  return out;
}
function cmpVer(a, b, len) {
  const n = len === undefined ? Math.max(a.length, b.length) : len;
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
function prefixEq(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}
function satisfiesComparator(v, comp) {
  comp = comp.trim();
  if (!comp || comp === '*' || /^[xX]$/.test(comp)) return true;
  const m = /^(\^|~=|~|>=|<=|>|<|===|==|=|!=)?\s*v?(.+)$/.exec(comp);
  if (!m) return true;
  const op = m[1] || '';
  const r = parseVer(m[2]);
  if (!r) return true;
  switch (op) {
    case '': case '=': case '==': case '===': return prefixEq(v, r);
    case '!=': return !prefixEq(v, r);
    case '>=': return cmpVer(v, r) >= 0;
    case '<=': return cmpVer(v, r, r.length) <= 0;
    case '>': return cmpVer(v, r, r.length) > 0;
    case '<': return cmpVer(v, r) < 0;
    case '^': {
      if (cmpVer(v, r) < 0) return false;
      if (r[0] > 0 || r.length === 1) return v[0] === r[0];
      if ((r[1] || 0) > 0 || r.length === 2) return v[0] === 0 && v[1] === r[1];
      return prefixEq(v, r);
    }
    case '~': {
      if (cmpVer(v, r) < 0) return false;
      if (r.length === 1) return v[0] === r[0];
      return v[0] === r[0] && v[1] === r[1];
    }
    case '~=': {
      if (cmpVer(v, r) < 0) return false;
      const pre = r.slice(0, Math.max(1, r.length - 1));
      return prefixEq(v, pre);
    }
    default: return true;
  }
}
function satisfiesRange(v, range) {
  const alts = String(range).split('||');
  return alts.some((alt) => {
    alt = alt.trim();
    const hy = /^v?([\d.xX*]+)\s+-\s+v?([\d.xX*]+)$/.exec(alt);
    if (hy) {
      const lo = parseVer(hy[1]), hi = parseVer(hy[2]);
      return lo && hi && cmpVer(v, lo) >= 0 && cmpVer(v, hi, hi.length) <= 0;
    }
    const comps = alt.replace(/(>=|<=|~=|==|!=|>|<|\^|~|=)\s+/g, '$1').split(/[\s,]+/).filter(Boolean);
    return comps.every((c) => satisfiesComparator(v, c));
  });
}
/** Is there a version with prefix `claim` that satisfies `range`? */
function claimFitsRange(claim, range) {
  const cands = [claim.concat([0, 0, 0]).slice(0, 3), claim.concat([999, 999, 999]).slice(0, 3)];
  const nums = String(range).match(/\d+(?:\.\d+){0,2}/g) || [];
  for (const n of nums) { const p = parseVer(n); if (p && prefixEq(p, claim)) cands.push(p.concat([0, 0]).slice(0, 3)); }
  return cands.some((c) => satisfiesRange(c, range));
}
const NODE_LTS = { argon: 4, boron: 6, carbon: 8, dubnium: 10, erbium: 12, fermium: 14, gallium: 16, hydrogen: 18, iron: 20, jod: 22, krypton: 24 };

function nearestFile(ctx, dir, names) {
  for (const d of ancestors(dir)) for (const n of names) { const rel = d ? d + '/' + n : n; if (hasFile(ctx, rel)) return rel; }
  return null;
}
function firstLine(t) {
  for (const l of splitLines(t || '')) { const s = l.replace(/#.*/, '').trim(); if (s) return s; }
  return '';
}

/** Version sources for a language, nearest to dir. Each: { kind: 'pin'|'range', value, ver?, source } */
function versionSources(ctx, lang, dir) {
  return memo(ctx, 'vs:' + lang + ':' + dir, () => {
    const out = [];
    const toolVersions = nearestFile(ctx, dir, ['.tool-versions']);
    const tv = (name) => {
      if (!toolVersions) return;
      for (const l of splitLines(readRel(ctx, toolVersions) || '')) {
        const m = new RegExp('^\\s*' + name + '\\s+(\\S+)').exec(l);
        if (m) { const v = parseVer(m[1]); if (v) out.push({ kind: 'pin', ver: v, value: m[1], source: toolVersions }); }
      }
    };
    if (lang === 'node') {
      for (const n of ['.nvmrc', '.node-version']) {
        const f = nearestFile(ctx, dir, [n]);
        if (!f) continue;
        let s = firstLine(readRel(ctx, f)).replace(/^node\//i, '');
        const lts = /^lts\/(\w+)/i.exec(s);
        if (lts && NODE_LTS[lts[1].toLowerCase()]) s = String(NODE_LTS[lts[1].toLowerCase()]);
        const v = parseVer(s);
        if (v && /^v?\d/.test(s)) out.push({ kind: 'pin', ver: v, value: s, source: f });
      }
      // only the nearest package.json: a package may support other Node versions than the workspace root
      for (const p of pickPackages(ctx, dir).slice(0, 1)) {
        if (p.invalid) continue;
        const e = p.json.engines && p.json.engines.node;
        if (typeof e === 'string' && /\d/.test(e)) out.push({ kind: 'range', value: e, source: p.rel + ' engines.node' });
        const vo = p.json.volta && p.json.volta.node;
        if (typeof vo === 'string' && parseVer(vo)) out.push({ kind: 'pin', ver: parseVer(vo), value: vo, source: p.rel + ' volta.node' });
      }
      tv('nodejs');
      tv('node');
    } else if (lang === 'python') {
      const f = nearestFile(ctx, dir, ['.python-version']);
      if (f) {
        const pins = splitLines(readRel(ctx, f) || '').map((l) => l.replace(/#.*/, '').trim()).filter((l) => /^\d/.test(l));
        if (pins.length) out.push({ kind: 'pins', vers: pins.map(parseVer).filter(Boolean), value: pins.join(', '), source: f });
      }
      const rt = nearestFile(ctx, dir, ['runtime.txt']);
      if (rt) { const m = /python-(\d+\.\d+(?:\.\d+)?)/.exec(readRel(ctx, rt) || ''); if (m) out.push({ kind: 'pin', ver: parseVer(m[1]), value: m[1], source: rt }); }
      const pp = nearestFile(ctx, dir, ['pyproject.toml']);
      if (pp) {
        const toml = readToml(ctx, pp);
        const rp = toml && tomlGet(toml, 'project', 'requires-python');
        if (typeof rp === 'string' && /\d/.test(rp)) out.push({ kind: 'range', value: rp, source: pp + ' requires-python' });
        const pv = toml && tomlGet(toml, 'tool.poetry.dependencies', 'python');
        if (typeof pv === 'string' && /\d/.test(pv)) out.push({ kind: 'range', value: pv, source: pp + ' tool.poetry.dependencies.python' });
      }
      tv('python');
    } else if (lang === 'go') {
      const gm = nearestFile(ctx, dir, ['go.mod']);
      if (gm) {
        const t = readRel(ctx, gm) || '';
        const m = /^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(t);
        if (m) out.push({ kind: 'range', value: '>=' + m[1], source: gm + ' go directive' });
        const tc = /^toolchain\s+go(\d+\.\d+(?:\.\d+)?)/m.exec(t);
        if (tc) out.push({ kind: 'pin', ver: parseVer(tc[1]), value: tc[1], source: gm + ' toolchain' });
      }
      tv('golang');
    }
    return out;
  });
}
function claimConsistent(claim, src) {
  // claim: { vers: [tuple], min: bool }
  return claim.vers.some((c) => {
    if (src.kind === 'pin' || src.kind === 'pins') {
      const pins = src.kind === 'pin' ? [src.ver] : src.vers;
      return pins.some((p) => (claim.min ? cmpVer(p, c, Math.min(c.length, p.length)) >= 0 : prefixEq(p, c)));
    }
    return claimFitsRange(c, src.value);
  });
}

const LANG_LABEL = { node: 'Node', python: 'Python', go: 'Go' };
// Every quantifier below is separated from its neighbours by a required literal, so no two
// adjacent quantifiers can match the same characters (no polynomial backtracking).
const MIN_SUFFIX = '(\\s*(?:\\+|(?:or|and)\\s+(?:newer|later|above|higher|up)|\\(?(?:newer|later|or later|or newer|and up)\\)?))';
const VERSION_PATTERNS = [
  // "node" in prose must be "Node", "Node.js"/"nodejs", or followed by "version": "node 7 of the cluster" is not a runtime claim
  { lang: 'node', re: new RegExp('\\b(?:Node(?:\\.?js)?|NODE(?:\\.?JS)?|node(?:\\.?js)(?=\\W)|node(?=\\s+version))(?![\\w-])(?:\\s*(?:v(?=\\d)|version(?=\\s)|@))?(?:\\s*(>=|=>|≥|\\^|~|>))?\\s*v?(\\d{1,2}(?:\\.(?:\\d+|x))?(?:\\.(?:\\d+|x))?)(?![\\d.]*\\w)' + MIN_SUFFIX + '?', 'g'), minMajor: 4 },
  { lang: 'node', re: /\bnvm\s+(?:use|install|alias\s+default)\s+v?(\d{1,2}(?:\.\d+){0,2})\b/g, cmd: true },
  { lang: 'python', re: new RegExp('\\b(?:c?[Pp]ython|PYTHON)(?:\\s*(?:v(?=\\d)|version(?=\\s)))?(?:\\s*(>=|=>|≥|~=|\\^|>|==))?\\s*([23]\\.\\d{1,2}(?:\\.(?:\\d+|x|\\*))?)(?![\\d.]*\\w)' + MIN_SUFFIX + '?', 'g') },
  { lang: 'python', re: /\bpyenv\s+(?:install|local|global|shell)\s+([23]\.\d{1,2}(?:\.\d+)?)\b/g, cmd: true },
  { lang: 'python', re: /(?:--python[= ]|\buv\s+python\s+(?:install|pin)\s+|\buv\s+venv\s+-p\s+)([23]\.\d{1,2}(?:\.\d+)?)\b/g, cmd: true },
  { lang: 'go', re: new RegExp('\\b(?:Go|golang|Golang|GoLang|GO)(?=\\s)(?:\\s*(?:v(?=\\d)|version(?=\\s)))?(?:\\s*(>=|≥))?\\s*(1\\.\\d{1,2}(?:\\.\\d+)?)(?![\\d.]*\\w)' + MIN_SUFFIX + '?', 'g') },
];
/** Words before a version that make it history, a feature note or a CI detail rather than a requirement. */
const VERSION_NOT_A_CLAIM = /\b(?:no longer|dropped|deprecated|removed|end[- ]of[- ]life|eol|unsupported|not supported|legacy|old|older|previously|formerly|was|were|used to|upgrade[ds]? from|migrat\w* from|before|until|below|less than|prior to|not|never|avoid|don'?t|doesn'?t|instead of|added in|introduced in|available (?:in|since)|since|new in|changed in|fixed in|as of|ci (?:runs|uses|pins|tests)|(?:docker|container|base) image|image|matrix|tested (?:on|with|against)|e\.g\.?|for example|such as|like)\b[^.;!?]*$/i;
const VERSION_TAIL_NOT_A_CLAIM = /^\s*\((?:[^)]{0,60}\b(?:root|parent|workspace|monorepo)\b)|^\s*\)?\s*(?:is|are|was|were|has been|have been)?\s*(?:no longer|dropped|deprecated|removed|EOL|end[- ]of[- ]life|unsupported|not supported|too old|is too old|too new|or older|and older|and below)\b|^[^.;!?]{0,40}\b(?:too old|too new|not supported|unsupported)\b/i;
const MULTI_TAIL = /^\s*(?:,|\/|\bor\b|\band\b|&|-|–|\bto\b|\bthrough\b)\s*v?(\d{1,2}(?:\.\d+)?)(?![\d.]*\w)/i;

/* ------------------------------------------------------------------ */
/* Per-file analysis                                                   */
/* ------------------------------------------------------------------ */

/** C0/C1 control characters and bidi/invisible direction marks: a repo could use them to rewrite a terminal or reorder text. */
const UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Replaces control and bidi characters with visible \uXXXX escapes (tabs and line breaks stay). */
function safeText(s) {
  return String(s).replace(UNSAFE_CHARS, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
/** For one-line fields in terminal and CI output (file names, messages): also escapes line breaks and tabs,
 * so a file name with a newline cannot print a line of its own (a forged `::error` workflow command). */
function safeLine(s) {
  return safeText(s).replace(/[\n\t]/g, (c) => (c === '\n' ? '\\u000a' : '\\u0009'));
}
function mkDiag(ruleId, severity, rel, line, col, endCol, message, extra) {
  const d = { ruleId, severity, file: rel, line, column: col, endLine: line, endColumn: endCol, message: safeText(message) };
  if (extra) Object.assign(d, extra);
  if (d.fix && d.fix.title) d.fix = Object.assign({}, d.fix, { title: safeText(d.fix.title) });
  if (d.related) d.related = d.related.map((r) => Object.assign({}, r, { message: safeText(r.message) }));
  return d;
}

/**
 * Analyze one instruction file. Returns { diagnostics, facts }.
 * facts.verbs: Map<verb, [{key, display, line, col, endCol}]>
 */
const COMMANDS_OF_INTEREST = new Set(['cd', 'pushd', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'pnpx', 'make', 'gmake', 'just', 'task', 'go-task', 'cargo', 'uv', 'poetry', 'pdm', 'rye',
  'go', 'gofmt', 'golangci-lint', 'pytest', 'py.test', 'python', 'python3', 'ruff', 'black', 'mypy', 'pyright', 'eslint', 'oxlint', 'flake8', 'pylint', 'prettier', 'biome', 'vitest', 'jest', 'mocha', 'ava', 'tsc', 'node', 'deno']);
/** At most this many findings per instruction file; past it, one note says the file was not fully checked. */
const MAX_FINDINGS_PER_FILE = 2000;
/** Default time budget for one analyzeWorkspace run. */
const DEFAULT_BUDGET_MS = 20 * 1000;

function analyzeText(ctx, rel, text, opts) {
  opts = opts || {};
  const out = [];
  const facts = { verbs: new Map(), kind: classifyInstructionFile(rel) };
  if (typeof text !== 'string') return { diagnostics: out, facts };
  text = stripBom(text);
  if (text.length > MAX_INSTRUCTION_BYTES || isBinaryText(text)) return { diagnostics: out, facts };
  const doc = scanDocument(text);
  const instrDir = posixDirname(rel);
  let capped = false;
  const deadline = opts.deadline || Infinity;
  let timedOut = false;
  let tick = 0;
  /** True once the file hit the finding cap or the run's time budget: every loop below stops then. */
  const stop = () => {
    if (capped || timedOut) return true;
    if ((++tick & 63) === 0 && Date.now() > deadline) { timedOut = true; facts.timedOut = true; }
    return timedOut;
  };
  const emit = (d) => {
    if (isDisabled(doc, d.ruleId, d.line)) return;
    if (out.length >= MAX_FINDINGS_PER_FILE) {
      if (!capped) { capped = true; facts.capped = true; }
      return;
    }
    out.push(d);
  };
  const seen = new Set();
  const emitOnce = (d) => { const k = d.ruleId + ':' + d.line + ':' + d.column; if (seen.has(k)) return; seen.add(k); emit(d); };

  const pmInfo = memo(ctx, 'pm:' + instrDir, () => repoPackageManager(ctx, instrDir));
  // Skills are reusable know-how (often about other projects): only check the files they bundle.
  const repoFacts = facts.kind !== 'SKILL.md';

  // ---- commands from inline code and shell fences
  const commandSources = [];
  for (const s of doc.inline) commandSources.push({ text: s.text, line: s.line, col: s.col, lineText: s.lineText, prevText: s.prevText, endCol: s.endCol, inline: true });
  for (const f of doc.fence) {
    if (!SHELL_LANGS.has(f.lang)) continue;
    let t = f.text;
    // console blocks, and shell blocks that use "$ " prompts: only prompt lines are commands (the rest is output).
    // ">" is not a prompt: it is npm's script banner and the shell's continuation prompt.
    if (PROMPT_LANGS.has(f.lang) || f.block.hasPrompt) {
      const pm = /^(\s*)(?:\$|%|❯|PS[^>]*>)\s/.exec(t);
      if (!pm) continue;
      t = ' '.repeat(pm[0].length) + t.slice(pm[0].length);
    }
    if (t.endsWith('\\')) t = t.slice(0, -1);
    commandSources.push({ text: t, line: f.line, col: 0, lineText: '', endCol: t.length, inline: false, afterCreate: f.afterCreate });
  }

  const interestCache = new Map(); // span text -> does it start a command we check?
  for (const src of repoFacts ? commandSources : []) {
    if (stop()) break;
    let t = src.text;
    if (src.inline) {
      const pm = /^(?:\$|❯|>)\s+/.exec(t);
      if (pm) t = ' '.repeat(pm[0].length) + t.slice(pm[0].length);
    }
    let interesting = interestCache.get(t);
    if (interesting === false) continue;
    const segs = tokenizeShell(t, src.col);
    if (interesting === undefined) {
      interesting = segs.some((sg) => { const tk = stripPrefixes(sg.toks); return tk.length && COMMANDS_OF_INTEREST.has(tk[0].v); });
      if (interestCache.size < 50000) interestCache.set(t, interesting);
      if (!interesting) continue;
    }
    if (src.inline && negated(src.lineText, src.col, src.endCol, src.prevText)) continue;
    src.elsewhere = src.inline && ELSEWHERE.test(sentenceAround(src.lineText, src.col, src.endCol, src.prevText));
    let cwd; // undefined => instruction dir
    for (const seg of segs) {
      if (capped) break;
      const toks = stripPrefixes(seg.toks);
      if (!toks.length) continue;
      const cmd = toks[0].v;
      if (cmd === 'cd' || cmd === 'pushd') {
        const target = toks[1];
        if (!target || /^[~/$-]|^[A-Za-z]:/.test(target.v) || !isLiteralPath(target.v)) { cwd = null; continue; }
        const base = cwd === undefined ? instrDir : cwd;
        if (base === null) continue;
        const cand = [normalizeRel(posixJoin(base, target.v)), normalizeRel(target.v)];
        if (cand[0] === null) { cwd = null; continue; } // climbs above the opened folder: cannot be checked
        const hit = cand.find((c) => c !== null && isDirRel(ctx, c));
        if (hit !== undefined) cwd = hit;
        else {
          cwd = null;
          const created = src.afterCreate || segs.slice(0, segs.indexOf(seg)).some((sg) => /^(?:mkdir|git|npx|pnpm|yarn|bun|bunx|npm|cargo|uv|poetry|django-admin|rails|composer|dotnet|go)$/.test(sg.toks[0] && sg.toks[0].v));
          if (!created && (src.inline || seg.toks[0] === toks[0])) {
            if (!looksIgnoredOrGenerated(ctx, cand[1] || cand[0] || '') && !(src.inline && negated(src.lineText, src.col, src.endCol, src.prevText))) {
              const resolved = cand[0] || cand[1] || '';
              emitOnce(mkDiag('CD002', 'warning', rel, src.line, target.s, target.e,
                `\`cd ${target.v}\`: directory "${target.v}" does not exist in the repo.`, { data: { kind: 'path', path: target.v, resolved, parent: nearestExistingParent(ctx, resolved), sparse: ctx.sparse || undefined } }));
            }
          }
        }
        continue;
      }
      if (cwd === null) continue;
      if (seg.dynamic) continue;
      const dir = commandDir(ctx, instrDir, cwd);
      facts.dir = cwd === undefined ? '.' : cwd; // '.' = where the file's scope runs commands
      const emitCmd = (d) => {
        if (d.ruleId === 'CD001') {
          if (src.elsewhere) return; // runs in another package, or from a workspace root outside this repo
          // sparse checkout: workspace-wide forms and crates may live outside the checked-out cone
          if (ctx.sparse && (!d.data || !d.data.manifest || d.data.anyPkg || /^cargo/.test(d.data.kind))) return;
        }
        emitOnce(d);
      };
      checkCommand(ctx, rel, src, toks, dir, emitCmd, facts, pmInfo, cwd !== undefined);
    }
  }

  // ---- CD003 prose: "use yarn", "we use npm"
  if (repoFacts && pmInfo && pmInfo.pm) {
    const re = /\b(?:use|uses|using|prefer|prefers|run with|install with|via)\s+`?(npm|pnpm|yarn|bun)`?(?![\w.@/-])/gi;
    for (const p of doc.prose) {
      if (stop()) break;
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(p.text))) {
        const pmName = m[1].toLowerCase();
        if (pmName === pmInfo.pm) continue;
        const col = m.index + m[0].lastIndexOf(m[1]);
        const after = p.text.slice(col, col + 80);
        if (/^\w+`?\s*(?:to|for)\s+(?:publish|log ?in|install\s+(?:it\s+)?globally|global)|\s-g\b|--global/i.test(after)) continue;
        const before = stripSpans(contextBefore(p.text, m.index, p.prevText));
        if (negatedBefore(before)) continue;
        if (/\b(?:over|rather than|instead of|stop|stopped|quit|no longer|never)\s*$/i.test(before)) continue;
        emitOnce(mkDiag('CD003', 'warning', rel, p.line, col, col + m[1].length,
          `This file says to use ${pmName}, but the repo uses ${pmInfo.pm} (${pmInfo.source}).`, { data: { kind: 'pm', expected: pmInfo.pm } }));
      }
    }
  }

  // ---- CD004 version claims (prose, inline code, shell fences)
  const vLines = [];
  for (const p of doc.prose) vLines.push({ text: p.text, line: p.line, prevText: p.prevText });
  for (const f of doc.fence) if (SHELL_LANGS.has(f.lang)) vLines.push({ text: f.text, line: f.line, fence: true });
  for (const vl of repoFacts ? vLines : []) {
    if (stop()) break;
    let perLine = 0; // a real line states a version a few times at most; a wall of them is not worth the CPU
    for (const pat of VERSION_PATTERNS) {
      if (vl.fence && !pat.cmd) continue;
      pat.re.lastIndex = 0;
      let m;
      while ((m = pat.re.exec(vl.text))) {
        if (++perLine > 16) break;
        let op, verStr, minSuffix;
        if (pat.cmd) { op = ''; verStr = m[1]; minSuffix = ''; } else { op = m[1] || ''; verStr = m[2]; minSuffix = m[3] || ''; }
        const v = parseVer(verStr);
        if (!v) continue;
        if (pat.minMajor && v[0] < pat.minMajor) continue;
        if (v[0] > 40 && pat.lang === 'node') continue;
        const vcol = m.index + m[0].indexOf(verStr, m[0].length - verStr.length - minSuffix.length - 2 > 0 ? m[0].search(/\d/) : 0);
        const startCol = m.index;
        const endCol = m.index + m[0].length;
        const lineText = vl.text;
        const ctxB = stripSpans(contextBefore(lineText, startCol, vl.prevText));
        if (VERSION_NOT_A_CLAIM.test(ctxB)) continue;
        const tail = lineText.slice(endCol, endCol + 60);
        if (VERSION_TAIL_NOT_A_CLAIM.test(tail)) continue;
        const vers = [v];
        let rangeTo = null;
        let rest = tail;
        let mm;
        let guard = 0;
        while ((mm = MULTI_TAIL.exec(rest)) && guard++ < 8) {
          const nv = parseVer(mm[1]);
          if (!nv) break;
          if (/^\s*(?:-|–|to|through)\s/i.test(rest) || /^\s*[-–]\s*v?\d/.test(rest)) rangeTo = nv;
          vers.push(nv);
          rest = rest.slice(mm[0].length);
        }
        if (rangeTo && vers.length === 2) { for (let x = v[0] + 1; x < rangeTo[0]; x++) vers.push([x]); }
        const isMin = !!minSuffix || op === '>=' || op === '=>' || op === '≥' || op === '>' || op === '^' || /^\s*(?:\+|or (?:newer|later|above|higher)|and (?:newer|later|above|up))/i.test(rest);
        const claim = { vers, min: isMin };
        const sources = versionSources(ctx, pat.lang, instrDir);
        const bad = sources.filter((s) => !claimConsistent(claim, s));
        if (!bad.length) continue;
        const label = LANG_LABEL[pat.lang];
        const claimText = lineText.slice(startCol, endCol).trim();
        const srcText = bad.map((s) => `${s.source} says ${s.value}`).join('; ');
        emitOnce(mkDiag('CD004', 'warning', rel, vl.line, startCol, endCol,
          `Version claim "${claimText}" does not match the repo: ${srcText}.`, { data: { kind: 'version', lang: label, sources: bad.map((s) => s.source) } }));
        void vcol;
      }
    }
  }

  // ---- CD002 paths (inline code + markdown links; never fenced blocks)
  const stats = { checked: 0, missing: 0, globs: 0, budget: { left: GLOB_WORK_PER_FILE } };
  facts.paths = stats;
  const emitPath = (d) => {
    if (d.severity !== 'info') stats.missing++;
    // sparse checkout: the path may be in the repo but not on disk; `git ls-files` decides later (or it is dropped)
    if (ctx.sparse) d.data = Object.assign({}, d.data, { sparse: true });
    emitOnce(d);
  };
  const skillBases = repoFacts ? null : skillRoots(ctx, instrDir);
  // identical spans in identical context give identical results: check each once per file
  const pathMemo = new Map();
  const checkOnce = (sp, isLink) => {
    if (out.length >= MAX_FINDINGS_PER_FILE) { emit({ ruleId: 'CD002', line: sp.line }); return; }
    if (!classifyPathCandidate(sp.text, isLink)) return;
    const lt = sp.lineText || '';
    const prevWin = sp.col < CONTEXT_CHARS ? (sp.prevText || '').slice(-CONTEXT_CHARS) : '';
    const key = (isLink ? 'L' : 'I') + sp.col + '\0' + sp.text + '\0' + lt.slice(Math.max(0, sp.col - CONTEXT_CHARS), sp.endCol + CONTEXT_CHARS) + '\0' + prevWin + '\0' + (sp.heading || '');
    let found = pathMemo.get(key);
    if (found === undefined) {
      found = { diags: [], checked: stats.checked };
      checkPathCandidate(ctx, rel, instrDir, sp, isLink, (d) => found.diags.push(d), skillBases, stats);
      found.checked = stats.checked - found.checked;
      pathMemo.set(key, found);
    } else stats.checked += found.checked;
    for (const d of found.diags) {
      const nd = Object.assign({}, d, { line: sp.line, endLine: sp.line });
      if (d.fix) nd.fix = Object.assign({}, d.fix, { line: sp.line, endLine: sp.line });
      emitPath(nd);
    }
  };
  for (const s of doc.inline) {
    if (stop()) break;
    if (!repoFacts && !SKILL_BUNDLE_PATH.test(s.text.replace(/\\/g, '/'))) continue; // skills describe *other* projects; check only their bundle
    checkOnce(s, false);
  }
  for (const l of doc.links) { if (stop()) break; checkOnce(l, true); }

  // ---- CD002 frontmatter globs in .mdc / .instructions.md
  if (doc.frontmatter && !stop() && (facts.kind === 'cursor-rule' || facts.kind === 'copilot-scoped')) {
    const scope = scopeDirOf(rel);
    for (let i = doc.frontmatter.start + 1; i < doc.frontmatter.end; i++) {
      if (doc.lines[i].length > MAX_LINE_CHARS) continue;
      const m = /^\s*(globs|applyTo)\s*:(.*)$/.exec(doc.lines[i]);
      if (!m) continue;
      const items = [];
      const value = m[2].trim();
      const valCol = value ? doc.lines[i].length - m[2].length + m[2].indexOf(value) : 0;
      if (value) {
        if (value.startsWith('[')) {
          const re = /"([^"]*)"|'([^']*)'|([^,\[\]\s][^,\[\]]*)/g; let mm;
          while ((mm = re.exec(value))) items.push({ g: (mm[1] || mm[2] || mm[3] || '').trim(), line: i, col: valCol + mm.index });
        } else {
          const q = value[0] === '"' || value[0] === "'" ? 1 : 0;
          const unq = value.slice(q, value.length - (q && value.endsWith(value[0]) ? 1 : 0));
          let off = q;
          for (const part of splitOutsideBraces(unq)) {
            const g = part.trim();
            if (g) items.push({ g, line: i, col: valCol + off + part.indexOf(g) });
            off += part.length + 1;
          }
        }
      } else {
        for (let j = i + 1; j < doc.frontmatter.end; j++) {
          const lj = doc.lines[j];
          if (lj.length > MAX_LINE_CHARS) break;
          const li = /^(\s*-\s*)(.*)$/.exec(lj);
          if (!li) break;
          let g = li[2].trimEnd();
          let col = li[1].length;
          if ((g[0] === '"' || g[0] === "'") && g.endsWith(g[0]) && g.length >= 2) { g = g.slice(1, -1); col++; }
          if (!g) break;
          items.push({ g, line: j, col });
        }
      }
      for (const it of items) {
        if (!it.g || it.g === '**' || it.g === '**/*' || it.g === '*') continue;
        if (++stats.globs > MAX_GLOBS_PER_FILE) break;
        if (looksIgnoredOrGenerated(ctx, normalizeRel(posixJoin(scope, it.g.replace(/^\.?\//, ''))) || it.g)) continue;
        if (!globMatchesAny(ctx, it.g, scope, stats.budget)) {
          emitPath(mkDiag('CD002', 'info', rel, it.line, it.col, it.col + it.g.length,
            `${m[1]} pattern "${it.g}" matches no files in the repo, so this rule never applies.`, { data: { kind: 'glob', glob: it.g } }));
        }
      }
    }
  }

  // ---- CD008 Codex size limit: one AGENTS.md over 32 KiB is cut off even before any other file is added
  if (CODEX_KINDS.has(facts.kind) && Buffer.byteLength(text, 'utf8') > CODEX_MAX_BYTES) {
    let bytes = 0;
    let line = 0;
    for (; line < doc.lines.length; line++) {
      const next = bytes + Buffer.byteLength(doc.lines[line], 'utf8') + 1;
      if (next > CODEX_MAX_BYTES) break;
      bytes = next;
    }
    const total = Buffer.byteLength(text, 'utf8');
    const kib = (total / 1024).toFixed(1);
    const lineText = doc.lines[line] || '';
    emit(mkDiag('CD008', 'warning', rel, line, 0, Math.max(1, lineText.length),
      `This file is ${kib} KiB. Codex loads at most 32 KiB of AGENTS.md text by default (project_doc_max_bytes), so it stops near this line and never reads the last ${((total - CODEX_MAX_BYTES) / 1024).toFixed(1)} KiB. Raise project_doc_max_bytes in ~/.codex/config.toml or move parts into AGENTS.md files in subfolders.`,
      { data: { kind: 'codex-size', bytes: total, limit: CODEX_MAX_BYTES } }));
  }

  // ---- CD007 import drift: "@path" imports (Claude Code memory imports, Gemini CLI memory import processor)
  if (IMPORT_KINDS.has(facts.kind) && !stop()) {
    const tool = facts.kind === 'GEMINI.md' ? 'Gemini CLI' : 'Claude Code';
    for (const p of doc.prose) {
      if (stop()) break;
      if (!p.masked.includes('@')) continue;
      IMPORT_RE.lastIndex = 0;
      let m;
      while ((m = IMPORT_RE.exec(p.masked))) {
        const t = importTarget(m[2]);
        if (!t) continue;
        const col = m.index + m[1].length + 1;
        checkImport(ctx, rel, instrDir, t, { line: p.line, col, endCol: col + t.shown.length }, tool, emitOnce);
      }
    }
  }

  if (doc.longLines) facts.longLines = doc.longLines;
  if (doc.spansCapped) facts.spansCapped = true;
  if (capped) out.push(mkDiag('CD002', 'info', rel, 0, 0, Math.max(1, (doc.lines[0] || '').length), `Stopped after ${MAX_FINDINGS_PER_FILE} findings; the rest of this file was not checked.`, { data: { kind: 'capped' } }));
  return { diagnostics: out, facts };
}

/* ------------------------------------------------------------------ */
/* CD007 import drift                                                  */
/* ------------------------------------------------------------------ */
/** Codex's default project_doc_max_bytes (32 KiB) and the files it applies to. */
const CODEX_MAX_BYTES = 32 * 1024;
const CODEX_KINDS = new Set(['AGENTS.md', 'AGENTS.override.md']);
/** Files whose "@path" lines are imports: Claude Code (CLAUDE.md, CLAUDE.local.md) and Gemini CLI (GEMINI.md). */
const IMPORT_KINDS = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md']);
/** "@" at line start or after white space, then the path up to the next white space ("\ " escapes a space). */
const IMPORT_RE = /(^|\s)@((?:[^\s\\]|\\ )+)/g;
/** Extensions that make "@name.ext" an import and not a handle, a decorator or a scoped npm package. */
const IMPORT_EXTS = new Set(['md', 'mdc', 'mdx', 'markdown', 'txt', 'text', 'rst', 'adoc', 'org', 'json', 'jsonc', 'json5', 'yaml', 'yml',
  'toml', 'ini', 'cfg', 'conf', 'xml', 'html', 'csv', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'go', 'rs', 'rb', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sql', 'graphql', 'gql', 'proto', 'prisma', 'tf', 'lock']);

/** The path of an "@..." token when it reads as an import of a repo file, else null. */
function importTarget(raw) {
  // trailing sentence punctuation and Markdown emphasis are not part of the path
  const shown = raw.replace(/[.,;:!?)\]}'"*_]+$/, '');
  if (!shown || shown.length > 300) return null;
  // home-folder and absolute imports differ per machine: not checkable from the repo
  if (shown[0] === '~' || shown[0] === '/' || shown[0] === '\\' || /^[A-Za-z]:[\\/]/.test(shown)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(shown)) return null; // URLs and other schemes
  if (/[<>{}$*?|`[\]()]/.test(shown) || shown.includes('@')) return null; // placeholders, globs, links, a@b
  const explicit = /^\.\.?\//.test(shown);
  const ext = /\.([A-Za-z][A-Za-z0-9]{0,9})$/.exec(shown);
  if (!explicit && !(ext && IMPORT_EXTS.has(ext[1].toLowerCase()))) return null;
  return { shown, path: shown.replace(/\\ /g, ' '), explicit };
}

function checkImport(ctx, rel, instrDir, t, range, tool, emit) {
  const target = normalizeRel(posixJoin(instrDir, t.path));
  if (target === null || target === '') return; // leaves the root: cannot check
  if (existsRel(ctx, target)) return;
  const subs = submodulePaths(ctx);
  if (subs.some((sp) => target === sp || target.startsWith(sp + '/'))) return;
  // gitignored or generated files are per user or per build (CLAUDE.local.md, notes/): absent in a clean checkout by design
  if (looksIgnoredOrGenerated(ctx, target)) return;
  const name = target.slice(target.lastIndexOf('/') + 1);
  const dir = posixDirname(target);
  let suggestion = null;
  const sameBase = (ctx.byBase.get(name) || []).filter((f) => !looksIgnoredOrGenerated(ctx, f));
  if (sameBase.length === 1) suggestion = sameBase[0];
  else if (!sameBase.length) {
    const siblings = [];
    for (const f of ctx.files) if (posixDirname(f) === dir) siblings.push(f.slice(f.lastIndexOf('/') + 1));
    const near = closest(name, siblings);
    if (near) suggestion = dir ? dir + '/' + near : near;
  }
  let fixText = null;
  if (suggestion) {
    fixText = relativeFrom(instrDir, suggestion, t.explicit);
    if (/\s/.test(fixText)) fixText = null; // keep the quick fix simple: no escaped spaces
  }
  const msg = `Import "@${t.shown}" points to "${target}", which does not exist. ${tool} skips a missing import without a warning, so these instructions never load` +
    (fixText ? `. Did you mean "@${fixText}"?` : '.');
  const d = mkDiag('CD007', 'warning', rel, range.line, range.col, range.endCol, msg, {
    data: { kind: 'import', path: t.path, resolved: target, parent: nearestExistingParent(ctx, target) },
  });
  if (fixText) d.fix = { title: `Replace with "@${fixText}"`, line: range.line, column: range.col, endLine: range.line, endColumn: range.endCol, newText: fixText };
  emit(d);
}

/** "a/*.py,b/*.{ts,tsx}" -> ["a/*.py", "b/*.{ts,tsx}"]: commas inside braces belong to the glob. */
function splitOutsideBraces(t) {
  const out = [];
  let depth = 0, st = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '{') depth++;
    else if (t[i] === '}' && depth) depth--;
    else if (t[i] === ',' && !depth) { out.push(t.slice(st, i)); st = i + 1; }
  }
  out.push(t.slice(st));
  return out;
}

/** Folders a SKILL.md may resolve bundle paths against: its own folder and the enclosing plugin root. */
function skillRoots(ctx, instrDir) {
  const out = [instrDir];
  const chain = ancestors(instrDir).slice(1);
  for (const d of chain) {
    const at = (n) => (d ? d + '/' + n : n);
    if (isDirRel(ctx, at('.claude-plugin')) || isDirRel(ctx, at('.codex-plugin')) || hasFile(ctx, at('plugin.json'))) { out.push(d); break; }
  }
  // .../<plugin>/skills/<name>/SKILL.md: the plugin root is the parent of "skills"
  const parent = posixDirname(instrDir);
  if (parent.slice(parent.lastIndexOf('/') + 1) === 'skills') { const pr = posixDirname(parent); if (!out.includes(pr)) out.push(pr); }
  const bundle = out.slice(); // the skill folder and the plugin root
  // a skill inside a project may name the project's own files
  if (!out.includes('')) out.push('');
  out.bundle = bundle;
  return out;
}

function isLiteralPath(p) {
  return !/[<>{}$*?|`]|\.\.\.|\bpath\/to\b|\b(?:your|my|some|example|sample|foo|bar|xxx|project-name|app-name|repo-name)\b/i.test(p);
}

const OUTPUT_DIRS = new Set(['out', 'tmp', 'temp', 'logs', 'log', '.env', 'reports', 'artifacts', 'outputs', 'output', 'generated', 'lib-cjs', 'cjs', 'esm', 'storybook-static', '_site', 'playwright-report', 'test-results', 'htmlcov', 'blob-report']);
/** Build-output, scratch and gitignored paths are never claims about the source tree. Works on globs too. */
function looksIgnoredOrGenerated(ctx, rel) {
  if (!rel) return false;
  const segs = rel.split('/').filter(Boolean);
  if (!segs.length) return false;
  if (OUTPUT_DIRS.has(segs[0])) return true;
  if (segs.some((x) => IGNORED_DIRS.has(x))) return true;
  // literal build-output segments anywhere (packages/*/build, packages/*/cjs, apps/web/.next)
  if (segs.slice(1).some((x) => x === 'cjs' || x === 'esm' || x === 'lib-cjs' || x === 'out')) return true;
  if (segs.some((x) => /generated/i.test(x))) return true; // _generated, __generated__, foo.generated.ts
  return isGitignored(ctx, rel);
}

function gitignoreRules(ctx) {
  return memo(ctx, 'gitignore', () => {
    const rules = [];
    const files = filesNamed(ctx, '.gitignore');
    if (ctx.gitDir) files.push(null); // .git/info/exclude
    for (const gi of files) {
      const base = gi === null ? '' : posixDirname(gi);
      let t;
      if (gi === null) {
        try { const abs = path.join(ctx.gitDir, 'info', 'exclude'); const st = fs.statSync(abs); t = st.size <= MAX_MANIFEST_BYTES ? fs.readFileSync(abs, 'utf8') : null; } catch (_) { t = null; }
        if (ctx.gitRoot && path.resolve(ctx.gitRoot) !== path.resolve(ctx.root)) t = null; // patterns are relative to the git root
      } else t = readRel(ctx, gi, 256 * 1024);
      if (!t) continue;
      for (let line of splitLines(t)) {
        if (rules.length >= MAX_GITIGNORE_RULES) return rules;
        if (line.length > MAX_GLOB_CHARS) continue;
        line = line.trimEnd();
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        let dirOnly = false;
        if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
        const anchored = line.replace(/\/\*\*$/, '').includes('/');
        line = line.replace(/^\//, '');
        const g = compileGlob(line);
        if (!g) continue;
        rules.push({ base, g, anchored, dirOnly });
      }
    }
    return rules;
  });
}
/**
 * Is rel (a path, or a glob whose wildcards are kept as literal characters) ignored by a .gitignore
 * rule in the repo? A rule that matches a parent folder ignores everything below it.
 */
function isGitignored(ctx, rel) {
  const rules = gitignoreRules(ctx);
  if (!rules.length) return false;
  return memo(ctx, 'ign:' + rel, () => {
    const budget = { left: 200000 };
    try {
      for (const r of rules) {
        if (r.base && !(rel === r.base || rel.startsWith(r.base + '/'))) continue;
        const local = r.base ? rel.slice(r.base.length + 1) : rel;
        const lp = local.split('/').filter(Boolean);
        for (let i = 1; i <= lp.length; i++) {
          if (r.anchored) { if (globMatch(r.g, lp.slice(0, i).join('/'), budget)) return true; }
          else if (globMatch(r.g, lp[i - 1], budget)) return true;
        }
      }
    } catch (e) { if (e === GLOB_BUDGET) return true; throw e; } // cannot tell: do not report
    return false;
  });
}

function basenameGitignored(ctx, name) {
  const budget = { left: 200000 };
  try {
    for (const r of gitignoreRules(ctx)) if (!r.anchored && globMatch(r.g, name, budget)) return true;
  } catch (e) { if (e !== GLOB_BUDGET) throw e; }
  return false;
}

function nearestExistingParent(ctx, rel) {
  let d = posixDirname(rel || '');
  while (d && !isDirRel(ctx, d)) d = posixDirname(d);
  return d;
}

/**
 * Does the glob match any file (or folder) of the repo? Files are pre-filtered by the glob's literal
 * leading folders, and the work is capped by `budget`: past it, the glob counts as matching (no report).
 */
function globMatchesAny(ctx, glob, baseDir, budget) {
  let g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let anchoredBase = baseDir || '';
  if (g.startsWith('/')) { g = g.slice(1); anchoredBase = ''; }
  const dirOnly = g.endsWith('/');
  if (dirOnly) g = g.slice(0, -1);
  const key = 'glob:' + anchoredBase + '\0' + g + (dirOnly ? '/' : '');
  if (ctx._cache.has(key)) return ctx._cache.get(key);
  const compiled = compileGlob(g);
  if (!compiled) return true; // too large to check: do not guess
  const hasSlash = g.includes('/');
  const last = g.slice(g.lastIndexOf('/') + 1);
  // a last segment without an extension can name a folder ("packages/*/src")
  const alsoDirs = !dirOnly && !/\.[A-Za-z0-9*?]+$/.test(last);
  const lead = [];
  for (const seg of g.split('/')) { if (!seg || /[*?[\]{}\\]/.test(seg)) break; lead.push(seg); }
  if (lead.length === g.split('/').length) lead.pop();
  const prefix = lead.join('/');
  const test = (pool, base, needSlash) => {
    for (const f of pool) {
      if (budget && --budget.left < 0) throw GLOB_BUDGET;
      let local = f;
      if (base) { if (!f.startsWith(base + '/')) continue; local = f.slice(base.length + 1); }
      if (needSlash) {
        if (prefix && !(local === prefix || local.startsWith(prefix + '/'))) continue;
        if (globMatch(compiled, local, budget)) return true;
      } else if (globMatch(compiled, local.slice(local.lastIndexOf('/') + 1), budget)) return true;
    }
    return false;
  };
  let hit = false;
  try {
    const pools = dirOnly ? [ctx.dirs] : alsoDirs ? [ctx.files, ctx.dirs] : [ctx.files];
    for (const pool of pools) {
      if (test(pool, anchoredBase, hasSlash)) { hit = true; break; }
      if (anchoredBase && hasSlash && test(pool, '', true)) { hit = true; break; } // also try from the repo root
    }
  } catch (e) {
    if (e !== GLOB_BUDGET) throw e;
    hit = true; // out of budget: do not report
  }
  ctx._cache.set(key, hit);
  return hit;
}

/* ---------- CD002 ---------- */

const PATH_EXTS = new Set(('md mdx mdc markdown txt json jsonc json5 yaml yml toml ini cfg conf js cjs mjs jsx ts cts mts tsx py pyi ipynb rb go rs java kt kts swift ' +
  'c h cc cpp cxx hpp hh m mm cs fs php sh bash zsh fish ps1 bat sql graphql gql proto html htm css scss sass less vue svelte astro xml gradle lock ' +
  'mk tf tfvars hcl csv tsv prisma zig ex exs erl hrl dart lua r jl scala sc clj cljs ml mli nix cmake bzl bazel star rst adoc svg png jpg jpeg gif webp ico ' +
  'wasm env example sample tpl tmpl j2 jinja hbs ejs pug liquid njk pem crt plist entitlements xcconfig pbxproj storyboard xib sol move cairo nim v cr hs elm rkt ' +
  'mdx http rest bru vsix gradle properties dockerfile containerfile service desktop patch diff spec snap').split(/\s+/));
const BARE_NAMES = new Set(['Makefile', 'GNUmakefile', 'Dockerfile', 'Containerfile', 'Justfile', 'justfile', 'Procfile', 'Gemfile', 'Rakefile', 'Vagrantfile', 'Brewfile', 'CODEOWNERS', 'Taskfile', 'Earthfile', 'Tiltfile', 'Pipfile', 'BUILD', 'WORKSPACE']);
const KNOWN_DOTFILES = new Set(['.nvmrc', '.node-version', '.python-version', '.tool-versions', '.editorconfig', '.prettierrc', '.eslintrc', '.npmrc', '.yarnrc', '.gitattributes', '.dockerignore', '.prettierignore', '.eslintignore', '.babelrc', '.swcrc', '.ruby-version', '.terraform-version', '.mise.toml', '.envrc', '.pre-commit-config.yaml', '.golangci.yml', '.golangci.yaml', '.markdownlint.json', '.lintstagedrc', '.czrc', '.releaserc', '.mocharc', '.c8rc', '.nycrc', '.stylelintrc', '.browserslistrc', '.huskyrc', '.commitlintrc']);
const BUILD_OUTPUT_NAMES = new Set(['main.js', 'bundle.js', 'app.js', 'styles.css', 'output.css', 'main.css', 'index.css', 'bundle.css', 'manifest.json', 'data.json', 'sw.js', 'service-worker.js', 'worker.js', 'server.js', 'app.py', 'out.json', 'report.json', 'results.json', 'output.json', 'log.txt']);
// generic names that instruction files mention as concepts, not as repo files
const GENERIC_FILE_MENTIONS = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md', 'AGENTS.local.md', 'AGENT.md', 'GEMINI.md', 'SKILL.md', '.cursorrules', '.windsurfrules', '.clinerules', 'copilot-instructions.md', 'settings.json', 'settings.local.json', 'llms.txt', 'llms-full.txt', 'MEMORY.md', 'mcp.json', '.mcp.json', 'config.toml', 'config.json', 'config.yaml', 'config.yml', 'index.html', 'index.js', 'index.ts', 'main.py', 'main.go', 'main.rs', 'lib.rs', 'mod.rs', '__init__.py', 'conftest.py', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', 'LICENSE.md', 'TODO.md', 'NOTES.md', 'PLAN.md', 'SPEC.md', 'STATUS.json', 'DONE', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'go.sum', 'npm-shrinkwrap.json', 'bun.lockb', 'Gemfile.lock', 'composer.lock', 'Pipfile.lock', 'tsconfig.json', 'jsconfig.json', 'vite.config.ts', 'vite.config.js', 'next.config.js', 'next.config.mjs', 'next.config.ts', '.env', '.env.local', '.env.example', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml']);

function classifyPathCandidate(raw, isLink) {
  let p = raw.trim();
  if (!p || p.length > 260 || /\s/.test(p)) return null;
  // Windows-style relative paths: .\scripts\build.ps1, src\index.ts (drive letters and UNC paths stay ignored)
  if (!isLink && !p.includes('/') && /^(?:\.{1,2}\\)?[\w@.+-]+(?:\\[\w@.+-]+)+\\?$/.test(p)) p = p.replace(/\\/g, '/');
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) && !/^[A-Za-z]:[\\/]/.test(p)) {
    // scheme or "file.ts:12" style
    const lc = /^(.+?\.[A-Za-z0-9]+):\d+(?::\d+)?$/.exec(p);
    if (!lc) return null;
    p = lc[1];
  }
  if (isLink) {
    if (p.startsWith('#') || p.startsWith('//') || p.startsWith('mailto:')) return null;
    p = p.replace(/[?#].*$/, '');
    try { p = decodeURIComponent(p); } catch (_) { /* keep */ }
    if (!p) return null;
  } else {
    p = p.replace(/:\d+(?::\d+)?$/, '').replace(/#L\d+(?:-L?\d+)?$/, '');
    p = p.replace(/::[\w.[\]-]+$/, ''); // tests/test_x.py::test_name, mod.py::Class
    p = p.replace(/(\.[A-Za-z0-9]+)#[\w.-]+$/, '$1'); // ../../AGENTS.md#section
    p = p.replace(/(\.[A-Za-z0-9]{1,8}):[A-Za-z_$][\w$.]*$/, '$1'); // src/constants.ts:VIEW_TYPE
  }
  if (p.startsWith('~') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')) return null;
  if (p.startsWith('/') && !isLink) return null;
  if (p.startsWith('@') || p.startsWith('-') || p.startsWith('$') || p.startsWith('%')) return null;
  if (/[<>{}$%|`"'(),;=!^&]/.test(p.replace(/\{[^}]*,[^}]*\}/g, ''))) return null; // placeholders / code
  if (/\.\.\.|\bpath\/to\b|\b(?:your|my|some|example|sample|foo|bar|xxx|yyy|NNN|YYYY|MM-DD)\b/i.test(p)) return null;
  if (/(?:^|[^A-Za-z])(?:your|my|some|example|sample|new|other)[_-]/i.test(p)) return null; // your_tool.py, my-app/, example_x
  if (/(?:^|[^A-Za-z])(?:NNN|XXX|YYYY|N{2,})(?:[_-]|$)/.test(p)) return null; // demo/NNN_*/
  if (/(?:^|[^A-Za-z])my(?:command|app|project|module|service|file|package|tool|component|feature|plugin|lib|crate|func|handler|test|script|repo|class|widget|page|route|model|view|api|skill|agent)s?\b/i.test(p)) return null; // mycommand.go
  if (/(?:^|\/)(?:camelCase|PascalCase|kebab-case|snake_case|SCREAMING_SNAKE_CASE|lowercase|UPPERCASE)\.\w+$/.test(p)) return null; // naming conventions
  if (/(?:^|\/)(?:name|filename|file|component|module|feature|thing|x|xyz|abc|foo|bar|my|your|some|example|sample)\.(?:[a-z0-9]+\.)?[a-z0-9]+$/i.test(p)) return null; // name.test.ts, file.ts
  if (isLink && p.startsWith('/') && !/\.[A-Za-z0-9]{1,8}$/.test(p.replace(/\/$/, ''))) return null; // site route: /features/analytics
  if (/^(?:\.{1,2})$/.test(p)) return null;
  const glob = isGlob(p);
  const clean = p.replace(/^\.\//, '');
  const segs = clean.split('/').filter(Boolean);
  if (!segs.length) return null;
  const last = segs[segs.length - 1];
  const extM = /\.([A-Za-z0-9]+)$/.exec(last);
  const ext = extM ? extM[1] : '';
  const hasSlash = clean.includes('/');
  const trailing = p.endsWith('/');
  // domain-ish first segment: github.com/x
  if (/^[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|dev|ai|app|co|sh|me|so|xyz|gg|ly|edu|gov|cloud|page|site|tech|run)$/i.test(segs[0]) && hasSlash) return null;
  if (/^\d+(?:\.\d+)*$/.test(clean) || /^v\d/.test(clean)) return null;
  if (/^[\d/.-]+$/.test(clean)) return null; // dates, fractions
  if (/^(?:\.[A-Za-z0-9]{1,4})+$/.test(clean)) return null; // ".ts", ".d.ts"
  if (!clean.includes('/') && /^\.[a-z][\w-]*\.[a-z0-9]+$/.test(clean) && !KNOWN_DOTFILES.has(clean.replace(/\.(json|js|cjs|mjs|ya?ml|toml)$/, '')) && !/^\.env\./.test(clean)) return null; // suffix pattern: ".content.ts", ".test.tsx"
  if (glob) {
    const fileGlob = hasSlash || /^\*\*?\./.test(last) || (ext && PATH_EXTS.has(ext));
    if (!fileGlob) return null; // LGPL-*, [CRIT], list[T], packages[0].id
    if (!hasSlash && /\[[^\]]*\]/.test(p)) return null;
  }
  // bare hostnames such as community.obsidian.md or docs.rs
  if (!hasSlash && /^[a-z0-9-]+(?:\.[a-z0-9-]+){2,}$/.test(clean) && /\.(?:md|sh|rs|py|cc|ml|so|ws|ps|io|ai|dev)$/.test(clean)) return null;
  return { path: p, clean, segs, last, ext, hasSlash, trailing, glob, explicitRel: p.startsWith('./') || p.startsWith('../'), rootRel: p.startsWith('/') };
}

const SKILL_BUNDLE_PATH = /^\.?\/?(?:scripts|references|reference|assets|templates|examples|resources)\/[^\s]+$/;

const RUNTIME_FILE = /(?:^|[-_.])(?:state|session|sessions|cache|history|receipts?|tokens?|auth|credentials?|secrets?|pid|queue|checkpoint|progress)(?:[-_.][\w-]*)?\.(?:json|jsonl|ya?ml|db|sqlite3?|log|lock|txt|toml|pid)$/i;

/** Dot-folders that are committed to repos (a missing one is drift); other dot-folders are tool state. */
const KNOWN_REPO_DOTDIRS = new Set(['.github', '.gitlab', '.vscode', '.cursor', '.devin', '.kiro', '.husky', '.devcontainer', '.circleci', '.changeset', '.storybook', '.config', '.cargo', '.claude', '.agents', '.windsurf', '.clinerules', '.idea', '.gitea', '.forgejo', '.buildkite', '.azure-pipelines', '.yarn', '.mvn', '.ddev', '.docker', '.k8s', '.helm', '.zed']);

/** Paths of git submodules declared in .gitmodules files of the workspace. */
function submodulePaths(ctx) {
  return memo(ctx, 'submodules', () => {
    const out = [];
    for (const gm of filesNamed(ctx, '.gitmodules')) {
      const base = posixDirname(gm);
      for (const line of splitLines(readRel(ctx, gm) || '')) {
        const m = /^\s*path\s*=(.*)$/.exec(line.length <= MAX_LINE_CHARS ? line : '');
        const v = m && m[1].trim();
        if (v) { const p = normalizeRel(posixJoin(base, v)); if (p) out.push(p); }
      }
    }
    return out;
  });
}

/** Extensions tried for module-style paths without one: src/utils/format -> src/utils/format.ts */
const MODULE_EXTS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro', 'py', 'go', 'rs', 'rb', 'java', 'kt', 'swift', 'dart', 'ex', 'php', 'cs', 'md', 'mdx', 'json', 'sh'];
function existsAsModule(ctx, rel) {
  if (!rel) return false;
  for (const e of MODULE_EXTS) if (hasFile(ctx, rel + '.' + e)) return true;
  if (isDirRel(ctx, rel)) return true;
  for (const e of MODULE_EXTS) if (hasFile(ctx, rel + '/index.' + e)) return true;
  return false;
}

function checkPathCandidate(ctx, rel, instrDir, s, isLink, emit, skillBases, stats) {
  const c = classifyPathCandidate(s.text, isLink);
  if (!c) return;
  if (c.glob && stats && stats.globs >= MAX_GLOBS_PER_FILE) return;
  if (c.glob && (c.path.startsWith('#') || !c.hasSlash)) return; // "#components/*" import aliases; "*.lock.json" name patterns
  const localOnly = !!skillBases;
  if (s.heading && EXAMPLE_HEADING.test(s.heading)) return;
  const lineText = s.lineText || '';
  if (negated(lineText, s.col, s.endCol, s.prevText)) return;
  if (!isLink) {
    const b = stripSpans(contextBefore(lineText, s.col, s.prevText));
    if (createdBefore(b)) return;
  }
  if (CREATE_AFTER.test(contextAfter(lineText, s.endCol)) || CREATE_AFTER.test(stripSpans(contextAfter(lineText, s.endCol)))) return;
  if (!isLink && ELSEWHERE.test(sentenceAround(lineText, s.col, s.endCol, s.prevText))) return;

  const lowerExt = c.ext.toLowerCase();
  const knownExt = c.ext && PATH_EXTS.has(c.ext) && c.ext === lowerExt;
  const isDotfileName = !c.hasSlash && KNOWN_DOTFILES.has(c.clean.replace(/\.(json|js|cjs|mjs|ya?ml|toml)$/, ''));
  const bareKnown = !c.hasSlash && BARE_NAMES.has(c.clean);
  let kind;
  if (c.glob) kind = 'glob';
  else if (c.hasSlash || c.explicitRel || isLink) kind = 'path';
  else if (knownExt || isDotfileName || bareKnown) kind = 'bare';
  else return;

  // a path right after an external URL usually lives in that other repo (the URL may end on the previous line)
  if (!isLink && (/\]\(https?:|https?:\/\//i.test(lineText.slice(0, s.col)) || (s.col < 3 && /https?:\/\/\S*$/.test(s.prevText || '')))) return;
  if (!isLink && /\breleases\/(?:latest|download)\b/.test(c.clean)) return; // a release download URL path
  // "from `../fetcher`": an import specifier, relative to a source file, not to this file
  if (!isLink && c.explicitRel && !c.ext && /\b(?:from|import|require)\s*\(?\s*$/i.test(stripSpans(contextBefore(lineText, s.col, s.prevText)))) return;
  // ... and so does a path right after an `owner/repo` name in the same sentence
  if (!isLink) {
    const before = contextBefore(lineText, s.col, s.prevText);
    const slug = /`([\w.-]+)\/([\w.-]+)`[^`]{0,40}$/.exec(before);
    if (slug && !/\.[a-z0-9]+$/i.test(slug[2]) && !isDirRel(ctx, slug[1]) && !isDirRel(ctx, posixJoin(instrDir, slug[1]) || '')) return;
  }
  // a skill's bundle paths name files; extensionless ones ("assets/source") usually describe what the skill creates
  if (localOnly && !c.ext && !c.trailing && !isLink) return;
  // ... and a skill that ships no scripts/ (references/, assets/) folder is talking about some other project's
  if (localOnly && !isLink && !skillBases.bundle.some((b) => isDirRel(ctx, posixJoin(b, c.segs[0]) || c.segs[0]))) return;
  const bases = localOnly ? skillBases : [instrDir];
  // only treat slash paths without an extension as path claims when they look like one
  if (kind === 'path' && !c.explicitRel && !c.trailing && !knownExt && !c.glob && !c.rootRel) {
    const first = c.segs[0];
    const firstExists = isDirRel(ctx, first) || bases.some((b) => isDirRel(ctx, posixJoin(b, first) || ''));
    if (!firstExists) return; // e.g. owner/repo, feat/branch, text/html
  }
  // GitHub-style slugs such as vercel/next.js or mrdoob/three.js
  if (kind === 'path' && !isLink && !c.explicitRel && c.segs.length === 2 && /^[\w-]+\.js$/i.test(c.last) &&
      !isDirRel(ctx, c.segs[0]) && !isDirRel(ctx, posixJoin(instrDir, c.segs[0]) || '')) return;
  if (kind === 'bare') {
    if (GENERIC_FILE_MENTIONS.has(c.clean)) return;
    if (/^[A-Z][\w]*\.js$/.test(c.clean)) return; // Node.js, Next.js, Vue.js ...
    if (/^\.env(\.|$)/.test(c.clean)) return;
    if (BUILD_OUTPUT_NAMES.has(c.clean) || basenameGitignored(ctx, c.clean)) return;
    // one plain lowercase word (data.ts, state.yml, page.tsx, utils.py): a per-module naming convention, not one file
    if (/^[a-z]{1,10}\.[a-z]{1,5}$/.test(c.clean)) return;
  }
  // runtime state files (launch-receipts.json, auth.json, last_session.yml): written by the program, not committed
  if ((kind === 'bare' || kind === 'path') && RUNTIME_FILE.test(c.last)) return;

  // paths listed after a home or absolute folder in the same sentence are relative to it: `~/.app/` (`state.json`, `audits/`)
  if (!isLink && !c.rootRel) {
    const b = contextBefore(lineText, s.col, s.prevText);
    const re = /`(?:~|\/|[^`\s]*node_modules\/)[^`\s]*`/g;
    let m, last = null;
    while ((m = re.exec(b))) last = m;
    if (last && !/[.;!?]/.test(stripSpans(b.slice(last.index + last[0].length)))) return;
  }
  const range = { line: s.line, col: s.col + Math.max(0, s.text.indexOf(c.path)), endCol: 0 };
  if (range.col === s.col && s.text.indexOf(c.path) < 0) range.col = s.col + Math.max(0, s.text.length - s.text.trimStart().length);
  range.endCol = range.col + Math.min(c.path.length, s.endCol - range.col > 0 ? s.endCol - range.col : c.path.length);
  if (stats) stats.checked++;

  if (kind === 'glob') {
    if (stats && ++stats.globs > MAX_GLOBS_PER_FILE) return;
    // paths in a nested instruction file are often relative to the package root: try every ancestor folder
    const gbases = localOnly ? bases : [...new Set([...bases, ...ancestors(instrDir)])];
    for (const b of gbases) if (existsRel(ctx, normalizeRel(posixJoin(b, c.clean)) || '')) return; // literal [id] route
    if (existsRel(ctx, normalizeRel(c.clean) || '')) return;
    // the literal folder before the first wildcard exists: "pages/forms/[slug]/**", "src/lib/harness/**"
    const litDir = c.clean.slice(0, c.clean.search(/[*?{]/)).replace(/\/[^/]*$/, '');
    if (litDir && /\*\*\/?$|\/\*\/?$/.test(c.clean) && gbases.some((b) => isDirRel(ctx, normalizeRel(posixJoin(b, litDir)) || ''))) return;
    // an unknown first folder and no extension: an ESLint rule namespace, a tag, a branch pattern, not a path
    const firstSeg = c.segs[0];
    const lastHasExt = /\.[A-Za-z0-9]+$/.test(c.last);
    const firstLiteral = !/[*?[{]/.test(firstSeg);
    if (!lastHasExt && firstLiteral && !gbases.some((b) => isDirRel(ctx, posixJoin(b, firstSeg) || firstSeg))) return;
    if (!lastHasExt && !firstLiteral && firstSeg !== '**') return; // "model-*/provider-*": a naming pattern
    // abbreviated glob ("store/pg/*.go" for internal/store/pg/*.go): try below every folder with that name
    if (firstLiteral && !gbases.some((b) => isDirRel(ctx, posixJoin(b, firstSeg) || firstSeg))) {
      const parents = [];
      for (const d of ctx.dirs) if (d.endsWith('/' + firstSeg)) { parents.push(posixDirname(d)); if (parents.length >= 20) break; }
      if (!parents.length) return; // the folder exists nowhere: cannot tell what it is relative to
      const budget0 = stats ? stats.budget : { left: GLOB_WORK_PER_FILE };
      if (parents.some((p) => globMatchesAny(ctx, c.clean, p, budget0))) return;
    }
    const globPath = c.clean.replace(/\/$/, '');
    if (looksIgnoredOrGenerated(ctx, globPath) || bases.some((b) => looksIgnoredOrGenerated(ctx, normalizeRel(posixJoin(b, globPath)) || ''))) return;
    const budget = stats ? stats.budget : { left: GLOB_WORK_PER_FILE };
    if (globMatchesAny(ctx, c.clean, '', budget) || gbases.some((b) => globMatchesAny(ctx, c.clean, b, budget))) return;
    emit(mkDiag('CD002', 'info', rel, range.line, range.col, range.endCol,
      `Glob "${c.path}" matches no files in the repo.`, { data: { kind: 'glob', glob: c.path } }));
    return;
  }

  const target = c.clean.replace(/\/+$/, '');
  // "../shared/x.ts" that climbs above the opened folder: it may exist outside (a monorepo package opened
  // on its own, the CLI run on a subfolder). It cannot be checked, so it is never reported.
  if (!c.rootRel && posixJoin(instrDir, target) === null) return;
  // a tool's own state or config folder (.nanocoder/, .senpi/settings.json, .scratchpad/): per user or per machine
  if (/^\.[\w-]+(?:\/|$)/.test(target) && !KNOWN_REPO_DOTDIRS.has(target.split('/')[0]) && (target.includes('/') || !c.ext)) return;
  const cands = [];
  if (c.rootRel) cands.push(normalizeRel(target));
  else {
    for (const b of bases) cands.push(normalizeRel(posixJoin(b, target)));
    if (!localOnly && (!isLink || !c.explicitRel)) for (const a of ancestors(instrDir).slice(1)) cands.push(normalizeRel(posixJoin(a, target)));
    // "./utils" in packages/x/AGENTS.md often means packages/x/src/utils
    if (!localOnly && !isLink) for (const a of ancestors(instrDir)) cands.push(normalizeRel(posixJoin(posixJoin(a, 'src') || 'src', target)));
  }
  const valid = cands.filter((x) => x !== null && x !== '');
  if (!valid.length) return; // escapes the root: cannot check
  // inside a git submodule: another repository at another version
  const subs = submodulePaths(ctx);
  if (subs.length && valid.some((x) => subs.some((sp) => x === sp || x.startsWith(sp + '/')))) return;
  for (const x of valid) {
    if (c.trailing ? isDirRel(ctx, x) : existsRel(ctx, x)) return;
  }
  // module-style paths without an extension: src/utils/format -> .ts/.js/... or an index file
  if (!c.trailing && !c.ext) for (const x of valid) if (existsAsModule(ctx, x)) return;
  for (const x of valid) if (looksIgnoredOrGenerated(ctx, x)) return;
  if (looksIgnoredOrGenerated(ctx, target)) return;
  // abbreviated path: any repo path ending with "/target"
  const suffix = '/' + target;
  const pool = c.trailing ? ctx.dirs : null;
  if (kind === 'bare') {
    if ((ctx.byBase.get(target) || []).length) return;
    if (ctx.dirs.has(target)) return;
    for (const d of ctx.dirs) if (d.endsWith(suffix)) return;
  } else {
    if (!c.explicitRel && !isLink && !localOnly) {
      for (const f of ctx.files) if (f.endsWith(suffix)) return;
      for (const d of (pool || ctx.dirs)) if (d.endsWith(suffix)) return;
      if (!c.ext && !c.trailing) for (const f of ctx.files) { const i = f.lastIndexOf('.'); if (i > 0 && f.slice(0, i).endsWith(suffix)) return; }
    }
  }
  // suggestion: same basename elsewhere
  let suggestion = null;
  const sameBase = (ctx.byBase.get(c.last) || []).filter((f) => !looksIgnoredOrGenerated(ctx, f));
  if (sameBase.length === 1 && !c.trailing) suggestion = sameBase[0];
  const fromDir = c.explicitRel || isLink ? (instrDir ? instrDir + '/' : '') : '';
  let fixText = null;
  if (suggestion && !localOnly) fixText = relativeFrom(fromDir ? instrDir : '', suggestion, c.explicitRel);
  const what = c.trailing ? 'Directory' : (kind === 'bare' ? 'File' : 'Path');
  const msg = `${what} "${c.path}" does not exist in the repo` + (fixText ? `. Did you mean "${fixText}"?` : '.');
  const d = mkDiag('CD002', 'warning', rel, range.line, range.col, range.endCol, msg, {
    data: { kind: 'path', path: c.path, resolved: valid[0], parent: nearestExistingParent(ctx, valid[0]), bare: kind === 'bare' || undefined },
  });
  if (fixText) d.fix = { title: `Replace with "${fixText}"`, line: range.line, column: range.col, endLine: range.line, endColumn: range.endCol, newText: fixText };
  emit(d);
}
function relativeFrom(fromDir, target, keepDot) {
  if (!fromDir) return (keepDot ? './' : '') + target;
  const a = fromDir.split('/'), b = target.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  const r = '../'.repeat(up) + b.slice(i).join('/');
  return up === 0 && keepDot ? './' + r : r;
}

/* ---------- CD001 / CD003 / CD005: commands ---------- */

function repoPackageManager(ctx, dir) {
  for (const d of ancestors(dir)) {
    const pkg = readPackage(ctx, d);
    const at = (n) => hasFile(ctx, d ? d + '/' + n : n);
    if (pkg && !pkg.invalid && typeof pkg.json.packageManager === 'string') {
      const name = pkg.json.packageManager.split('@')[0].trim().toLowerCase();
      if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return { pm: name, source: (pkg.rel) + ' "packageManager"' };
    }
    const kinds = new Map();
    if (at('package-lock.json')) kinds.set('npm', 'package-lock.json');
    else if (at('npm-shrinkwrap.json')) kinds.set('npm', 'npm-shrinkwrap.json');
    if (at('pnpm-lock.yaml')) kinds.set('pnpm', 'pnpm-lock.yaml');
    if (at('yarn.lock')) kinds.set('yarn', 'yarn.lock');
    if (at('bun.lock')) kinds.set('bun', 'bun.lock'); else if (at('bun.lockb')) kinds.set('bun', 'bun.lockb');
    if (kinds.size === 1) { const [pm, f] = [...kinds][0]; return { pm, source: d ? d + '/' + f : f }; }
    if (kinds.size > 1) return null; // ambiguous; do not guess
    if (pkg) {
      // a package without a lockfile: keep searching upward (workspace root)
    }
  }
  return null;
}

const VERB_SYNONYMS = { test: 'test', tests: 'test', build: 'build', lint: 'lint', format: 'format', fmt: 'format', dev: 'dev', typecheck: 'typecheck', 'type-check': 'typecheck', types: 'typecheck', tsc: 'typecheck' };
function addVerb(facts, verb, key, display, line, col, endCol) {
  if (!verb) return;
  // keyed by the directory the command runs in: `npm test` (web) and `cd api && pytest` do not conflict
  const k = verb + '\0' + (facts.dir || '');
  let arr = facts.verbs.get(k);
  if (!arr) facts.verbs.set(k, (arr = []));
  if (!arr.some((x) => x.key === key)) arr.push({ key, display, line, col, endCol });
}

function parseFlags(toks, i, valueFlags) {
  const flags = [];
  while (i < toks.length && toks[i].v.startsWith('-') && toks[i].v !== '--') {
    const f = toks[i].v;
    flags.push(f.split('=')[0]);
    i++;
    if (valueFlags.has(f) && i < toks.length) i++;
  }
  return { i, flags };
}

function checkCommand(ctx, rel, src, toks, dir, emit, facts, pmInfoInstr, hasCd) {
  let cmd = toks[0].v;
  // npx / pnpm dlx / bunx etc: only verb facts
  if (cmd === 'npx' || cmd === 'bunx' || cmd === 'pnpx') {
    let i = 1;
    while (i < toks.length && toks[i].v.startsWith('-')) i++;
    if (toks[i]) recordToolVerb(facts, toks.slice(i), src);
    return;
  }
  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn' || cmd === 'bun') return checkJsPm(ctx, rel, src, toks, dir, emit, facts, hasCd);
  if (cmd === 'make' || cmd === 'gmake') return checkMake(ctx, rel, src, toks, dir, emit, facts);
  if (cmd === 'just') return checkJust(ctx, rel, src, toks, dir, emit, facts);
  if (cmd === 'task' || cmd === 'go-task') return checkTask(ctx, rel, src, toks, dir, emit, facts);
  if (cmd === 'cargo') return checkCargo(ctx, rel, src, toks, dir, emit, facts);
  if (cmd === 'uv' || cmd === 'poetry' || cmd === 'pdm' || cmd === 'rye') return checkPyRun(ctx, rel, src, toks, dir, emit, facts);
  recordToolVerb(facts, toks, src);
}

function recordToolVerb(facts, toks, src) {
  const c = toks[0].v;
  const sub = toks[1] ? toks[1].v : '';
  const at = (verb, key) => addVerb(facts, verb, key, toks.map((t) => t.v).slice(0, 3).join(' '), src.line, toks[0].s, toks[Math.min(toks.length, 3) - 1].e);
  if (c === 'go') { if (sub === 'test') at('test', 'go:test'); else if (sub === 'build') at('build', 'go:build'); else if (sub === 'vet') at('lint', 'go:vet'); else if (sub === 'fmt') at('format', 'go:fmt'); return; }
  if (c === 'gofmt') return at('format', 'gofmt');
  if (c === 'golangci-lint') return at('lint', 'golangci-lint');
  if (c === 'pytest' || c === 'py.test') return at('test', 'pytest');
  if ((c === 'python' || c === 'python3') && sub === '-m' && toks[2]) {
    const mod = toks[2].v;
    if (mod === 'pytest') return at('test', 'pytest');
    if (mod === 'unittest') return at('test', 'unittest');
    if (mod === 'mypy') return at('typecheck', 'mypy');
    if (mod === 'black') return at('format', 'black');
    if (mod === 'ruff') return recordToolVerb(facts, toks.slice(2), src);
    return;
  }
  if (c === 'ruff') { if (sub === 'check') at('lint', 'ruff:check'); else if (sub === 'format') at('format', 'ruff:format'); return; }
  if (c === 'black') return at('format', 'black');
  if (c === 'mypy' || c === 'pyright') return at('typecheck', c);
  if (c === 'eslint' || c === 'oxlint' || c === 'flake8' || c === 'pylint') return at('lint', c);
  if (c === 'prettier') return at('format', 'prettier');
  if (c === 'biome') { if (sub === 'lint' || sub === 'check') at('lint', 'biome:' + sub); else if (sub === 'format') at('format', 'biome:format'); return; }
  if (c === 'vitest' || c === 'jest' || c === 'mocha' || c === 'ava') return at('test', c);
  if (c === 'tsc') return at('typecheck', 'tsc');
  if (c === 'node' && sub === '--test') return at('test', 'node:test');
  if (c === 'deno' && ['test', 'lint', 'fmt'].includes(sub)) return at(VERB_SYNONYMS[sub], 'deno:' + sub);
}

function checkJsPm(ctx, rel, src, toks, dir, emit, facts, hasCd) {
  const pm = toks[0].v;
  const valueFlags = pm === 'npm' ? NPM_VALUE_FLAGS : pm === 'pnpm' ? PNPM_VALUE_FLAGS : pm === 'yarn' ? YARN_VALUE_FLAGS : BUN_VALUE_FLAGS;
  let { i, flags } = parseFlags(toks, 1, valueFlags);
  let anyPkg = flags.some((f) => ANY_PKG_FLAGS.has(f));
  const global = flags.includes('-g') || flags.includes('--global');
  const subTok = toks[i];
  const sub = subTok ? subTok.v : '';
  let scriptTok = null;
  let strict = false;
  let form = 'other';
  if (pm === 'yarn' && (sub === 'workspace')) {
    // yarn workspace <name> <script>
    const after = parseFlags(toks, i + 2, valueFlags);
    scriptTok = toks[after.i];
    anyPkg = true;
    form = 'bare';
    if (scriptTok && (YARN_BUILTINS.has(scriptTok.v) && !['run', 'test', 'start'].includes(scriptTok.v))) scriptTok = null;
    if (scriptTok && scriptTok.v === 'run') { scriptTok = toks[after.i + 1]; }
  } else if (pm === 'yarn' && sub === 'workspaces') {
    const t2 = toks[i + 1];
    if (t2 && t2.v === 'run') { scriptTok = toks[i + 2]; anyPkg = true; form = 'run'; }
  } else if ((pm === 'npm' && NPM_RUN.has(sub)) || (pm !== 'npm' && sub === 'run')) {
    const after = parseFlags(toks, i + 1, valueFlags);
    if (after.flags.includes('--if-present')) return;
    if (after.flags.some((f) => ANY_PKG_FLAGS.has(f))) anyPkg = true;
    scriptTok = toks[after.i];
    strict = pm === 'npm' || pm === 'pnpm';
    form = 'run';
    // flags after the script name for npm workspaces
    if (scriptTok) for (const t of toks.slice(after.i + 1)) { if (t.v === '--') break; if (ANY_PKG_FLAGS.has(t.v.split('=')[0])) anyPkg = true; if (t.v === '--if-present') return; }
    if (pm === 'bun' && scriptTok && /[./]/.test(scriptTok.v)) scriptTok = null; // bun run file.ts
  } else if (['test', 't', 'tst'].includes(sub) && pm !== 'bun') {
    if (pm === 'yarn' && sub !== 'test') return;
    scriptTok = { v: 'test', s: subTok.s, e: subTok.e };
    strict = true;
    form = 'lifecycle';
    for (const t of toks.slice(i + 1)) { if (t.v === '--') break; if (ANY_PKG_FLAGS.has(t.v.split('=')[0])) anyPkg = true; }
  } else if (sub === 'start' && pm !== 'bun') {
    scriptTok = subTok;
    strict = true;
    form = 'lifecycle';
  } else if (pm !== 'npm' && sub && !sub.startsWith('-')) {
    const builtins = pm === 'pnpm' ? PNPM_BUILTINS : pm === 'yarn' ? YARN_BUILTINS : BUN_BUILTINS;
    if (!builtins.has(sub)) {
      if (pm === 'bun' && /[./]/.test(sub)) scriptTok = null;
      else { scriptTok = subTok; form = 'bare'; }
    }
  }

  // CD003: package-manager drift
  const pmInfo = memo(ctx, 'pm:' + dir, () => repoPackageManager(ctx, dir));
  if (pmInfo && pmInfo.pm !== pm && !global) {
    const projectSub = pm === 'yarn' && !sub ? 'install' : sub;
    const PROJECT = new Set(['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'un', 'run', 'run-script', 'test', 't', 'start', 'update', 'up', 'upgrade', 'exec', 'workspace', 'workspaces', 'dedupe', 'link']);
    const isProject = PROJECT.has(projectSub) || form === 'bare';
    // `npm install <this package>` tells consumers how to install what the repo publishes
    const args = toks.slice(i + 1).filter((t) => !t.v.startsWith('-')).map((t) => t.v.replace(/@[^@/]*$/, ''));
    const ownNames = new Set(allPackages(ctx).filter((p) => !p.invalid && typeof p.json.name === 'string').map((p) => p.json.name));
    const consumerInstall = ['install', 'i', 'add'].includes(projectSub) && args.length > 0 && args.every((a) => ownNames.has(a));
    if (isProject && !consumerInstall && !(projectSub === 'link' && global)) {
      const d = mkDiag('CD003', 'warning', rel, src.line, toks[0].s, toks[0].e,
        `\`${pm}\` is used here, but the repo uses ${pmInfo.pm} (${pmInfo.source}).`, { data: { kind: 'pm', expected: pmInfo.pm, used: pm } });
      const hasPkgArgs = toks.slice(i + 1).some((t) => !t.v.startsWith('-'));
      let newText = null;
      if (form === 'run' || form === 'lifecycle') newText = pmInfo.pm;
      else if (form === 'bare') newText = pmInfo.pm === 'npm' ? 'npm run' : pmInfo.pm;
      else if ((projectSub === 'install' || projectSub === 'i') && !hasPkgArgs) newText = pmInfo.pm;
      if (newText) d.fix = { title: `Replace \`${pm}\` with \`${newText}\``, line: src.line, column: toks[0].s, endLine: src.line, endColumn: toks[0].e, newText };
      emit(d);
    }
  }

  if (!scriptTok || global) return;
  const script = scriptTok.v;
  if (!isLiteralName(script) || script.includes('/')) return; // "yarn install/build/lint" is a list, not a script
  const verb = VERB_SYNONYMS[script];
  addVerb(facts, verb, 'script:' + script, `${pm} ${form === 'run' ? 'run ' : ''}${script}`, src.line, toks[0].s, scriptTok.e);

  let pkgs = anyPkg ? allPackages(ctx) : pickPackages(ctx, dir);
  let fallbackAll = false;
  if (!pkgs.length) { pkgs = allPackages(ctx); fallbackAll = true; }
  if (!pkgs.length) return; // no package.json anywhere: nothing to verify against
  if (pkgs.some((p) => p.invalid)) return;
  if (pkgs.some((p) => Object.prototype.hasOwnProperty.call(p.scripts, script))) return;
  if (script === 'start' && pkgs.some((p) => hasFile(ctx, p.dir ? p.dir + '/server.js' : 'server.js'))) return;
  if (!strict || form !== 'run') {
    if (KNOWN_JS_BINS.has(script) || allDeps(ctx).has(script)) return;
    if (!script.includes(':') && binFromDependency(ctx, dir, script)) return; // binaries never contain ':'
  }
  if (!anyPkg && !fallbackAll) {
    const elsewhere = allPackages(ctx).filter((p) => !p.invalid && Object.prototype.hasOwnProperty.call(p.scripts, script));
    if (elsewhere.length) return; // defined in another workspace package: docs often mean "run it there"
  }
  // a workspace opened at a subfolder: the root package.json may sit above it, up to the git root
  if (outsideAncestorPackages(ctx).some((sc) => sc.has(script))) return;
  // error only for `npm run X` / `pnpm run X` checked against the nearest package.json; everything else is heuristic
  const hard = strict && form === 'run' && !anyPkg && !fallbackAll;
  const names = new Set();
  for (const p of pkgs) for (const k of Object.keys(p.scripts)) names.add(k);
  const sugg = closest(script, names);
  const where = pkgs.map((p) => p.rel).slice(0, 3).join(', ');
  const d = mkDiag('CD001', hard ? 'error' : 'warning', rel, src.line, scriptTok.s, scriptTok.e,
    `Script "${script}" is not defined in ${where}` + (sugg ? `. Did you mean "${sugg}"?` : names.size ? `. Available: ${[...names].slice(0, 8).join(', ')}${names.size > 8 ? ', …' : ''}.` : ' (it has no scripts).'),
    { data: { kind: 'script', manifest: pkgs[0].rel, script, anyPkg: anyPkg || fallbackAll } });
  if (sugg && form !== 'lifecycle') d.fix = { title: `Replace with "${sugg}"`, line: src.line, column: scriptTok.s, endLine: src.line, endColumn: scriptTok.e, newText: sugg };
  emit(d);
}

/** Scripts of package.json files above the workspace root, up to the git root (names only; never echoed). */
function outsideAncestorPackages(ctx) {
  return memo(ctx, 'outsidepkgs', () => {
    const out = [];
    if (!ctx.gitRoot) return out;
    const top = path.resolve(ctx.gitRoot);
    let d = path.resolve(ctx.root);
    for (let k = 0; k < 16 && d !== top; k++) {
      const p = path.dirname(d);
      if (p === d) break;
      d = p;
      try {
        const abs = path.join(d, 'package.json');
        const st = fs.statSync(abs);
        if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) continue;
        const j = JSON.parse(fs.readFileSync(abs, 'utf8'));
        if (j && j.scripts && typeof j.scripts === 'object') out.push(new Set(Object.keys(j.scripts)));
      } catch (_) { /* none or invalid */ }
    }
    return out;
  });
}

/** `yarn vue-cli-service`: a binary whose name differs from its package (@vue/cli-service), or one in node_modules/.bin. */
function binFromDependency(ctx, dir, name) {
  const flat = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const n = flat(name);
  for (const d of allDeps(ctx)) {
    const f = flat(d);
    if (f === n || (f.length >= 6 && n.startsWith(f)) || (n.length >= 6 && f.startsWith(n))) return true;
  }
  for (const a of ancestors(dir)) {
    const binRel = (a ? a + '/' : '') + 'node_modules/.bin/' + name;
    try { fs.statSync(path.join(ctx.root, binRel)); return true; } catch (_) { /* no */ }
  }
  return false;
}

const MAKE_VALUE_FLAGS = new Set(['-C', '--directory', '-f', '--file', '--makefile', '-I', '--include-dir', '-o', '--old-file', '-W', '--what-if', '--assume-new', '-l', '--load-average', '-O', '--output-sync', '--eval']);

/** At most this many targets of one `make` command are checked. */
const MAX_MAKE_TARGETS = 32;

function checkMake(ctx, rel, src, toks, dir, emit, facts) {
  let mdir = dir;
  let mfile = null;
  const targets = [];
  for (let i = 1; i < toks.length; i++) {
    const v = toks[i].v;
    // "make test    Run the tests" / "make dev - start": a listing, the rest is a description
    if (i > 1 && toks[i].s - toks[i - 1].e >= 2) break;
    if (v === '-' || v === '—' || v === '–' || v === '#' || v === '|') break;
    if (targets.length && /^[A-Z][a-z]/.test(v)) break;
    if (v === '-C' || v === '--directory') { const d = toks[++i]; if (!d) return; const n = normalizeRel(posixJoin(dir, d.v)); if (n === null || !isLiteralPath(d.v)) return; mdir = isDirRel(ctx, n) ? n : normalizeRel(d.v); if (mdir === null || !isDirRel(ctx, mdir)) return; continue; }
    if (/^-C./.test(v)) { const n = normalizeRel(posixJoin(dir, v.slice(2))); if (n === null || !isDirRel(ctx, n)) return; mdir = n; continue; }
    if (v === '-f' || v === '--file' || v === '--makefile') { const f = toks[++i]; if (!f) return; mfile = f.v; continue; }
    if (v.startsWith('--directory=')) { const n = normalizeRel(posixJoin(dir, v.slice(12))); if (n === null || !isDirRel(ctx, n)) return; mdir = n; continue; }
    if (v.startsWith('--file=') || v.startsWith('--makefile=')) { mfile = v.split('=')[1]; continue; }
    if (v.startsWith('-')) { if (MAKE_VALUE_FLAGS.has(v)) i++; else if (v === '-j' && toks[i + 1] && /^\d+$/.test(toks[i + 1].v)) i++; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) continue;
    targets.push(toks[i]);
    if (targets.length >= MAX_MAKE_TARGETS) break; // nobody types more; a generated wall of names is not worth the CPU
  }
  if (!targets.length) return;
  let makefiles = [];
  if (mfile) {
    if (!isLiteralPath(mfile)) return;
    const f = normalizeRel(posixJoin(mdir, mfile));
    if (f === null) return;
    if (!hasFile(ctx, f)) {
      emit(mkDiag('CD001', 'warning', rel, src.line, toks[0].s, toks[toks.length - 1].e, `\`make -f ${mfile}\`: ${f} does not exist.`, { data: { kind: 'make', manifest: null } }));
      return;
    }
    makefiles = [f];
  } else {
    const near = ancestors(mdir).map((d) => makefileIn(ctx, d)).find(Boolean);
    const rootMk = makefileIn(ctx, '');
    if (dir === mdir) { if (near) makefiles.push(near); if (rootMk && !makefiles.includes(rootMk)) makefiles.push(rootMk); }
    else { const m = makefileIn(ctx, mdir); if (m) makefiles.push(m); }
  }
  for (const t of targets) {
    if (!isLiteralName(t.v)) continue;
    addVerb(facts, VERB_SYNONYMS[t.v], 'make:' + t.v, 'make ' + t.v, src.line, toks[0].s, t.e);
  }
  if (!makefiles.length) {
    const any = filesNamed(ctx, ...MAKEFILE_NAMES);
    const generated = filesNamed(ctx, 'configure', 'configure.ac', 'Makefile.am', 'Makefile.in', 'CMakeLists.txt', 'meson.build', 'Makefile.PL', 'premake5.lua').length > 0;
    if (generated) return;
    if (any.length) {
      return; // Makefiles exist only in subdirectories: we cannot tell which one is meant

    }
    const otherRunner = filesNamed(ctx, ...JUSTFILE_NAMES, ...TASKFILE_NAMES, 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod').length > 0;
    if (!otherRunner) return;
    const t = targets[0];
    emit(mkDiag('CD001', 'warning', rel, src.line, toks[0].s, t.e, `\`make ${t.v}\`: the repo has no Makefile.`, { data: { kind: 'make', manifest: null } }));
    return;
  }
  const parsed = makefiles.map((f) => parseMakefile(ctx, f, 0));
  if (parsed.some((p) => p.uncertain)) return;
  for (const t of targets) {
    if (!isLiteralName(t.v)) continue;
    if (parsed.some((p) => p.targets.has(t.v))) continue;
    // implicit rules: "make foo" with foo.c, or an existing file
    if (existsRel(ctx, posixJoin(mdir, t.v) || t.v)) continue;
    if (['c', 'cc', 'cpp', 'f', 'p', 's', 'y', 'l', 'go'].some((e) => hasFile(ctx, posixJoin(mdir, t.v + '.' + e) || ''))) continue;
    // defined in a Makefile further down (docs/Makefile for "make html"): the text may mean "run it there"
    if (subMakefilesDefine(ctx, mdir, t.v)) continue;
    const all = new Set(); for (const p of parsed) for (const x of p.targets) all.add(x);
    const sugg = closest(t.v, all);
    // error only when the Makefile is in the folder make runs in; a Makefile found further up is a guess
    const hard = posixDirname(makefiles[0]) === mdir;
    const d = mkDiag('CD001', hard ? 'error' : 'warning', rel, src.line, t.s, t.e,
      `\`make ${t.v}\`: no target "${t.v}" in ${makefiles.join(', ')}` + (sugg ? `. Did you mean "${sugg}"?` : '.'), { data: { kind: 'make', manifest: makefiles[0], target: t.v } });
    if (sugg) d.fix = { title: `Replace with "${sugg}"`, line: src.line, column: t.s, endLine: src.line, endColumn: t.e, newText: sugg };
    emit(d);
  }
}

function subMakefilesDefine(ctx, dir, target) {
  let n = 0;
  for (const f of filesNamed(ctx, ...MAKEFILE_NAMES)) {
    if (dir && !f.startsWith(dir + '/')) continue;
    if (posixDirname(f) === dir) continue;
    if (++n > 50) return false;
    const p = parseMakefile(ctx, f, 0);
    if (p.targets.has(target) || p.uncertain) return true;
  }
  return false;
}

function checkJust(ctx, rel, src, toks, dir, emit, facts) {
  let i = 1;
  let jfile = null;
  let jdir = dir;
  while (i < toks.length && toks[i].v.startsWith('-')) {
    const v = toks[i].v;
    if (v === '-f' || v === '--justfile') { jfile = toks[i + 1] && toks[i + 1].v; i += 2; continue; }
    if (v === '-d' || v === '--working-directory' || v === '--set') { i += 2; continue; }
    if (v === '--list' || v === '-l' || v === '--summary' || v === '--evaluate' || v === '--choose' || v === '--show' || v === '-s' || v === '--dump' || v === '--fmt' || v === '--init' || v === '--edit' || v === '-e' || v === '--help' || v === '--version') return;
    i++;
  }
  const t = toks[i];
  if (!t || !isLiteralName(t.v) || /::|\//.test(t.v) || /^[A-Za-z_][\w-]*=/.test(t.v)) return;
  if (i > 1 && t.s - toks[i - 1].e >= 2) return;
  addVerb(facts, VERB_SYNONYMS[t.v], 'just:' + t.v, 'just ' + t.v, src.line, toks[0].s, t.e);
  let files = [];
  if (jfile) {
    if (!isLiteralPath(jfile)) return;
    const f = normalizeRel(posixJoin(dir, jfile));
    if (f === null || !hasFile(ctx, f)) return;
    files = [f];
  } else {
    const near = ancestors(jdir).map((d) => justfileIn(ctx, d)).find(Boolean);
    const rootJ = justfileIn(ctx, '');
    if (near) files.push(near);
    if (rootJ && !files.includes(rootJ)) files.push(rootJ);
  }
  if (!files.length) {
    if (filesNamed(ctx, ...JUSTFILE_NAMES).length) return; // some other justfile; ambiguous
    const otherRunner = filesNamed(ctx, ...MAKEFILE_NAMES, ...TASKFILE_NAMES, 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod').length > 0;
    if (!otherRunner) return;
    emit(mkDiag('CD001', 'warning', rel, src.line, toks[0].s, t.e, `\`just ${t.v}\`: the repo has no justfile.`, { data: { kind: 'just', manifest: null } }));
    return;
  }
  const parsed = files.map((f) => parseJustfile(ctx, f, 0));
  if (parsed.some((p) => p.uncertain)) return;
  if (parsed.some((p) => p.recipes.has(t.v) || p.modules.has(t.v))) return;
  const all = new Set(); for (const p of parsed) for (const x of p.recipes) all.add(x);
  const sugg = closest(t.v, all);
  const d = mkDiag('CD001', 'warning', rel, src.line, t.s, t.e, `\`just ${t.v}\`: no recipe "${t.v}" in ${files.join(', ')}` + (sugg ? `. Did you mean "${sugg}"?` : '.'), { data: { kind: 'just', manifest: files[0], target: t.v } });
  if (sugg) d.fix = { title: `Replace with "${sugg}"`, line: src.line, column: t.s, endLine: src.line, endColumn: t.e, newText: sugg };
  emit(d);
}

function checkTask(ctx, rel, src, toks, dir, emit, facts) {
  let i = 1;
  while (i < toks.length && toks[i].v.startsWith('-')) {
    const v = toks[i].v;
    if (['--list', '-l', '--list-all', '-a', '--init', '-i', '--help', '-h', '--version', '--summary'].includes(v)) return;
    if (['-d', '--dir', '-t', '--taskfile', '-o', '--output', '-c', '--concurrency', '-I', '--interval'].includes(v)) i++;
    i++;
  }
  const t = toks[i];
  if (!t || !isLiteralName(t.v) || /=/.test(t.v)) return;
  const near = ancestors(dir).map((d) => taskfileIn(ctx, d)).find(Boolean);
  if (!near) return;
  addVerb(facts, VERB_SYNONYMS[t.v], 'task:' + t.v, 'task ' + t.v, src.line, toks[0].s, t.e);
  const p = parseTaskfile(ctx, near);
  if (p.uncertain && t.v.includes(':')) return;
  if (p.tasks.has(t.v) || p.patterns.some((g) => globMatch(g, t.v.replace(/:/g, '/')))) return;
  if (p.uncertain) return;
  const sugg = closest(t.v, p.tasks);
  emit(mkDiag('CD001', 'warning', rel, src.line, t.s, t.e, `\`task ${t.v}\`: no task "${t.v}" in ${near}` + (sugg ? `. Did you mean "${sugg}"?` : '.'), { data: { kind: 'task', manifest: near, target: t.v } }));
}

function checkCargo(ctx, rel, src, toks, dir, emit, facts) {
  let i = 1;
  while (i < toks.length && toks[i].v.startsWith('-')) i++;
  if (toks[i] && toks[i].v.startsWith('+')) { i++; while (i < toks.length && toks[i].v.startsWith('-')) i++; }
  const sub = toks[i];
  if (!sub) return;
  const facts2 = cargoFacts(ctx);
  if (!facts2.manifests.length) return;
  const s = sub.v;
  const vmap = { test: 'test', t: 'test', build: 'build', b: 'build', fmt: 'format', clippy: 'lint', nextest: 'test' };
  if (vmap[s]) addVerb(facts, vmap[s], 'cargo:' + (s === 't' ? 'test' : s === 'b' ? 'build' : s), 'cargo ' + s, src.line, toks[0].s, sub.e);
  if (!CARGO_BUILTINS.has(s) && !facts2.aliases.has(s) && isLiteralName(s) && /^[a-z][\w-]*$/.test(s)) {
    if (facts2.hasAliasTable || s === 'xtask') {
      emit(mkDiag('CD001', 'warning', rel, src.line, sub.s, sub.e,
        `\`cargo ${s}\`: not a built-in command and not an alias in .cargo/config.toml` + (facts2.aliases.size ? ` (aliases: ${[...facts2.aliases].join(', ')})` : '') + '. If it is an installed plugin (cargo-' + s + '), ignore this.', { data: { kind: 'cargo-alias' } }));
    }
    return;
  }
  // -p / --package and --bin
  for (let j = i + 1; j < toks.length; j++) {
    const v = toks[j].v;
    if (v === '--') break;
    let name = null, tok = null, what = null;
    if ((v === '-p' || v === '--package') && toks[j + 1]) { tok = toks[j + 1]; name = tok.v; what = 'package'; j++; }
    else if (v.startsWith('--package=')) { tok = toks[j]; name = v.slice(10); what = 'package'; }
    else if (v.startsWith('-p') && v.length > 2 && !v.startsWith('--')) { tok = toks[j]; name = v.slice(2); what = 'package'; }
    else if (v === '--bin' && toks[j + 1]) { tok = toks[j + 1]; name = tok.v; what = 'bin'; j++; }
    if (!name || !isLiteralName(name) || /[*?]/.test(name)) continue;
    name = name.replace(/@.*$/, '');
    if (what === 'package' && facts2.packages.size && !facts2.packages.has(name)) {
      const sugg = closest(name, facts2.packages);
      emit(mkDiag('CD001', 'warning', rel, src.line, tok.s, tok.e, `\`cargo ${s} -p ${name}\`: no crate named "${name}" in the workspace` + (sugg ? `. Did you mean "${sugg}"?` : '.'), { data: { kind: 'cargo-package' } }));
    }
    if (what === 'bin' && facts2.bins.size && !facts2.bins.has(name)) {
      emit(mkDiag('CD001', 'warning', rel, src.line, tok.s, tok.e, `\`cargo ${s} --bin ${name}\`: no binary target "${name}".`, { data: { kind: 'cargo-bin' } }));
    }
  }
}

const UV_VALUE_FLAGS = new Set(['--with', '--with-editable', '--with-requirements', '--extra', '--group', '--only-group', '--no-group', '--package', '--project', '--directory', '--python', '-p', '--env-file', '--index', '--index-url', '--extra-index-url', '--isolated-not', '-C', '--config-setting', '--script-not']);

/** Python distributions whose console scripts have other names. */
const PY_BIN_ALIASES = {
  'pip-tools': ['pip-compile', 'pip-sync'], 'jupyterlab': ['jupyter-lab', 'jupyter'], 'notebook': ['jupyter-notebook', 'jupyter'],
  'django': ['django-admin'], 'sphinx': ['sphinx-build', 'sphinx-apidoc', 'sphinx-quickstart'], 'mkdocs-material': ['mkdocs'],
  'python-semantic-release': ['semantic-release'], 'build': ['pyproject-build'], 'jupyter-core': ['jupyter'],
  'nbconvert': ['jupyter-nbconvert'], 'datamodel-code-generator': ['datamodel-codegen'], 'langgraph-cli': ['langgraph'],
  'huggingface-hub': ['huggingface-cli', 'hf'], 'grpcio-tools': ['python-grpc-tools-protoc'], 'setuptools': ['easy_install'],
};

function checkPyRun(ctx, rel, src, toks, dir, emit, facts) {
  const tool = toks[0].v;
  let i = 1;
  while (i < toks.length && toks[i].v.startsWith('-')) { if (UV_VALUE_FLAGS.has(toks[i].v)) i++; i++; }
  if (!toks[i] || toks[i].v !== 'run') return;
  i++;
  while (i < toks.length && toks[i].v.startsWith('-')) {
    const v = toks[i].v;
    if (v === '-m' || v === '--module' || v === '--script' || v === '-s') return;
    if (v === '--') { i++; break; }
    if (UV_VALUE_FLAGS.has(v)) i++;
    i++;
  }
  const t = toks[i];
  if (!t) return;
  recordToolVerb(facts, toks.slice(i), src);
  const x = t.v;
  if (!isLiteralName(x) || /[./\\]/.test(x)) return;
  const py = pythonFacts(ctx);
  if (!py.pyprojects.length) return;
  if (tool === 'pdm' || tool === 'rye') {
    if (py.scripts.has(x)) return;
  }
  if (py.scripts.has(x) || PY_KNOWN_BINS.has(x) || py.deps.has(normPyName(x))) return;
  // binaries frequently named differently from their distribution
  for (const d of py.deps) if (x.startsWith(d) || d.startsWith(normPyName(x))) return;
  for (const d of py.deps) if ((PY_BIN_ALIASES[d] || []).includes(x)) return;
  for (const v of ['.venv/bin/', 'venv/bin/', '.venv/Scripts/']) { try { fs.statSync(path.join(ctx.root, v + x)); return; } catch (_) { /* no */ } }
  emit(mkDiag('CD001', 'warning', rel, src.line, t.s, t.e,
    `\`${tool} run ${x}\`: "${x}" is not a script in pyproject.toml ([project.scripts]/[tool.poetry.scripts]) and not a declared dependency.`, { data: { kind: 'py-script', manifest: py.pyprojects[0] } }));
}

/* ------------------------------------------------------------------ */
/* Workspace analysis                                                  */
/* ------------------------------------------------------------------ */

function findInstructionFiles(ctx) {
  return ctx.files.filter((f) => classifyInstructionFile(f));
}

/* ---------- git (async only; never on a synchronous path) ---------- */

const GIT_TIMEOUT_MS = 3000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Runs read-only git with a hard timeout. Resolves to stdout, or null on any error or timeout.
 * The promise settles on the timer even if git is stuck in I/O; the process group is killed.
 */
function runGit(cwd, args, opts) {
  opts = opts || {};
  const timeout = opts.timeout || GIT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child;
    let done = false;
    const chunks = [];
    let size = 0;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const kill = () => {
      if (!child || child.exitCode !== null) return;
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (_e) { /* gone */ } }
    };
    const timer = setTimeout(() => { kill(); finish(null); }, timeout);
    try {
      child = cp.spawn('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'core.quotePath=false', ...args], {
        cwd, stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'ignore'], windowsHide: true,
        detached: process.platform !== 'win32',
        env: Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C' }),
      });
    } catch (_) { finish(null); return; }
    child.on('error', () => finish(null));
    child.stdout.on('data', (d) => { size += d.length; if (size > GIT_MAX_BUFFER) { kill(); finish(null); return; } chunks.push(d); });
    child.on('close', (code) => finish(code === 0 || (opts.okCodes || []).includes(code) ? Buffer.concat(chunks).toString('utf8') : null));
    if (opts.input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(opts.input); }
  });
}

async function gitStaleness(ctx, rels) {
  const opts = ctx.options;
  const out = new Map();
  if (!rels.length || !ctx.gitRoot) return out;
  const log = await runGit(ctx.root, ['log', '--no-renames', '--format=#%ct', '--name-only', '--relative', '--', ...rels]);
  if (log === null) return out;
  let ct = 0;
  for (const line of log.split('\n')) {
    if (line.startsWith('#')) { ct = Number(line.slice(1)); continue; }
    const f = line.trim();
    if (f && !out.has(f)) out.set(f, { ct, since: null });
  }
  const now = Math.floor((opts.now || Date.now()) / 1000);
  const staleSec = (opts.staleDays || 180) * 86400;
  let times = null;
  for (const [, info] of out) {
    if (now - info.ct < staleSec) continue;
    if (!times) {
      const t = await runGit(ctx.root, ['log', '--format=%ct', 'HEAD']);
      if (t === null) return new Map();
      times = t.split('\n').filter(Boolean).map(Number);
    }
    let n = 0;
    for (const t of times) if (t > info.ct) n++;
    info.since = n;
  }
  return out;
}

/**
 * Drops CD002 path findings that git says are ignored (`git check-ignore`) or tracked but not on
 * disk (`git ls-files`: sparse or skip-worktree entries). Paths are relative to ctx.root.
 */
async function gitPathFilter(ctx, diags) {
  const cand = diags.filter((d) => d.ruleId === 'CD002' && d.data && (d.data.resolved || d.data.glob));
  if (!cand.length || !ctx.gitRoot) return diags.filter((d) => !(d.data && d.data.sparse));
  const paths = [...new Set(cand.map((d) => d.data.resolved || d.data.glob).filter(Boolean))].slice(0, 500);
  const [ign, tracked] = await Promise.all([
    runGit(ctx.root, ['check-ignore', '--no-index', '--stdin', '-z'], { input: paths.join('\0') + '\0', okCodes: [1] }),
    runGit(ctx.root, ['ls-files', '-z', '--full-name', '--', ...paths.filter((x) => !isGlob(x)).map((x) => ':(literal)' + x),
      ...cand.filter((d) => d.data.bare && /^[\w.@+-]+$/.test(d.data.path || '')).map((d) => ':(glob)**/' + d.data.path)]),
  ]);
  const drop = new Set();
  if (ign) for (const x of ign.split('\0')) if (x) drop.add(x);
  if (tracked) {
    const prefix = ctx.gitRoot ? toPosix(path.relative(ctx.gitRoot, ctx.root)) : '';
    for (const x of tracked.split('\0')) {
      if (!x) continue;
      const local = prefix && x.startsWith(prefix + '/') ? x.slice(prefix.length + 1) : x;
      drop.add(local);
      drop.add('bare:' + local.slice(local.lastIndexOf('/') + 1));
      for (let d = posixDirname(local); d; d = posixDirname(d)) drop.add(d);
    }
  }
  const lsFailed = tracked === null;
  return diags.filter((d) => {
    if (d.ruleId !== 'CD002' || !d.data) return true;
    if (drop.has(d.data.resolved || d.data.glob)) return false;
    if (d.data.bare && drop.has('bare:' + d.data.path)) return false; // the file exists in a folder the walk skips (vendor/, a sparse cone)
    if (d.data.sparse && (lsFailed || d.data.kind === 'glob' || !d.data.resolved || d.data.bare)) return false; // cannot tell in a sparse checkout
    return true;
  });
}

const MANIFEST_NAMES = ['package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'deno.json', 'deno.jsonc', 'mix.exs', 'pubspec.yaml', 'CMakeLists.txt', 'Package.swift', 'Makefile', 'makefile', 'GNUmakefile', 'justfile', 'Justfile', 'Taskfile.yml', 'Taskfile.yaml', 'flake.nix', 'BUILD.bazel', 'WORKSPACE', 'meson.build', 'Dockerfile'];

/**
 * No manifest anywhere, and the folder is not a git repository root (no git at all, or only an unrelated
 * repository further up): a folder that holds a copied instruction file, not a project.
 */
function looksLikeCopiedFolder(ctx) {
  return memo(ctx, 'copied', () => (!ctx.gitRoot || path.resolve(ctx.gitRoot) !== path.resolve(ctx.root)) &&
    !MANIFEST_NAMES.some((n) => (ctx.byBase.get(n) || []).length) && !ctx.files.some((f) => /\.csproj$|\.sln$/.test(f)));
}

/**
 * Analyze a workspace root synchronously. Never runs git.
 * options: { overrides: Map<absPath, text>, ignoreRules: string[], context, debug }
 * Returns { root, files: [rel], skipped: [{file, reason}], diagnostics: [...], elapsedMs, context }
 */
function analyzeWorkspace(root, options) {
  const t0 = Date.now();
  options = options || {};
  const ctx = options.context || createContext(root, options);
  ctx.options = Object.assign({}, ctx.options, options, { context: undefined });
  const ignore = new Set((options.ignoreRules || []).map((x) => String(x).toUpperCase()));
  const overrides = options.overrides || new Map();
  const candidates = findInstructionFiles(ctx);
  for (const abs of overrides.keys()) {
    const r = toPosix(path.relative(ctx.root, abs));
    if (!r.startsWith('..') && !path.isAbsolute(r) && classifyInstructionFile(r) && !candidates.includes(r)) candidates.push(r);
  }
  candidates.sort();
  const results = [];
  const files = [];
  const skipped = [];
  let diags = [];
  const copied = looksLikeCopiedFolder(ctx);
  // A run stops checking after this many ms and returns what it has (the extension kills a worker run at 30 s).
  const budgetMs = options.budgetMs === undefined ? DEFAULT_BUDGET_MS : options.budgetMs;
  const deadline = options.deadline !== undefined ? options.deadline : budgetMs > 0 ? t0 + budgetMs : Infinity;
  for (const rel of candidates) {
    const abs = path.join(ctx.root, rel);
    if (Date.now() > deadline) { skipped.push({ file: rel, absFile: abs, reason: 'not checked: the run used up its time budget' }); continue; }
    let text = overrides.get(abs);
    if (text === undefined) text = readFresh(ctx, abs);
    if (text === null || text === undefined) continue;
    if (typeof text === 'object') { skipped.push({ file: rel, absFile: abs, reason: text.skipped }); continue; }
    if (text.length > MAX_INSTRUCTION_BYTES) { skipped.push({ file: rel, absFile: abs, reason: 'larger than 1 MB' }); continue; }
    let r;
    try { r = analyzeText(ctx, rel, text, { deadline }); } catch (e) { r = { diagnostics: [], facts: { verbs: new Map() } }; if (options.debug) throw e; }
    files.push(rel);
    results.push({ rel, facts: r.facts, text });
    let ds = r.diagnostics;
    const ps = r.facts.paths;
    if (copied && ps && ps.missing >= 3 && ps.missing * 2 >= ps.checked) {
      // most referenced paths are missing and there is no git and no manifest: a copy, not a project root
      ds = ds.filter((d) => d.ruleId !== 'CD002');
      ds.push(mkDiag('CD002', 'info', rel, 0, 0, Math.max(1, (splitLines(text)[0] || '').length),
        `Not a project root: this folder is not a git repository root and has no manifest (package.json, pyproject.toml, go.mod, ...), and ${ps.missing} of ${ps.checked} referenced paths are missing. It looks like a copy of an instruction file, so path checks were skipped.`,
        { data: { kind: 'not-project-root' } }));
    }
    if (r.facts.timedOut) skipped.push({ file: rel, absFile: abs, reason: 'only partly checked: the run used up its time budget', partial: true });
    if (r.facts.spansCapped) skipped.push({ file: rel, absFile: abs, reason: `more than ${MAX_SPANS_PER_FILE} code spans or links; the rest were not checked`, partial: true });
    if (r.facts.longLines) skipped.push({ file: rel, absFile: abs, reason: `${r.facts.longLines} line(s) longer than ${MAX_LINE_CHARS} characters were not checked`, partial: true });
    diags = diags.concat(ds);
  }
  // sparse checkout without git to ask: drop path findings (precision over recall)
  if (ctx.sparse && !options._keepSparse) diags = diags.filter((d) => !(d.data && d.data.sparse));
  // CD005 cross-file conflicts
  if (!ignore.has('CD005')) diags = diags.concat(crossFileConflicts(results));
  diags = diags.filter((d) => !ignore.has(d.ruleId));
  for (const d of diags) d.absFile = path.join(ctx.root, d.file);
  sortDiags(diags);
  return { root: ctx.root, files, skipped, diagnostics: diags, elapsedMs: Date.now() - t0, context: ctx, _results: results };
}

function sortDiags(diags) {
  diags.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column || (a.ruleId < b.ruleId ? -1 : 1)));
}

/**
 * Same as analyzeWorkspace, plus the git-backed parts, all asynchronous with a 3 s timeout per git call:
 * CD006 (only with options.stale) and dropping CD002 paths that git reports as ignored or tracked.
 * options.git === false turns every git call off.
 */
async function analyzeWorkspaceAsync(root, options) {
  options = options || {};
  const useGit = options.git !== false;
  const r = analyzeWorkspace(root, Object.assign({}, options, { _keepSparse: useGit }));
  const t0 = Date.now() - r.elapsedMs;
  const ctx = r.context;
  const ignore = new Set((options.ignoreRules || []).map((x) => String(x).toUpperCase()));
  if (!useGit || !ctx.gitRoot) r.diagnostics = r.diagnostics.filter((d) => !(d.data && d.data.sparse));
  if (useGit && ctx.gitRoot) {
    let diags = await gitPathFilter(ctx, r.diagnostics);
    if (options.stale && !ignore.has('CD006')) {
      const rels = r._results.map((x) => x.rel);
      const st = await gitStaleness(ctx, rels);
      const minCommits = options.staleCommits || 50;
      const now = options.now || Date.now();
      for (const x of r._results) {
        const info = st.get(x.rel);
        if (!info || info.since === null || info.since < minCommits) continue;
        const days = Math.floor((now / 1000 - info.ct) / 86400);
        const date = new Date(info.ct * 1000).toISOString().slice(0, 10);
        const first = splitLines(stripBom(x.text))[0] || '';
        const doc = { disabled: scanDocument(x.text).disabled };
        if (isDisabled(doc, 'CD006', 0)) continue;
        const d = mkDiag('CD006', 'info', x.rel, 0, 0, Math.max(1, first.length),
          `Last changed ${days} days ago (${date}); the repo has ${info.since} commits since. Review it for stale facts.`, { data: { kind: 'stale', days, commits: info.since } });
        d.absFile = path.join(ctx.root, d.file);
        diags.push(d);
      }
    }
    sortDiags(diags);
    r.diagnostics = diags;
  }
  r.elapsedMs = Date.now() - t0;
  return r;
}

function crossFileConflicts(results) {
  const out = [];
  const groups = new Map();
  for (const r of results) {
    const k = r.facts.kind;
    if (!k || k === 'SKILL.md' || k === 'copilot-scoped') continue;
    const sd = scopeDirOf(r.rel);
    if (!groups.has(sd)) groups.set(sd, []);
    groups.get(sd).push(r);
  }
  for (const list of groups.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = 0; b < list.length; b++) {
        if (a === b) continue;
        const A = list[a], B = list[b];
        for (const [verb, cmdsB] of B.facts.verbs) {
          const cmdsA = A.facts.verbs.get(verb);
          if (!cmdsA || !cmdsA.length || !cmdsB.length) continue;
          const keysA = new Set(cmdsA.map((x) => x.key));
          if (cmdsB.some((x) => keysA.has(x.key))) continue;
          const first = cmdsB[0];
          const verbName = verb.split('\0')[0];
          out.push(mkDiag('CD005', 'info', B.rel, first.line, first.col, first.endCol,
            `${baseName(B.rel)} says \`${first.display}\` to ${verbName}, but ${A.rel} says \`${cmdsA[0].display}\`. Agents get different instructions.`,
            { related: [{ file: A.rel, line: cmdsA[0].line, column: cmdsA[0].col, endColumn: cmdsA[0].endCol, message: `${A.rel}: \`${cmdsA[0].display}\`` }], data: { kind: 'conflict', verb: verbName } }));
        }
      }
    }
  }
  // dedupe identical (file,line,col)
  const seen = new Set();
  return out.filter((d) => { const k = d.file + ':' + d.line + ':' + d.column; if (seen.has(k)) return false; seen.add(k); return true; });
}
function baseName(rel) { return rel.slice(rel.lastIndexOf('/') + 1); }
function toPosix(p) { return p.split(path.sep).join('/'); }

/** Convenience: analyze one file on disk (CD005/CD006 need the workspace). */
function analyzeFile(root, rel, text, options) {
  const ctx = (options && options.context) || createContext(root, options);
  if (text === undefined) text = readRel(ctx, rel, MAX_INSTRUCTION_BYTES);
  return analyzeText(ctx, rel, text).diagnostics;
}

module.exports = {
  VERSION,
  RULES,
  IGNORED_DIRS,
  classifyInstructionFile,
  createContext,
  analyzeWorkspace,
  analyzeText,
  analyzeFile,
  findInstructionFiles,
  analyzeWorkspaceAsync,
  invalidateManifests,
  MAX_LINE_CHARS,
  safeText,
  safeLine,
  // exported for tests
  _internal: { importTarget, tokenizeShell, scanDocument, parseVer, satisfiesRange, claimFitsRange, compileGlob, globMatch, parseTomlLite, parseMakefile, parseJustfile, parseTaskfile, classifyPathCandidate, runGit, isGitignored },
};
