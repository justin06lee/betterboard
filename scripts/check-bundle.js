// Fails the build if the assembled bundle is missing something it requires.
// A main-process module once got added to src/ but not to the bundle, so the
// installed app threw "Cannot find module" on launch while every test — which
// runs against the repo, not the bundle — stayed green.
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
if (!root) {
  console.error('check-bundle: expected the bundle resources/app directory');
  process.exit(2);
}

const entry = path.join(root, 'src', 'main', 'main.js');
const problems = [];

function resolve(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// Walks require('./x') edges from the entry point, so anything reachable at
// runtime has to be present in the bundle.
const seen = new Set();
function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const target = resolve(file, match[1]);
    if (!target) problems.push(`${path.relative(root, file)} requires ${match[1]}, which is not in the bundle`);
    else walk(target);
  }
}

if (!fs.existsSync(entry)) {
  problems.push('src/main/main.js is missing from the bundle');
} else {
  walk(entry);
}

// The renderer is loaded by path rather than by require, so check it directly.
for (const asset of ['dist/index.html', 'dist/renderer.js', 'dist/style.css', 'package.json']) {
  if (!fs.existsSync(path.join(root, asset))) problems.push(`${asset} is missing from the bundle`);
}

if (problems.length) {
  console.error('bundle is incomplete:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`bundle ok — ${seen.size} main-process module(s), renderer assets present`);
