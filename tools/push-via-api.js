'use strict';
// 用 GitHub API 推送提交（当 git 的 HTTPS 通道被代理挡住时的备选路径）。
// 用法: node tools/push-via-api.js
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const REPO = process.env.GH_REPO || 'liumingyangrd/lumen-os';

function api(args, input) {
  const opts = { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 };
  if (input !== undefined) {
    const tmp = path.join(ROOT, '.gh-api-input.json');
    fs.writeFileSync(tmp, JSON.stringify(input));
    args = args.concat(['--input', tmp]);
  }
  let out;
  try {
    const ghPath = fs.existsSync('C:/Program Files/GitHub CLI/gh.exe') ? 'C:/Program Files/GitHub CLI/gh.exe' : 'gh';
    out = execFileSync(ghPath, ['api'].concat(args), opts);
  } catch (e) {
    console.error('API 调用失败:', ['api'].concat(args).join(' '));
    console.error(String(e.stderr || e.message).slice(0, 600));
    process.exit(1);
  }
  fs.existsSync(path.join(ROOT, '.gh-api-input.json')) && fs.unlinkSync(path.join(ROOT, '.gh-api-input.json'));
  return out ? JSON.parse(out) : null;
}

const changes = execFileSync('git', ['diff', '--name-status', 'HEAD~1', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean).map((l) => l.split('\t'));

console.log('待推送的变更：');
for (const c of changes) console.log('  ' + c.join('  '));

const ref = api(['repos/' + REPO + '/git/ref/heads/main']);
const parentSha = ref.object.sha;
const parent = api(['repos/' + REPO + '/git/commits/' + parentSha]);
const baseTree = parent.tree.sha;

const tree = [];
for (const [status, ...paths] of changes) {
  const p = paths[paths.length - 1];
  if (status.startsWith('D')) { tree.push({ path: p, mode: '100644', type: 'blob', sha: null }); continue; }
  const data = fs.readFileSync(path.join(ROOT, p));
  const blob = api(['repos/' + REPO + '/git/blobs'], {
    content: data.toString('base64'),
    encoding: 'base64'
  });
  console.log('  blob ' + p + '  ' + data.length + ' B');
  tree.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha });
}

const newTree = api(['repos/' + REPO + '/git/trees'], { base_tree: baseTree, tree });
const msg = execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: ROOT, encoding: 'utf8' }).trim();
const commit = api(['repos/' + REPO + '/git/commits'], {
  message: msg,
  tree: newTree.sha,
  parents: [parentSha]
});
api(['repos/' + REPO + '/git/refs/heads/main', '--method', 'PATCH'], { sha: commit.sha, force: false });
console.log('已推送提交 ' + commit.sha);
