// The round-3 review's flip probes, copied unchanged from gate/out-context-drift-r3/scratch/r3b-def.js.
module.exports = (PKG) => {
const P = () => ({ 'package.json': PKG({ build: 'x', lint: 'x' }), 'package-lock.json': '{}' });
return [
{ name: 'F01-avoid-skipping-hooks', files: { 'AGENTS.md': 'Avoid skipping hooks with `npm run commit:nohooks`.\n', ...P() }, expect: [] },
{ name: 'F02-never-ignore-by', files: { 'AGENTS.md': 'Never ignore lint errors by running `npm run lint:off`.\n', ...P() }, expect: [] },
{ name: 'F03-dont-omit-via', files: { 'AGENTS.md': "Don't omit types via `npm run build:loose`.\n", ...P() }, expect: [] },
{ name: 'F04-without-old', files: { 'AGENTS.md': 'Do not run anything without reading docs, and never `npm run nuke`.\n', ...P() }, expect: [] },
{ name: 'F05-fail-to-neg', files: { 'AGENTS.md': 'Never fail the build on purpose with `npm run break-ci`.\n', ...P() }, expect: [] },
{ name: 'F06-comma-imperative', files: { 'AGENTS.md': 'Do not edit dist/, regenerate with `npm run gen`.\n', ...P() }, expect: ['CD001:gen'] },
{ name: 'F07-instead-plain', files: { 'AGENTS.md': 'Instead of yarn, use `npm run boot`.\n', ...P() }, expect: ['CD001:boot'] },
];
};
