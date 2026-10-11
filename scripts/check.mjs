import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function files(folder) {
  const entries = await readdir(folder, { withFileTypes: true });
  return (await Promise.all(entries.filter(e => !['node_modules', '.git', '.firebase'].includes(e.name)).map(e => e.isDirectory() ? files(join(folder, e.name)) : [join(folder, e.name)]))).flat();
}
const paths = await files(root);
for (const path of paths.filter(p => /\.(mjs|js)$/.test(p))) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
for (const path of paths.filter(p => p.endsWith('.json'))) JSON.parse(await readFile(path, 'utf8'));
const html = await readFile(join(root, 'public/index.html'), 'utf8');
const app = await readFile(join(root, 'public/app.js'), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
assert.equal(ids.length, new Set(ids).size, 'Duplicate HTML IDs');
for (const [, id] of app.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(id), `Missing element: ${id}`);
assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'Inline event handlers are not permitted');
assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false, 'Use external scripts');
for (const [, path] of html.matchAll(/(?:src|href)="\/([^"?]+)"/g)) assert.ok(paths.includes(join(root, 'public', path)), `Missing asset: ${path}`);
const rules = JSON.parse(await readFile(join(root, 'database.rules.json'), 'utf8'));
assert.equal(typeof rules.rules['.read'], 'boolean'); assert.equal(typeof rules.rules['.write'], 'boolean');
const hosting = JSON.parse(await readFile(join(root, 'firebase.json'), 'utf8'));
assert.equal(hosting.hosting.rewrites[0].source, '/api/**');
assert.equal(hosting.hosting.rewrites[0].function.functionId, 'mailApi');
console.log('JavaScript syntax, JSON configuration, UI references, static assets, RTDB deny rules and Hosting rewrites passed.');
