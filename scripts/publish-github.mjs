// 通过 GitHub REST API 发布：把本地 git 历史（含每个提交的时间/作者）重放到远端仓库，
// 建好 v* 标签，并创建 Release、上传发布文件。
//
// 适用场景：所在网络能访问 api.github.com / uploads.github.com，但 github.com:443 被阻断，
// 无法直接 `git push` 的时候。
//
// 用法：
//   GH_TOKEN=xxx node scripts/publish-github.mjs \
//     --repo Jnternet/file_sharer --tag v0.1.0 --artifacts dist [--branch main] [--notes-file CHANGELOG.md]

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';

function parseArgs(argv) {
  const args = { branch: 'main', notesFile: 'CHANGELOG.md' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!key || argv[i + 1] === undefined) {
      throw new Error(`参数格式错误：${argv[i]}`);
    }
    args[key] = argv[i + 1];
  }
  for (const required of ['repo', 'tag']) {
    if (!args[required]) {
      throw new Error(`缺少参数 --${required}`);
    }
  }
  const [owner, name] = args.repo.split('/');
  if (!owner || !name) {
    throw new Error('--repo 需要 owner/name 形式');
  }
  return { ...args, owner, name };
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const token = process.env.GH_TOKEN;
  if (!token) {
    throw new Error('请通过环境变量 GH_TOKEN 提供 GitHub token');
  }

  const request = async (url, { method = 'GET', body, contentType = 'application/json' } = {}) => {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'file-sharer-publish',
        ...(body ? { 'Content-Type': contentType } : {}),
      },
      body,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    return { ok: response.ok, status: response.status, payload };
  };

  const api = async (path, init) => {
    const result = await request(`${API}${path}`, init);
    if (!result.ok) {
      throw new Error(`${init?.method ?? 'GET'} ${path} -> ${result.status} ${JSON.stringify(result.payload).slice(0, 300)}`);
    }
    return result.payload;
  };

  const repoPath = `/repos/${options.owner}/${options.name}`;

  // ---- 1) 读取本地提交（含作者/提交时间） ----
  const logFormat = '%H%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s%x1f%b%x1e';
  const rawLog = git('log', '--reverse', `--format=${logFormat}`, options.branch).toString('utf8');
  const commits = rawLog
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, authorName, authorEmail, authorDate, committerName, committerEmail, committerDate, subject, body] =
        record.split('\x1f');
      return {
        hash,
        authorName,
        authorEmail,
        authorDate,
        committerName,
        committerEmail,
        committerDate,
        message: body?.trim() ? `${subject}\n\n${body.trim()}` : subject,
      };
    });
  console.log(`本地分支 ${options.branch} 共 ${commits.length} 个提交`);

  // ---- 2) 上传对象（按 git 对象哈希去重） ----
  const blobCache = new Map();
  const uploadBlob = async (gitSha) => {
    if (!blobCache.has(gitSha)) {
      const content = git('cat-file', 'blob', gitSha);
      const created = await api(`${repoPath}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
      });
      blobCache.set(gitSha, created.sha);
    }
    return blobCache.get(gitSha);
  };

  // ---- 3) 逐个提交重放 ----
  let parentSha = null;
  let lastCommit = null;
  for (const commit of commits) {
    const listing = git('ls-tree', '-r', '-z', commit.hash).toString('utf8').split('\0').filter(Boolean);
    const tree = [];
    for (const line of listing) {
      const [meta, path] = line.split('\t');
      const [mode, type, sha] = meta.split(' ');
      if (type !== 'blob') {
        continue; // 本项目没有子模块/子树
      }
      tree.push({ path, mode, type: 'blob', sha: await uploadBlob(sha) });
    }
    const createdTree = await api(`${repoPath}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ tree }),
    });
    const createdCommit = await api(`${repoPath}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: commit.message,
        tree: createdTree.sha,
        parents: parentSha ? [parentSha] : [],
        author: { name: commit.authorName, email: commit.authorEmail, date: commit.authorDate },
        committer: { name: commit.committerName, email: commit.committerEmail, date: commit.committerDate },
      }),
    });
    parentSha = createdCommit.sha;
    lastCommit = commit;
    console.log(`  ${commit.hash.slice(0, 8)} → ${createdCommit.sha.slice(0, 8)}  ${commit.message.split('\n')[0]}`);
  }

  // ---- 4) 更新分支引用 ----
  const refPath = `${repoPath}/git/refs/heads/${options.branch}`;
  const existingRef = await request(`${API}${refPath}`);
  if (existingRef.ok) {
    await api(refPath, { method: 'PATCH', body: JSON.stringify({ sha: parentSha, force: true }) });
    console.log(`已更新分支 ${options.branch}`);
  } else {
    await api(`${repoPath}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${options.branch}`, sha: parentSha }),
    });
    console.log(`已创建分支 ${options.branch}`);
  }

  // ---- 5) 打标签 ----
  const tagObject = await api(`${repoPath}/git/tags`, {
    method: 'POST',
    body: JSON.stringify({
      tag: options.tag,
      message: `file_sharer ${options.tag}`,
      object: parentSha,
      type: 'commit',
      tagger: {
        name: lastCommit.committerName,
        email: lastCommit.committerEmail,
        date: new Date().toISOString(),
      },
    }),
  });
  const existingTag = await request(`${API}${repoPath}/git/refs/tags/${options.tag}`);
  if (existingTag.ok) {
    await api(`${repoPath}/git/refs/tags/${options.tag}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: tagObject.sha, force: true }),
    });
  } else {
    await api(`${repoPath}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/tags/${options.tag}`, sha: tagObject.sha }),
    });
  }
  console.log(`已创建标签 ${options.tag}`);

  // ---- 6) 创建 Release 并上传产物 ----
  const notes = extractNotes(options.notesFile, options.tag);
  const releaseBody = {
    tag_name: options.tag,
    name: `file_sharer ${options.tag}`,
    body: notes,
    draft: false,
    prerelease: false,
  };
  const existingRelease = await request(`${API}${repoPath}/releases/tags/${options.tag}`);
  const release = existingRelease.ok
    ? await api(`${repoPath}/releases/${existingRelease.payload.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: releaseBody.name, body: notes }),
      })
    : await api(`${repoPath}/releases`, { method: 'POST', body: JSON.stringify(releaseBody) });
  console.log(`${existingRelease.ok ? '已更新' : '已创建'} Release：${release.html_url}`);

  if (options.artifacts) {
    const directory = resolve(ROOT, options.artifacts);
    for (const file of readdirSync(directory)) {
      const path = join(directory, file);
      if (!statSync(path).isFile()) {
        continue;
      }
      const existing = release.assets?.find((asset) => asset.name === basename(path));
      if (existing) {
        console.log(`  跳过已存在的产物 ${file}`);
        continue;
      }
      const result = await request(
        `${UPLOADS}/repos/${options.owner}/${options.name}/releases/${release.id}/assets?name=${encodeURIComponent(file)}`,
        { method: 'POST', body: readFileSync(path), contentType: 'application/octet-stream' },
      );
      if (!result.ok && result.status !== 422) {
        throw new Error(`上传 ${file} 失败：${result.status} ${JSON.stringify(result.payload).slice(0, 200)}`);
      }
      console.log(`  已上传 ${file}（${(statSync(path).size / 1024 / 1024).toFixed(2)} MB）`);
    }
  }

  console.log(`完成：https://github.com/${options.owner}/${options.name}/releases/tag/${options.tag}`);
}

/** 从 CHANGELOG 中取出对应版本的段落；找不到就返回空。 */
function extractNotes(notesFile, tag) {
  const version = tag.replace(/^v/, '');
  try {
    const text = readFileSync(resolve(ROOT, notesFile), 'utf8');
    const lines = text.split('\n');
    const start = lines.findIndex((line) => line.startsWith(`## ${version}`));
    if (start === -1) {
      return '';
    }
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => line.startsWith('## '));
    return rest.slice(0, end === -1 ? rest.length : end).join('\n').trim();
  } catch {
    return '';
  }
}

main().catch((error) => {
  console.error(`发布失败：${error.message}`);
  process.exitCode = 1;
});
