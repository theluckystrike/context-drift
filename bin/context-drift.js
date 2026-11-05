#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const engine = require('../src/engine');

const HELP = `context-drift ${engine.VERSION}
Find statements in AGENTS.md, CLAUDE.md, GEMINI.md, .cursorrules, Copilot and
Cursor rules that no longer match the repository.

Usage: context-drift [options] [path ...]

  path                 Repo root(s) or instruction file(s). Default: current directory.

Options:
  --json               Print JSON.
  --format <fmt>       text (default) | json | github (GitHub Actions annotations).
  --fail-on <level>    error (default) | warning | info | never. Exit 1 when a finding
                       at or above this level exists.
  --ignore <ids>       Comma-separated rule ids to skip, e.g. CD005,CD006.
  --no-git             Skip CD006 (git staleness).
  --stale-days <n>     CD006 age threshold in days (default 180).
  --stale-commits <n>  CD006 commit threshold (default 50).
  -q, --quiet          Only print the summary line (text format).
  -v, --version        Print the version.
  -h, --help           Print this help.

Rules:
${Object.values(engine.RULES).map((r) => `  ${r.id} ${r.name.padEnd(22)} ${r.description}`).join('\n')}

Exit codes: 0 = clean, 1 = findings at --fail-on level, 2 = usage error.
Runs locally. No network. No telemetry.`;

const LEVEL = { error: 3, warning: 2, info: 1, never: 99 };

function parseArgs(argv) {
  const o = { paths: [], format: 'text', failOn: 'error', ignore: [], git: true, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    const name = a.split('=')[0];
    switch (name) {
      case '--json': o.format = 'json'; break;
      case '--format': o.format = val(); break;
      case '--fail-on': o.failOn = val(); break;
      case '--ignore': o.ignore.push(...val().split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)); break;
      case '--no-git': o.git = false; break;
      case '--stale-days': o.staleDays = Number(val()); break;
      case '--stale-commits': o.staleCommits = Number(val()); break;
      case '-q': case '--quiet': o.quiet = true; break;
      case '-v': case '--version': o.version = true; break;
      case '-h': case '--help': o.help = true; break;
      default:
        if (a.startsWith('-') && a !== '-') throw new Error(`Unknown option: ${a}`);
        o.paths.push(a);
    }
  }
  if (!['text', 'json', 'github'].includes(o.format)) throw new Error(`Unknown format: ${o.format}`);
  if (!(o.failOn in LEVEL)) throw new Error(`Unknown --fail-on level: ${o.failOn}`);
  for (const k of ['staleDays', 'staleCommits']) if (o[k] !== undefined && !(o[k] > 0)) throw new Error(`--${k === 'staleDays' ? 'stale-days' : 'stale-commits'} must be a positive number`);
  return o;
}

function findRootFor(file) {
  let d = path.dirname(path.resolve(file));
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  return path.dirname(path.resolve(file));
}

function ghEscapeData(s) { return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'); }
function ghEscapeProp(s) { return ghEscapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C'); }

function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { process.stderr.write(`context-drift: ${e.message}\nRun context-drift --help for usage.\n`); return 2; }
  if (o.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (o.version) { process.stdout.write(engine.VERSION + '\n'); return 0; }
  if (!o.paths.length) o.paths.push('.');

  const all = [];
  let filesChecked = 0;
  let elapsed = 0;
  const cwd = process.cwd();
  for (const p of o.paths) {
    let st;
    try { st = fs.statSync(p); } catch (_) { process.stderr.write(`context-drift: no such file or directory: ${p}\n`); return 2; }
    const opts = { ignoreRules: o.ignore, git: o.git, staleDays: o.staleDays, staleCommits: o.staleCommits };
    if (st.isDirectory()) {
      const r = engine.analyzeWorkspace(p, opts);
      filesChecked += r.files.length;
      elapsed += r.elapsedMs;
      all.push(...r.diagnostics);
    } else {
      const root = findRootFor(p);
      const rel = path.relative(root, path.resolve(p)).split(path.sep).join('/');
      const overrides = new Map();
      if (!engine.classifyInstructionFile(rel)) {
        // allow checking any markdown file explicitly
        try { overrides.set(path.resolve(p), fs.readFileSync(p, 'utf8')); } catch (_) { /* unreadable */ }
      }
      const r = engine.analyzeWorkspace(root, Object.assign({}, opts, { overrides }));
      let ds = r.diagnostics.filter((d) => d.file === rel);
      if (!engine.classifyInstructionFile(rel)) {
        const ctx = r.context;
        try { ds = engine.analyzeText(ctx, rel, fs.readFileSync(p, 'utf8')).diagnostics.filter((d) => !o.ignore.includes(d.ruleId)); } catch (_) { ds = []; }
        for (const d of ds) d.absFile = path.resolve(p);
      }
      filesChecked += 1;
      elapsed += r.elapsedMs;
      all.push(...ds);
    }
  }

  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of all) counts[d.severity]++;
  const display = (d) => path.relative(cwd, d.absFile).split(path.sep).join('/') || d.file;

  if (o.format === 'json') {
    process.stdout.write(JSON.stringify({
      version: engine.VERSION,
      filesChecked,
      counts,
      diagnostics: all.map((d) => ({
        ruleId: d.ruleId, severity: d.severity, file: display(d), line: d.line + 1, column: d.column + 1,
        endLine: d.endLine + 1, endColumn: d.endColumn + 1, message: d.message,
        ...(d.fix ? { fix: { title: d.fix.title, newText: d.fix.newText } } : {}),
        ...(d.related ? { related: d.related.map((r) => ({ file: r.file, line: r.line + 1, column: r.column + 1, message: r.message })) } : {}),
      })),
    }, null, 2) + '\n');
  } else if (o.format === 'github') {
    const cmd = { error: 'error', warning: 'warning', info: 'notice' };
    for (const d of all) {
      process.stdout.write(`::${cmd[d.severity]} file=${ghEscapeProp(display(d))},line=${d.line + 1},col=${d.column + 1},endLine=${d.endLine + 1},endColumn=${d.endColumn + 1},title=${ghEscapeProp(`Context Drift ${d.ruleId}`)}::${ghEscapeData(d.message)}\n`);
    }
    process.stdout.write(`context-drift: ${filesChecked} instruction file(s), ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info\n`);
  } else {
    if (!o.quiet) {
      for (const d of all) {
        process.stdout.write(`${display(d)}:${d.line + 1}:${d.column + 1}: ${d.severity} ${d.ruleId} ${d.message}\n`);
      }
    }
    process.stdout.write(`context-drift: ${filesChecked} instruction file(s) checked in ${elapsed} ms: ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info\n`);
  }

  const threshold = LEVEL[o.failOn];
  return all.some((d) => LEVEL[d.severity] >= threshold) ? 1 : 0;
}

if (require.main === module) {
  let code;
  try { code = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`context-drift: internal error: ${e && e.stack || e}\n`); code = 2; }
  process.exitCode = code;
}

module.exports = { main, parseArgs };
