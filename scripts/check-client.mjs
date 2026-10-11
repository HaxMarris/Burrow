// Checks the web client's scripts, which index.html loads in order as plain scripts sharing one global scope:
// - each one parses,
// - no two declare the same top-level name,
// - nothing that runs while a script loads uses something from a script that loads after it,
// - (with ESLint installed) no undefined names and a few other likely mistakes.
// Run: node scripts/check-client.mjs   (CI installs acorn, eslint and globals first)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(process.env.TOOLS_DIR ? join(process.env.TOOLS_DIR, 'x.js') : import.meta.url);
const acorn = require('acorn');

// The scripts, in the order index.html loads them.
const html = readFileSync(join(root, 'client/index.html'), 'utf8');
const files = [...html.matchAll(/<script src="(js\/[\w.-]+\.js)"><\/script>/g)].map((m) => m[1]);
if (!files.length) fail('No js/*.js scripts found in client/index.html');

const problems = [];
const sources = files.map((f) => readFileSync(join(root, 'client', f), 'utf8'));
const asts = sources.map((code, i) => {
  try {
    return acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  } catch (err) {
    fail(`${files[i]}: ${err.message}`);
  }
});

// Top-level names, and which script declares each.
const declaredIn = new Map();
const fnBodies = new Map();
const namesOf = (pattern, out = []) => {
  if (!pattern) return out;
  if (pattern.type === 'Identifier') out.push(pattern.name);
  else if (pattern.type === 'ObjectPattern') pattern.properties.forEach((p) => namesOf(p.type === 'RestElement' ? p.argument : p.value, out));
  else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((e) => namesOf(e, out));
  else if (pattern.type === 'RestElement') namesOf(pattern.argument, out);
  else if (pattern.type === 'AssignmentPattern') namesOf(pattern.left, out);
  return out;
};
asts.forEach((ast, i) => {
  for (const node of ast.body) {
    const names = node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration' ? [node.id.name]
      : node.type === 'VariableDeclaration' ? node.declarations.flatMap((d) => namesOf(d.id)) : [];
    for (const name of names) {
      if (declaredIn.has(name)) problems.push(`${files[i]}:${node.loc.start.line}: "${name}" is already declared in ${files[declaredIn.get(name)]}`);
      else declaredIn.set(name, i);
    }
    if (node.type === 'FunctionDeclaration') fnBodies.set(node.id.name, node.body);
    // const f = () => {...} and const f = function () {...} run only when called, like declarations.
    if (node.type === 'VariableDeclaration')
      for (const d of node.declarations)
        if (d.id.type === 'Identifier' && /FunctionExpression|ArrowFunctionExpression/.test(d.init?.type ?? '')) fnBodies.set(d.id.name, d.init.body);
  }
});

// What runs while a script loads: its top-level statements, IIFEs, and the functions they call (followed).
const isFn = (n) => n && /^(FunctionExpression|ArrowFunctionExpression|FunctionDeclaration)$/.test(n.type);
function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  if (isFn(node) && !(parent?.type === 'CallExpression' && parent.callee === node)) return; // not run now
  if (node.type === 'MethodDefinition' || (node.type === 'Property' && isFn(node.value) && node.method)) return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit, node));
    else if (v && typeof v.type === 'string') walk(v, visit, node);
  }
}
function check(fileIndex, node, seen, via) {
  walk(node, (n, parent) => {
    if (n.type !== 'Identifier') return;
    if (parent?.type === 'MemberExpression' && parent.property === n && !parent.computed) return;
    if (parent?.type === 'Property' && parent.key === n && !parent.computed && !parent.shorthand) return;
    const at = declaredIn.get(n.name);
    if (at === undefined) return;
    if (at > fileIndex) problems.push(`${files[fileIndex]}:${n.loc.start.line}: uses "${n.name}" from ${files[at]}, which loads later${via ? ` (via ${via})` : ''}`);
    const called = (parent?.type === 'CallExpression' || parent?.type === 'NewExpression') && parent.callee === n;
    if (called && fnBodies.has(n.name) && !seen.has(n.name)) {
      seen.add(n.name);
      check(fileIndex, fnBodies.get(n.name), seen, via ? `${via} → ${n.name}()` : `${n.name}()`);
    }
  });
}
asts.forEach((ast, i) => {
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration') continue;
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) if (d.init && !isFn(d.init)) check(i, d.init, new Set(), null);
    } else check(i, node, new Set(), null);
  }
});

// ESLint, over all the scripts together as the browser sees them.
let linted = false;
try {
  const { Linter } = require('eslint');
  const globals = require('globals');
  const linter = new Linter({ configType: 'flat' });
  const vendor = { LivekitClient: 'readonly', QRCode: 'readonly' };
  const config = {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: { ...globals.browser, ...vendor } },
    rules: {
      'no-undef': 'error', 'no-dupe-keys': 'error', 'no-dupe-args': 'error', 'no-duplicate-case': 'error',
      'no-unreachable': 'error', 'no-const-assign': 'error', 'no-self-assign': 'error', 'no-dupe-else-if': 'error',
      'no-unsafe-finally': 'error', 'use-isnan': 'error', 'valid-typeof': 'error', 'no-func-assign': 'error',
      'no-import-assign': 'error', 'no-obj-calls': 'error', 'no-unsafe-negation': 'error', 'getter-return': 'error',
    },
  };
  // Each script is linted with the others' top-level names as globals, so lines stay true to each file.
  files.forEach((f, i) => {
    const others = Object.fromEntries([...declaredIn].filter(([, at]) => at !== i).map(([name]) => [name, 'writable']));
    const theme = { applyTheme: 'readonly' };
    for (const m of linter.verify(sources[i], { ...config, languageOptions: { ...config.languageOptions, globals: { ...config.languageOptions.globals, ...others, ...theme } } }, f))
      problems.push(`${f}:${m.line}: ${m.message} (${m.ruleId ?? 'parse'})`);
  });
  linted = true;
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

if (problems.length) fail(problems.join('\n'));
console.log(`Client scripts OK: ${files.length} files, ${declaredIn.size} top-level names${linted ? ', ESLint clean' : ' (ESLint not installed, skipped)'}.`);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
