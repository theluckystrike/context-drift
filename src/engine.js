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

const VERSION = '0.1.0';

const RULES = {
  CD001: { id: 'CD001', name: 'command-drift', defaultSeverity: 'error', description: 'A documented command (npm/pnpm/yarn/bun script, make target, just recipe, task, cargo alias/package, uv/poetry script) does not exist in the repo.' },
  CD002: { id: 'CD002', name: 'path-drift', defaultSeverity: 'warning', description: 'A referenced relative path does not exist (globs that match nothing are reported as info).' },
  CD003: { id: 'CD003', name: 'package-manager-drift', defaultSeverity: 'warning', description: 'The file uses one package manager but the lockfile / packageManager field says another.' },
  CD004: { id: 'CD004', name: 'version-drift', defaultSeverity: 'warning', description: 'A Node/Python/Go version claim contradicts .nvmrc, .node-version, engines, .python-version, requires-python or go.mod.' },
  CD005: { id: 'CD005', name: 'cross-file-conflict', defaultSeverity: 'info', description: 'Two instruction files in the same scope give different commands for the same verb (test/build/lint/format/dev/typecheck).' },
  CD006: { id: 'CD006', name: 'stale-file', defaultSeverity: 'info', description: 'The instruction file has not changed for a long time while the repo kept moving.' },
};

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'vendor', 'target', '.venv', 'venv',
  '__pycache__', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'coverage',
  '.gradle', '.idea', 'Pods', '.terraform', '.tox', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', 'bower_components', '.output', '.parcel-cache', '.yarn', '.pnpm-store',
  'site-packages', '.hg', '.svn', '.direnv', '.eggs',
]);

const MAX_INSTRUCTION_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_WALK_ENTRIES = 200000;

/* ------------------------------------------------------------------ */
/* Instruction file detection                                          */
/* ------------------------------------------------------------------ */

const INSTRUCTION_BASENAMES = new Set([
  'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md', 'SKILL.md',
  '.cursorrules', '.windsurfrules', '.clinerules',
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
  return null;
}

/** Directory whose files the instruction file "governs" (for CD005 grouping). */
function scopeDirOf(rel) {
  const m = /^(.*?)(?:^|\/)(?:\.github|\.cursor|\.clinerules|\.windsurf)\//.exec(rel);
  if (m) return m[1];
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

function globToRegExp(glob) {
  let re = '';
  let i = 0;
  let braceDepth = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 2;
        if (glob[i] === '/') { re += '(?:.*/)?'; i++; } else re += '.*';
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { re += '(?:'; braceDepth++; }
    else if (c === '}' && braceDepth) { re += ')'; braceDepth--; }
    else if (c === ',' && braceDepth) re += '|';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end > i) { re += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = end; } else re += '\\[';
    } else re += c.replace(/[.+^$()|\\\]]/g, '\\$&');
    i++;
  }
  while (braceDepth-- > 0) re += ')';
  return new RegExp('^' + re + '$');
}
function isGlob(s) { return /[*?]|\[[^\]]+\]|\{[^}]*,[^}]*\}/.test(s); }

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
  const ctx = {
    root,
    files: w.files,
    fileSet: new Set(w.files),
    dirs: w.dirs,
    truncated: w.truncated,
    byBase,
    options,
    builtAt: Date.now(),
    _cache: new Map(),
  };
  return ctx;
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
      const t = fs.readFileSync(abs, 'utf8');
      if (isBinaryText(t)) return null;
      return stripBom(t);
    } catch (_) { return null; }
  });
}

function readFresh(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_INSTRUCTION_BYTES) return null;
    const t = fs.readFileSync(abs, 'utf8');
    return isBinaryText(t) ? null : stripBom(t);
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
      while (line.endsWith('\\') && i + 1 < lines.length) line = line.slice(0, -1) + ' ' + lines[++i];
      if (inDefine) { if (/^\s*endef\b/.test(line)) inDefine = false; continue; }
      if (/^\s*define\b/.test(line)) { inDefine = true; continue; }
      if (line.startsWith('\t')) continue;
      const noComment = line.replace(/(^|[^\\])#.*$/, '$1');
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
      const m = /^([^\s:=#][^:=#]*?)\s*(?:::|:|&:)(?![:=])/.exec(noComment);
      if (!m) continue;
      if (/^\s*(?:export|override|ifeq|ifneq|ifdef|ifndef|else|endif|vpath)\b/.test(m[1])) continue;
      for (const tg of m[1].trim().split(/\s+/)) {
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
      m = /^@?([A-Za-z_][\w-]*)(?:\s+[^:]*?)?\s*:(?!=)/.exec(line);
      if (m) res.recipes.add(m[1]);
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
      if (/^\S/.test(line)) {
        inTasks = /^tasks\s*:/.test(line);
        if (/^includes\s*:/.test(line)) res.uncertain = true;
        indent = -1;
        continue;
      }
      if (!inTasks || !line.trim() || /^\s*#/.test(line)) continue;
      const m = /^(\s+)(['"]?)([^'"\s#][^'"#]*?)\2\s*:(?:\s|$)/.exec(line);
      if (!m) continue;
      if (indent < 0) indent = m[1].length;
      if (m[1].length !== indent) continue;
      if (m[3].includes('*')) res.patterns.push(globToRegExp(m[3])); else res.tasks.add(m[3]);
    }
    return res;
  });
}

/* ---------- minimal TOML ---------- */

/** Tolerant TOML subset reader: returns { tables: Map<tableName, Map<key, value>> }. Values: string | string[] | raw string. */
function parseTomlLite(text) {
  const tables = new Map();
  let cur = '';
  tables.set('', new Map());
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
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
    m = /^((?:"[^"]*"|'[^']*'|[A-Za-z0-9_.\- ]+?))\s*=\s*(.*)$/.exec(trimmed);
    if (!m) continue;
    const key = m[1].replace(/["']/g, '').trim();
    let val = m[2];
    if (val.startsWith('"""') || val.startsWith("'''")) {
      const q = val.slice(0, 3);
      let body = val.slice(3);
      while (!body.includes(q) && i + 1 < lines.length) body += '\n' + lines[++i];
      val = body.slice(0, body.indexOf(q));
      setTomlKey(tables, cur, key, val);
      continue;
    }
    if (val.startsWith('[')) {
      let depth = bracketDepth(val);
      while (depth > 0 && i + 1 < lines.length) { const nx = lines[++i]; val += '\n' + nx; depth += bracketDepth(nx); }
      const items = [];
      const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
      let mm;
      const body = val.replace(/#[^\n"']*$/gm, '');
      while ((mm = re.exec(body))) items.push(mm[1] !== undefined ? mm[1] : mm[2]);
      setTomlKey(tables, cur, key, items);
      continue;
    }
    const s = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(val);
    if (s) { setTomlKey(tables, cur, key, s[1] !== undefined ? s[1] : s[2]); continue; }
    setTomlKey(tables, cur, key, val.replace(/\s+#.*$/, '').trim());
  }
  return { tables };
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

function scanDocument(text) {
  const lines = splitLines(text);
  const doc = { lines, inline: [], fence: [], links: [], prose: [], frontmatter: null, disabled: { file: null, lines: new Map() } };

  // frontmatter
  let start = 0;
  if (lines.length && /^---\s*$/.test(lines[0])) {
    for (let i = 1; i < Math.min(lines.length, 400); i++) {
      if (/^(---|\.\.\.)\s*$/.test(lines[i])) { doc.frontmatter = { start: 0, end: i }; start = i + 1; break; }
    }
  }

  // directives
  const dirRe = /context-drift-disable(-next-line|-line)?(?![\w-])([^\n]*)/;
  for (let i = 0; i < lines.length; i++) {
    const m = dirRe.exec(lines[i]);
    if (!m) continue;
    const ids = (m[2].match(/CD\d{3}/g) || []);
    const set = ids.length ? new Set(ids) : null; // null => all rules
    if (m[1] === '-next-line') addDisabled(doc, i + 1, set);
    else if (m[1] === '-line') addDisabled(doc, i, set);
    else {
      if (!doc.disabled.file) doc.disabled.file = set === null ? 'all' : new Set();
      if (doc.disabled.file !== 'all') for (const id of set) doc.disabled.file.add(id);
    }
  }

  let fence = null;
  let inComment = false;
  let heading = '';
  let heredoc = null;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) { fence = null; heredoc = null; continue; }
      if (heredoc) { if (line.trim() === heredoc) heredoc = null; continue; }
      const hd = /<<-?\s*['"]?([A-Za-z_][\w]*)['"]?/.exec(line);
      if (/\b(?:mkdir|clone|init|create|new|degit|scaffold|generate|startproject|startapp)\b/.test(line)) fence.creates = true;
      doc.fence.push({ text: line, line: i, lang: fence.lang, heading, afterCreate: !!fence.creates });
      if (hd) heredoc = hd[1];
      continue;
    }
    const open = /^(\s*)(`{3,}|~{3,})\s*([^\s`{]*)/.exec(line);
    if (open && !(open[2][0] === '`' && line.slice(open[1].length + open[2].length).includes('`'))) {
      fence = { ch: open[2][0], len: open[2].length, lang: open[3].toLowerCase().replace(/^\{?\.?/, '') };
      continue;
    }
    // strip html comments (keep columns)
    let work = '';
    let j = 0;
    while (j < line.length) {
      if (inComment) {
        const e = line.indexOf('-->', j);
        if (e < 0) { work += ' '.repeat(line.length - j); j = line.length; } else { work += ' '.repeat(e + 3 - j); j = e + 3; inComment = false; }
      } else {
        const s = line.indexOf('<!--', j);
        if (s < 0) { work += line.slice(j); j = line.length; } else { work += line.slice(j, s); j = s; inComment = true; }
      }
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(work);
    if (h) heading = h[2].trim();
    // inline code spans
    let masked = '';
    let k = 0;
    const spans = [];
    while (k < work.length) {
      const c = work[k];
      if (c === '\\' && k + 1 < work.length) { masked += work.slice(k, k + 2); k += 2; continue; }
      if (c === '`') {
        let n = 0;
        while (work[k + n] === '`') n++;
        const ticks = '`'.repeat(n);
        let search = k + n;
        let close = -1;
        while (search < work.length) {
          const p = work.indexOf(ticks, search);
          if (p < 0) break;
          let q = p + n;
          if (work[q] === '`') { while (work[q] === '`') q++; search = q; continue; }
          close = p;
          break;
        }
        if (close < 0) { masked += ticks; k += n; continue; }
        let cs = k + n, ce = close;
        let content = work.slice(cs, ce);
        if (content.length > 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim()) { cs++; ce--; content = work.slice(cs, ce); }
        spans.push({ text: content, line: i, col: cs, endCol: ce, heading });
        masked += ' '.repeat(close + n - k);
        k = close + n;
        continue;
      }
      masked += c;
      k++;
    }
    for (const s of spans) { s.lineText = work; doc.inline.push(s); }
    // links
    const linkRe = /!?\[((?:[^\]\\]|\\.)*)\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
    let lm;
    while ((lm = linkRe.exec(masked))) {
      let target = lm[2];
      let tcol = lm.index + lm[0].indexOf(target, lm[1].length + 2);
      if (target.startsWith('<')) { target = target.slice(1, -1); tcol++; }
      doc.links.push({ text: target, line: i, col: tcol, endCol: tcol + target.length, heading, lineText: work });
    }
    const ref = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(masked);
    if (ref) {
      let target = ref[1];
      let tcol = ref[0].lastIndexOf(target);
      if (target.startsWith('<')) { target = target.slice(1, -1); tcol++; }
      doc.links.push({ text: target, line: i, col: tcol, endCol: tcol + target.length, heading, lineText: work });
    }
    doc.prose.push({ text: work, masked, line: i, heading });
  }
  return doc;
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

const NEG_BEFORE = /(?:\b(?:not|never|don'?t|doesn'?t|do not|does not|avoid|instead of|rather than|no longer|deprecated|removed|formerly|previously|legacy|replaced|stop using|without|unlike|versus|vs\.?|nor|old|obsolete|used to|switched from|moved from|migrated from|renamed from|upgraded? from|migrating from|forbidden|banned|prohibited)\b|~~)[^.;!?]*$/i;
const NEG_AFTER = /^(?:[^.;!?]*?\b(?:is|was|are|were|has been|have been|got)\s+(?:now\s+)?(?:removed|deleted|deprecated|gone|renamed|replaced|obsolete|retired|dropped|forbidden|banned)\b|\s*(?:\(|—|–|-|:)?\s*(?:deprecated|removed|old|legacy|obsolete|no longer)\b|[^.;!?]*\bno longer\b|[^.;!?]*\b(?:doesn'?t|does not|won'?t|will not)\s+(?:exist|work)\b|\s*~~)/i;
const CREATE_BEFORE = /\b(?:create|creates|created|creating|add|adds|adding|new|generate[sd]?|generating|write|writes|written|writing|output|outputs|emit|emits|touch|mkdir|scaffold|will be|would be|e\.g\.?|eg|for example|such as|like|examples?|look for|check for|search for|detect|whether|either|any of|optionally|optional|if (?:you )?(?:have|need|want)|if present|if it exists|save (?:it )?(?:to|as)|rename(?:d)? (?:it )?to|move(?:d)? (?:it )?to|copy (?:it )?to|produces?|into|goes to|lands in)\b[^.;!?]*$/i;
const CREATE_AFTER = /^(?:[^.;!?]*?\b(?:will be|is|are|gets|get|be)\s+(?:auto-?)?(?:created|generated|written|produced|built|emitted|downloaded|installed)\b|\s*\(?\s*(?:generated|created|gitignored|ignored|local(?:ly)?|optional|if present|if it exists|if exists|not committed|untracked|when present|once created)\b|[^.;!?]*\bif (?:it |they )?(?:exists?|present)\b|[^.;!?]*\b(?:does ?n[o']t exist yet|not exist yet|to be created)\b)/i;
const EXAMPLE_HEADING = /\b(?:examples?|samples?|templates?|placeholders?|illustrations?|format|output)\b/i;

function contextBefore(lineText, col) {
  const s = lineText.slice(Math.max(0, col - 80), col);
  const cut = Math.max(s.lastIndexOf('. '), s.lastIndexOf('; '), s.lastIndexOf('! '), s.lastIndexOf('? '));
  return cut >= 0 ? s.slice(cut + 2) : s;
}
function contextAfter(lineText, endCol) { return lineText.slice(endCol, endCol + 80); }
function negated(lineText, col, endCol) {
  if (!lineText) return false;
  const b = contextBefore(lineText, col).replace(/`[^`]*`/g, ' ');
  if (NEG_BEFORE.test(b)) return true;
  // "`a` or `b`" lists: if the sibling list is negated as a whole, already caught above.
  return NEG_AFTER.test(contextAfter(lineText, endCol));
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
      for (const p of pickPackages(ctx, dir)) {
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
const MIN_SUFFIX = '(\\s*\\+|\\s*(?:or|and)\\s+(?:newer|later|above|higher|up)|\\s*(?:\\(|or\\s+)?\\s*(?:newer|later|or later|or newer|and up)\\)?)';
const VERSION_PATTERNS = [
  { lang: 'node', re: new RegExp('\\b(?:node(?:\\.?js)?)(?![\\w-])\\s*(?:v(?=\\d)|version\\s+|@)?(>=|=>|≥|\\^|~|>)?\\s*v?(\\d{1,2}(?:\\.(?:\\d+|x))?(?:\\.(?:\\d+|x))?)(?![\\d.]*\\w)' + MIN_SUFFIX + '?', 'gi'), minMajor: 4 },
  { lang: 'node', re: /\bnvm\s+(?:use|install|alias\s+default)\s+v?(\d{1,2}(?:\.\d+){0,2})\b/g, cmd: true },
  { lang: 'python', re: new RegExp('\\b(?:c?python)\\s*(?:v(?=\\d)|version\\s+)?(>=|=>|≥|~=|\\^|>|==)?\\s*([23]\\.\\d{1,2}(?:\\.(?:\\d+|x|\\*))?)(?![\\d.]*\\w)' + MIN_SUFFIX + '?', 'gi') },
  { lang: 'python', re: /\bpyenv\s+(?:install|local|global|shell)\s+([23]\.\d{1,2}(?:\.\d+)?)\b/g, cmd: true },
  { lang: 'python', re: /(?:--python[= ]|\buv\s+python\s+(?:install|pin)\s+|\buv\s+venv\s+-p\s+)([23]\.\d{1,2}(?:\.\d+)?)\b/g, cmd: true },
  { lang: 'go', re: new RegExp('\\b(?:Go|golang|Golang|GoLang|GO)\\s+(?:v(?=\\d)|version\\s+)?(>=|≥)?\\s*(1\\.\\d{1,2}(?:\\.\\d+)?)(?![\\d.]*\\w)' + MIN_SUFFIX + '?', 'g') },
];
const MULTI_TAIL = /^\s*(?:,|\/|\bor\b|\band\b|&|-|–|\bto\b|\bthrough\b)\s*v?(\d{1,2}(?:\.\d+)?)(?![\d.]*\w)/i;

/* ------------------------------------------------------------------ */
/* Per-file analysis                                                   */
/* ------------------------------------------------------------------ */

function mkDiag(ruleId, severity, rel, line, col, endCol, message, extra) {
  const d = { ruleId, severity, file: rel, line, column: col, endLine: line, endColumn: endCol, message };
  if (extra) Object.assign(d, extra);
  return d;
}

/**
 * Analyze one instruction file. Returns { diagnostics, facts }.
 * facts.verbs: Map<verb, [{key, display, line, col, endCol}]>
 */
function analyzeText(ctx, rel, text, opts) {
  opts = opts || {};
  const out = [];
  const facts = { verbs: new Map(), kind: classifyInstructionFile(rel) };
  if (typeof text !== 'string') return { diagnostics: out, facts };
  text = stripBom(text);
  if (text.length > MAX_INSTRUCTION_BYTES || isBinaryText(text)) return { diagnostics: out, facts };
  const doc = scanDocument(text);
  const instrDir = posixDirname(rel);
  const emit = (d) => { if (!isDisabled(doc, d.ruleId, d.line)) out.push(d); };
  const seen = new Set();
  const emitOnce = (d) => { const k = d.ruleId + ':' + d.line + ':' + d.column; if (seen.has(k)) return; seen.add(k); emit(d); };

  const pmInfo = memo(ctx, 'pm:' + instrDir, () => repoPackageManager(ctx, instrDir));
  // Skills are reusable know-how (often about other projects): only check the files they bundle.
  const repoFacts = facts.kind !== 'SKILL.md';

  // ---- commands from inline code and shell fences
  const commandSources = [];
  for (const s of doc.inline) commandSources.push({ text: s.text, line: s.line, col: s.col, lineText: s.lineText, endCol: s.endCol, inline: true });
  for (const f of doc.fence) {
    if (!SHELL_LANGS.has(f.lang)) continue;
    let t = f.text;
    if (PROMPT_LANGS.has(f.lang)) {
      const pm = /^(\s*)(?:\$|>|%|❯|PS[^>]*>)\s/.exec(t);
      if (!pm) continue;
      t = ' '.repeat(pm[0].length) + t.slice(pm[0].length);
    } else {
      const pm = /^(\s*)(?:\$|❯)\s/.exec(t);
      if (pm) t = ' '.repeat(pm[0].length) + t.slice(pm[0].length);
    }
    if (t.endsWith('\\')) t = t.slice(0, -1);
    commandSources.push({ text: t, line: f.line, col: 0, lineText: '', endCol: t.length, inline: false, afterCreate: f.afterCreate });
  }

  for (const src of repoFacts ? commandSources : []) {
    let t = src.text;
    if (src.inline) {
      const pm = /^(?:\$|❯|>)\s+/.exec(t);
      if (pm) t = ' '.repeat(pm[0].length) + t.slice(pm[0].length);
    }
    if (src.inline && negated(src.lineText, src.col, src.endCol)) continue;
    const segs = tokenizeShell(t, src.col);
    let cwd; // undefined => instruction dir
    for (const seg of segs) {
      const toks = stripPrefixes(seg.toks);
      if (!toks.length) continue;
      const cmd = toks[0].v;
      if (cmd === 'cd' || cmd === 'pushd') {
        const target = toks[1];
        if (!target || /^[~/$-]|^[A-Za-z]:/.test(target.v) || !isLiteralPath(target.v)) { cwd = null; continue; }
        const base = cwd === undefined ? instrDir : cwd;
        if (base === null) continue;
        const cand = [normalizeRel(posixJoin(base, target.v)), normalizeRel(target.v)];
        const hit = cand.find((c) => c !== null && isDirRel(ctx, c));
        if (hit !== undefined) cwd = hit;
        else {
          cwd = null;
          const created = src.afterCreate || segs.slice(0, segs.indexOf(seg)).some((sg) => /^(?:mkdir|git|npx|pnpm|yarn|bun|bunx|npm|cargo|uv|poetry|django-admin|rails|composer|dotnet|go)$/.test(sg.toks[0] && sg.toks[0].v));
          if (!created && (src.inline || seg.toks[0] === toks[0])) {
            if (!looksIgnoredOrGenerated(ctx, cand[1] || cand[0] || '')) {
              emitOnce(mkDiag('CD002', 'warning', rel, src.line, target.s, target.e,
                `\`cd ${target.v}\`: directory "${target.v}" does not exist in the repo.`, { data: { kind: 'path', path: target.v, parent: nearestExistingParent(ctx, cand[1] || cand[0] || '') } }));
            }
          }
        }
        continue;
      }
      if (cwd === null) continue;
      if (seg.dynamic) continue;
      const dir = commandDir(ctx, instrDir, cwd);
      checkCommand(ctx, rel, src, toks, dir, emitOnce, facts, pmInfo, cwd !== undefined);
    }
  }

  // ---- CD003 prose: "use yarn", "we use npm"
  if (repoFacts && pmInfo && pmInfo.pm) {
    const re = /\b(?:use|uses|using|prefer|prefers|run with|install with|via)\s+`?(npm|pnpm|yarn|bun)`?(?![\w.@/-])/gi;
    for (const p of doc.prose) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(p.text))) {
        const pmName = m[1].toLowerCase();
        if (pmName === pmInfo.pm) continue;
        const col = m.index + m[0].lastIndexOf(m[1]);
        const after = p.text.slice(col, col + 80);
        if (/^\w+`?\s*(?:to|for)\s+(?:publish|log ?in|install\s+(?:it\s+)?globally|global)|\s-g\b|--global/i.test(after)) continue;
        const before = contextBefore(p.text, m.index);
        if (NEG_BEFORE.test(before)) continue;
        if (/\b(?:over|rather than|instead of)\s*$/i.test(before)) continue;
        emitOnce(mkDiag('CD003', 'warning', rel, p.line, col, col + m[1].length,
          `This file says to use ${pmName}, but the repo uses ${pmInfo.pm} (${pmInfo.source}).`, { data: { kind: 'pm', expected: pmInfo.pm } }));
      }
    }
  }

  // ---- CD004 version claims (prose, inline code, shell fences)
  const vLines = [];
  for (const p of doc.prose) vLines.push({ text: p.text, line: p.line });
  for (const f of doc.fence) if (SHELL_LANGS.has(f.lang)) vLines.push({ text: f.text, line: f.line, fence: true });
  for (const vl of repoFacts ? vLines : []) {
    for (const pat of VERSION_PATTERNS) {
      if (vl.fence && !pat.cmd) continue;
      pat.re.lastIndex = 0;
      let m;
      while ((m = pat.re.exec(vl.text))) {
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
        const ctxB = contextBefore(lineText, startCol);
        if (/\b(?:no longer|dropped|deprecated|removed|end[- ]of[- ]life|eol|unsupported|not supported|legacy|old|older|previously|formerly|was|were|used to|upgrade[ds]? from|migrat\w* from|before|until|below|less than|prior to|not|never|avoid|don'?t|doesn'?t|instead of)\b[^.;!?]*$/i.test(ctxB)) continue;
        const tail = lineText.slice(endCol, endCol + 60);
        if (/^\s*(?:is|are|was|were|has been|have been)?\s*(?:no longer|dropped|deprecated|removed|EOL|end[- ]of[- ]life|unsupported|not supported)\b/i.test(tail)) continue;
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
  for (const s of doc.inline) {
    if (!repoFacts && !SKILL_BUNDLE_PATH.test(s.text)) continue; // skills describe *other* projects; check only their bundle
    checkPathCandidate(ctx, rel, instrDir, s, false, emitOnce, !repoFacts);
  }
  for (const l of doc.links) checkPathCandidate(ctx, rel, instrDir, l, true, emitOnce);

  // ---- CD002 frontmatter globs in .mdc / .instructions.md
  if (doc.frontmatter && (facts.kind === 'cursor-rule' || facts.kind === 'copilot-scoped')) {
    const scope = scopeDirOf(rel);
    for (let i = doc.frontmatter.start + 1; i < doc.frontmatter.end; i++) {
      const m = /^\s*(globs|applyTo)\s*:\s*(.*)$/.exec(doc.lines[i]);
      if (!m) continue;
      let items = [];
      let valCol = doc.lines[i].indexOf(m[2], m[0].length - m[2].length);
      if (m[2].trim()) {
        const raw = m[2].trim();
        if (raw.startsWith('[')) {
          const re = /"([^"]*)"|'([^']*)'|([^,\[\]\s][^,\[\]]*)/g; let mm;
          while ((mm = re.exec(raw))) items.push({ g: (mm[1] || mm[2] || mm[3] || '').trim(), line: i, col: valCol + raw.indexOf(mm[0]) });
        } else {
          const unq = raw.replace(/^["']|["']$/g, '');
          let off = raw.indexOf(unq);
          for (const part of unq.split(',')) {
            const g = part.trim();
            if (g) items.push({ g, line: i, col: valCol + off + part.indexOf(g) });
            off += part.length + 1;
          }
        }
      } else {
        for (let j = i + 1; j < doc.frontmatter.end; j++) {
          const li = /^(\s*-\s*)(["']?)([^"'\n]+?)\2\s*$/.exec(doc.lines[j]);
          if (!li) break;
          items.push({ g: li[3], line: j, col: li[1].length + li[2].length });
        }
      }
      for (const it of items) {
        if (!it.g || it.g === '**' || it.g === '**/*' || it.g === '*') continue;
        if (!globMatchesAny(ctx, it.g, scope)) {
          emitOnce(mkDiag('CD002', 'info', rel, it.line, it.col, it.col + it.g.length,
            `${m[1]} pattern "${it.g}" matches no files in the repo, so this rule never applies.`, { data: { kind: 'glob', glob: it.g } }));
        }
      }
    }
  }

  return { diagnostics: out, facts };
}

function isLiteralPath(p) {
  return !/[<>{}$*?|`]|\.\.\.|\bpath\/to\b|\b(?:your|my|some|example|sample|foo|bar|xxx|project-name|app-name|repo-name)\b/i.test(p);
}

function looksIgnoredOrGenerated(ctx, rel) {
  const first = rel.split('/')[0];
  if (IGNORED_DIRS.has(first) || ['out', 'tmp', 'temp', 'logs', 'log', '.env', 'reports', 'artifacts'].includes(first)) return true;
  if (rel.split('/').some((s) => IGNORED_DIRS.has(s))) return true;
  return isGitignored(ctx, rel);
}

function gitignoreRules(ctx) {
  return memo(ctx, 'gitignore', () => {
    const rules = [];
    for (const gi of filesNamed(ctx, '.gitignore')) {
      const base = posixDirname(gi);
      const t = readRel(ctx, gi);
      if (!t) continue;
      for (let line of splitLines(t)) {
        line = line.replace(/\s+$/, '');
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        let dirOnly = false;
        if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
        const anchored = line.includes('/');
        line = line.replace(/^\//, '');
        let re;
        try { re = globToRegExp(line); } catch (_) { continue; }
        rules.push({ base, re, anchored, dirOnly });
      }
    }
    return rules;
  });
}
function isGitignored(ctx, rel) {
  const rules = gitignoreRules(ctx);
  if (!rules.length) return false;
  const parts = rel.split('/');
  for (const r of rules) {
    if (r.base && !(rel === r.base || rel.startsWith(r.base + '/'))) continue;
    const local = r.base ? rel.slice(r.base.length + 1) : rel;
    const lp = local.split('/');
    for (let i = 1; i <= lp.length; i++) {
      const prefix = lp.slice(0, i).join('/');
      if (r.anchored) { if (r.re.test(prefix)) return true; }
      else if (r.re.test(lp[i - 1])) return true;
    }
  }
  void parts;
  return false;
}

function basenameGitignored(ctx, name) {
  for (const r of gitignoreRules(ctx)) if (!r.anchored && r.re.test(name)) return true;
  return false;
}

function nearestExistingParent(ctx, rel) {
  let d = posixDirname(rel || '');
  while (d && !isDirRel(ctx, d)) d = posixDirname(d);
  return d;
}

function globMatchesAny(ctx, glob, baseDir) {
  let g = glob.replace(/^\.\//, '');
  let anchoredBase = baseDir || '';
  if (g.startsWith('/')) { g = g.slice(1); anchoredBase = ''; }
  const dirOnly = g.endsWith('/');
  if (dirOnly) g = g.slice(0, -1);
  let re;
  try { re = globToRegExp(g); } catch (_) { return true; }
  const hasSlash = g.includes('/');
  const pool = dirOnly ? ctx.dirs : ctx.files;
  for (const f of pool) {
    let local = f;
    if (anchoredBase) { if (!f.startsWith(anchoredBase + '/')) continue; local = f.slice(anchoredBase.length + 1); }
    if (hasSlash) { if (re.test(local)) return true; }
    else if (re.test(local.slice(local.lastIndexOf('/') + 1))) return true;
  }
  if (!anchoredBase || !hasSlash) return false;
  // also try from repo root
  for (const f of pool) if (re.test(f)) return true;
  return false;
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
const GENERIC_FILE_MENTIONS = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENT.md', 'GEMINI.md', 'SKILL.md', '.cursorrules', '.windsurfrules', '.clinerules', 'copilot-instructions.md', 'settings.json', 'settings.local.json', 'llms.txt', 'llms-full.txt', 'MEMORY.md', 'mcp.json', '.mcp.json', 'config.toml', 'config.json', 'config.yaml', 'config.yml', 'index.html', 'index.js', 'index.ts', 'main.py', 'main.go', 'main.rs', 'lib.rs', 'mod.rs', '__init__.py', 'conftest.py', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', 'LICENSE.md', 'TODO.md', 'NOTES.md', 'PLAN.md', 'SPEC.md', 'STATUS.json', 'DONE', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'go.sum', 'tsconfig.json', 'jsconfig.json', 'vite.config.ts', 'vite.config.js', 'next.config.js', 'next.config.mjs', 'next.config.ts', '.env', '.env.local', '.env.example', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml']);

function classifyPathCandidate(raw, isLink) {
  let p = raw.trim();
  if (!p || p.length > 260 || /\s/.test(p)) return null;
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
  }
  if (p.startsWith('~') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')) return null;
  if (p.startsWith('/') && !isLink) return null;
  if (p.startsWith('@') || p.startsWith('-') || p.startsWith('$') || p.startsWith('%')) return null;
  if (/[<>{}$%|`"'(),;=!^&]/.test(p.replace(/\{[^}]*,[^}]*\}/g, ''))) return null; // placeholders / code
  if (/\.\.\.|\bpath\/to\b|\b(?:your|my|some|example|sample|foo|bar|xxx|yyy|NNN|YYYY|MM-DD)\b/i.test(p)) return null;
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

function checkPathCandidate(ctx, rel, instrDir, s, isLink, emit, localOnly) {
  const c = classifyPathCandidate(s.text, isLink);
  if (!c) return;
  if (s.heading && EXAMPLE_HEADING.test(s.heading)) return;
  const lineText = s.lineText || '';
  if (negated(lineText, s.col, s.endCol)) return;
  if (!isLink) {
    const b = contextBefore(lineText, s.col).replace(/`[^`]*`/g, ' ');
    if (CREATE_BEFORE.test(b)) return;
  }
  if (CREATE_AFTER.test(contextAfter(lineText, s.endCol))) return;

  const lowerExt = c.ext.toLowerCase();
  const knownExt = c.ext && PATH_EXTS.has(c.ext) && c.ext === lowerExt;
  const isDotfileName = !c.hasSlash && KNOWN_DOTFILES.has(c.clean.replace(/\.(json|js|cjs|mjs|ya?ml|toml)$/, ''));
  const bareKnown = !c.hasSlash && BARE_NAMES.has(c.clean);
  let kind;
  if (c.glob) kind = 'glob';
  else if (c.hasSlash || c.explicitRel || isLink) kind = 'path';
  else if (knownExt || isDotfileName || bareKnown) kind = 'bare';
  else return;

  // a path right after an external URL usually lives in that other repo
  if (!isLink && /\]\(https?:|https?:\/\//i.test(lineText.slice(0, s.col))) return;
  // only treat slash paths without an extension as path claims when they look like one
  if (kind === 'path' && !c.explicitRel && !c.trailing && !knownExt && !c.glob && !c.rootRel) {
    const first = c.segs[0];
    const firstExists = isDirRel(ctx, first) || isDirRel(ctx, posixJoin(instrDir, first) || '');
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
  }

  const range = { line: s.line, col: s.col + Math.max(0, s.text.indexOf(c.path)), endCol: 0 };
  range.endCol = range.col + c.path.length;

  if (kind === 'glob') {
    if (existsRel(ctx, normalizeRel(posixJoin(instrDir, c.clean)) || '') || existsRel(ctx, normalizeRel(c.clean) || '')) return; // literal [id] route
    const base = c.explicitRel ? instrDir : (c.rootRel ? '' : '');
    if (looksIgnoredOrGenerated(ctx, c.clean.replace(/[*?[{].*$/, '').replace(/\/$/, '') || '__none__')) return;
    if (globMatchesAny(ctx, c.clean, base) || globMatchesAny(ctx, c.clean, instrDir)) return;
    emit(mkDiag('CD002', 'info', rel, range.line, range.col, range.endCol,
      `Glob "${c.path}" matches no files in the repo.`, { data: { kind: 'glob', glob: c.path } }));
    return;
  }

  const target = c.clean.replace(/\/+$/, '');
  const cands = [];
  if (c.rootRel) cands.push(normalizeRel(target));
  else {
    cands.push(normalizeRel(posixJoin(instrDir, target)));
    if (!localOnly && (!isLink || !c.explicitRel)) for (const a of ancestors(instrDir).slice(1)) cands.push(normalizeRel(posixJoin(a, target)));
  }
  const valid = cands.filter((x) => x !== null && x !== '');
  if (!valid.length) return; // escapes the root: cannot check
  for (const x of valid) {
    if (c.trailing ? isDirRel(ctx, x) : existsRel(ctx, x)) return;
  }
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
    }
  }
  // suggestion: same basename elsewhere
  let suggestion = null;
  const sameBase = (ctx.byBase.get(c.last) || []).filter((f) => !looksIgnoredOrGenerated(ctx, f));
  if (sameBase.length === 1 && !c.trailing) suggestion = sameBase[0];
  const fromDir = c.explicitRel || isLink ? (instrDir ? instrDir + '/' : '') : '';
  let fixText = null;
  if (suggestion) fixText = relativeFrom(fromDir || localOnly ? instrDir : '', suggestion, c.explicitRel);
  const what = c.trailing ? 'Directory' : (kind === 'bare' ? 'File' : 'Path');
  const msg = `${what} "${c.path}" does not exist in the repo` + (suggestion ? `. Did you mean "${fixText}"?` : '.');
  const d = mkDiag('CD002', 'warning', rel, range.line, range.col, range.endCol, msg, {
    data: { kind: 'path', path: c.path, resolved: valid[0], parent: nearestExistingParent(ctx, valid[0]) },
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
  let arr = facts.verbs.get(verb);
  if (!arr) facts.verbs.set(verb, (arr = []));
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
    if (isProject && !(projectSub === 'link' && global)) {
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
  if (!isLiteralName(script)) return;
  const verb = VERB_SYNONYMS[script];
  addVerb(facts, verb, 'script:' + script, `${pm} ${form === 'run' ? 'run ' : ''}${script}`, src.line, toks[0].s, scriptTok.e);

  let pkgs = anyPkg ? allPackages(ctx) : pickPackages(ctx, dir);
  let fallbackAll = false;
  if (!pkgs.length) { pkgs = allPackages(ctx); fallbackAll = true; }
  if (!pkgs.length) return; // no package.json anywhere: nothing to verify against
  if (pkgs.some((p) => p.invalid)) return;
  if (pkgs.some((p) => Object.prototype.hasOwnProperty.call(p.scripts, script))) return;
  if (script === 'start' && pkgs.some((p) => hasFile(ctx, p.dir ? p.dir + '/server.js' : 'server.js'))) return;
  if (!strict) {
    if (KNOWN_JS_BINS.has(script) || allDeps(ctx).has(script)) return;
  }
  if (!anyPkg && !fallbackAll) {
    const elsewhere = allPackages(ctx).filter((p) => !p.invalid && Object.prototype.hasOwnProperty.call(p.scripts, script));
    if (elsewhere.length) return; // defined in another workspace package: docs often mean "run it there"

  }
  const names = new Set();
  for (const p of pkgs) for (const k of Object.keys(p.scripts)) names.add(k);
  const sugg = closest(script, names);
  const where = pkgs.map((p) => p.rel).slice(0, 3).join(', ');
  const d = mkDiag('CD001', strict ? 'error' : 'warning', rel, src.line, scriptTok.s, scriptTok.e,
    `Script "${script}" is not defined in ${where}` + (sugg ? `. Did you mean "${sugg}"?` : names.size ? `. Available: ${[...names].slice(0, 8).join(', ')}${names.size > 8 ? ', …' : ''}.` : ' (it has no scripts).'),
    { data: { kind: 'script', manifest: pkgs[0].rel, script } });
  if (sugg && form !== 'lifecycle') d.fix = { title: `Replace with "${sugg}"`, line: src.line, column: scriptTok.s, endLine: src.line, endColumn: scriptTok.e, newText: sugg };
  emit(d);
}

const MAKE_VALUE_FLAGS = new Set(['-C', '--directory', '-f', '--file', '--makefile', '-I', '--include-dir', '-o', '--old-file', '-W', '--what-if', '--assume-new', '-l', '--load-average', '-O', '--output-sync', '--eval']);

function checkMake(ctx, rel, src, toks, dir, emit, facts) {
  let mdir = dir;
  let mfile = null;
  const targets = [];
  for (let i = 1; i < toks.length; i++) {
    const v = toks[i].v;
    if (v === '-C' || v === '--directory') { const d = toks[++i]; if (!d) return; const n = normalizeRel(posixJoin(dir, d.v)); if (n === null || !isLiteralPath(d.v)) return; mdir = isDirRel(ctx, n) ? n : normalizeRel(d.v); if (mdir === null || !isDirRel(ctx, mdir)) return; continue; }
    if (/^-C./.test(v)) { const n = normalizeRel(posixJoin(dir, v.slice(2))); if (n === null || !isDirRel(ctx, n)) return; mdir = n; continue; }
    if (v === '-f' || v === '--file' || v === '--makefile') { const f = toks[++i]; if (!f) return; mfile = f.v; continue; }
    if (v.startsWith('--directory=')) { const n = normalizeRel(posixJoin(dir, v.slice(12))); if (n === null || !isDirRel(ctx, n)) return; mdir = n; continue; }
    if (v.startsWith('--file=') || v.startsWith('--makefile=')) { mfile = v.split('=')[1]; continue; }
    if (v.startsWith('-')) { if (MAKE_VALUE_FLAGS.has(v)) i++; else if (v === '-j' && toks[i + 1] && /^\d+$/.test(toks[i + 1].v)) i++; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) continue;
    targets.push(toks[i]);
  }
  if (!targets.length) return;
  let makefiles = [];
  if (mfile) {
    if (!isLiteralPath(mfile)) return;
    const f = normalizeRel(posixJoin(mdir, mfile));
    if (f === null) return;
    if (!hasFile(ctx, f)) {
      emit(mkDiag('CD001', 'error', rel, src.line, toks[0].s, toks[toks.length - 1].e, `\`make -f ${mfile}\`: ${f} does not exist.`, { data: { kind: 'make', manifest: null } }));
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
    emit(mkDiag('CD001', 'error', rel, src.line, toks[0].s, t.e, `\`make ${t.v}\`: the repo has no Makefile.`, { data: { kind: 'make', manifest: null } }));
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
    const all = new Set(); for (const p of parsed) for (const x of p.targets) all.add(x);
    const sugg = closest(t.v, all);
    const d = mkDiag('CD001', 'error', rel, src.line, t.s, t.e,
      `\`make ${t.v}\`: no target "${t.v}" in ${makefiles.join(', ')}` + (sugg ? `. Did you mean "${sugg}"?` : '.'), { data: { kind: 'make', manifest: makefiles[0], target: t.v } });
    if (sugg) d.fix = { title: `Replace with "${sugg}"`, line: src.line, column: t.s, endLine: src.line, endColumn: t.e, newText: sugg };
    emit(d);
  }
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
    emit(mkDiag('CD001', 'error', rel, src.line, toks[0].s, t.e, `\`just ${t.v}\`: the repo has no justfile.`, { data: { kind: 'just', manifest: null } }));
    return;
  }
  const parsed = files.map((f) => parseJustfile(ctx, f, 0));
  if (parsed.some((p) => p.uncertain)) return;
  if (parsed.some((p) => p.recipes.has(t.v) || p.modules.has(t.v))) return;
  const all = new Set(); for (const p of parsed) for (const x of p.recipes) all.add(x);
  const sugg = closest(t.v, all);
  const d = mkDiag('CD001', 'error', rel, src.line, t.s, t.e, `\`just ${t.v}\`: no recipe "${t.v}" in ${files.join(', ')}` + (sugg ? `. Did you mean "${sugg}"?` : '.'), { data: { kind: 'just', manifest: files[0], target: t.v } });
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
  if (p.tasks.has(t.v) || p.patterns.some((re) => re.test(t.v))) return;
  if (p.uncertain) return;
  const sugg = closest(t.v, p.tasks);
  emit(mkDiag('CD001', 'error', rel, src.line, t.s, t.e, `\`task ${t.v}\`: no task "${t.v}" in ${near}` + (sugg ? `. Did you mean "${sugg}"?` : '.'), { data: { kind: 'task', manifest: near, target: t.v } }));
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
      emit(mkDiag('CD001', 'error', rel, src.line, tok.s, tok.e, `\`cargo ${s} -p ${name}\`: no crate named "${name}" in the workspace` + (sugg ? `. Did you mean "${sugg}"?` : '.'), { data: { kind: 'cargo-package' } }));
    }
    if (what === 'bin' && facts2.bins.size && !facts2.bins.has(name)) {
      emit(mkDiag('CD001', 'error', rel, src.line, tok.s, tok.e, `\`cargo ${s} --bin ${name}\`: no binary target "${name}".`, { data: { kind: 'cargo-bin' } }));
    }
  }
}

const UV_VALUE_FLAGS = new Set(['--with', '--with-editable', '--with-requirements', '--extra', '--group', '--only-group', '--no-group', '--package', '--project', '--directory', '--python', '-p', '--env-file', '--index', '--index-url', '--extra-index-url', '--isolated-not', '-C', '--config-setting', '--script-not']);

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
  emit(mkDiag('CD001', 'warning', rel, src.line, t.s, t.e,
    `\`${tool} run ${x}\`: "${x}" is not a script in pyproject.toml ([project.scripts]/[tool.poetry.scripts]) and not a declared dependency.`, { data: { kind: 'py-script', manifest: py.pyprojects[0] } }));
}

/* ------------------------------------------------------------------ */
/* Workspace analysis                                                  */
/* ------------------------------------------------------------------ */

function findInstructionFiles(ctx) {
  return ctx.files.filter((f) => classifyInstructionFile(f));
}

function gitStaleness(ctx, rels) {
  const opts = ctx.options;
  const out = new Map();
  if (!rels.length) return out;
  // find .git upward
  let d = ctx.root;
  let found = false;
  for (let k = 0; k < 64; k++) {
    if (fs.existsSync(path.join(d, '.git'))) { found = true; break; }
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  if (!found) return out;
  const run = (args) => cp.execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: ctx.root, encoding: 'utf8', timeout: 4000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const log = run(['log', '--no-renames', '--format=#%ct', '--name-only', '--relative', '--', ...rels]);
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
      if (!times) times = run(['log', '--format=%ct', 'HEAD']).split('\n').filter(Boolean).map(Number);
      let n = 0;
      for (const t of times) if (t > info.ct) n++;
      info.since = n;
    }
  } catch (_) { return new Map(); }
  return out;
}

/**
 * Analyze a workspace root.
 * options: { overrides: Map<absPath, text>, ignoreRules: string[], git: boolean, now: ms, staleDays, staleCommits, context, only: [rel] }
 * Returns { root, files: [rel], diagnostics: [...] , elapsedMs }
 */
function analyzeWorkspace(root, options) {
  const t0 = Date.now();
  options = options || {};
  const ctx = options.context || createContext(root, options);
  ctx.options = Object.assign({}, ctx.options, options, { context: undefined });
  const ignore = new Set((options.ignoreRules || []).map((x) => String(x).toUpperCase()));
  const overrides = options.overrides || new Map();
  const files = findInstructionFiles(ctx);
  for (const abs of overrides.keys()) {
    const r = toPosix(path.relative(ctx.root, abs));
    if (!r.startsWith('..') && !path.isAbsolute(r) && classifyInstructionFile(r) && !files.includes(r)) files.push(r);
  }
  files.sort();
  const results = [];
  let diags = [];
  for (const rel of files) {
    const abs = path.join(ctx.root, rel);
    let text = overrides.get(abs);
    if (text === undefined) text = readFresh(path.join(ctx.root, rel));
    if (text === null || text === undefined) continue;
    let r;
    try { r = analyzeText(ctx, rel, text); } catch (e) { r = { diagnostics: [], facts: { verbs: new Map() } }; if (options.debug) throw e; }
    results.push({ rel, facts: r.facts, text });
    diags = diags.concat(r.diagnostics);
  }
  // CD005 cross-file conflicts
  if (!ignore.has('CD005')) diags = diags.concat(crossFileConflicts(results));
  // CD006 stale files
  if (!ignore.has('CD006') && options.git !== false) {
    const rels = results.map((r) => r.rel);
    const st = memo(ctx, 'git:' + rels.join('\0') + ':' + (options.staleDays || 180), () => gitStaleness(ctx, rels));
    const minCommits = options.staleCommits || 50;
    const now = options.now || Date.now();
    for (const r of results) {
      const info = st.get(r.rel);
      if (!info || info.since === null || info.since < minCommits) continue;
      const days = Math.floor((now / 1000 - info.ct) / 86400);
      const date = new Date(info.ct * 1000).toISOString().slice(0, 10);
      const first = splitLines(stripBom(r.text))[0] || '';
      const doc = { disabled: scanDocument(r.text).disabled };
      if (isDisabled(doc, 'CD006', 0)) continue;
      diags.push(mkDiag('CD006', 'info', r.rel, 0, 0, Math.max(1, first.length),
        `Last changed ${days} days ago (${date}); the repo has ${info.since} commits since. Review it for stale facts.`, { data: { kind: 'stale', days, commits: info.since } }));
    }
  }
  diags = diags.filter((d) => !ignore.has(d.ruleId));
  for (const d of diags) d.absFile = path.join(ctx.root, d.file);
  diags.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column || (a.ruleId < b.ruleId ? -1 : 1)));
  return { root: ctx.root, files, diagnostics: diags, elapsedMs: Date.now() - t0, context: ctx };
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
          out.push(mkDiag('CD005', 'info', B.rel, first.line, first.col, first.endCol,
            `${baseName(B.rel)} says \`${first.display}\` to ${verb}, but ${A.rel} says \`${cmdsA[0].display}\`. Agents get different instructions.`,
            { related: [{ file: A.rel, line: cmdsA[0].line, column: cmdsA[0].col, endColumn: cmdsA[0].endCol, message: `${A.rel}: \`${cmdsA[0].display}\`` }], data: { kind: 'conflict', verb } }));
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
  // exported for tests
  _internal: { tokenizeShell, scanDocument, parseVer, satisfiesRange, claimFitsRange, globToRegExp, parseTomlLite, parseMakefile, classifyPathCandidate },
};
