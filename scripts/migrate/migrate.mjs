#!/usr/bin/env node
// Copies Community Solid Server accounts and pods from one file-backend root to another.
// See README.md in this directory. Never writes to the source; prints only counts, pod
// names and account IDs (never e-mail addresses, password hashes, secrets or file contents).
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { domainToASCII } from 'node:url';
import { parseArgs } from 'node:util';
import {
  accountDataKey, deriveIndexKeys, indexKey, keyToRelPath, loginSummary, podBaseUrls,
} from './lib/kv.mjs';
import { Layout, REWRITE_EXTENSIONS, UrlRewriter } from './lib/layout.mjs';
import { shellQuote, Source } from './lib/source.mjs';

const USAGE = `Usage:
  node scripts/migrate/migrate.mjs copy   --source <dir|ssh://user@host/path> --target <dir> (--all | --accounts a,b) [options]
  node scripts/migrate/migrate.mjs verify --target <dir> (--all | --accounts a,b) [--source <dir|ssh://…>] [options]

Accounts are selected by pod name (alice) or e-mail address (alice@example.org).

Options:
  --source-base-url <url>   Base URL of the source server (default https://solidcommunity.net/)
  --source-layout <l>       subdomain | suffix (default subdomain)
  --target-base-url <url>   Base URL of the target server (default: same as source, no rewriting)
  --target-layout <l>       subdomain | suffix (default: same as source)
  --dry-run                 Print the plan (counts and sizes) and stop
  --merge                   Allow a non-empty target; source files overwrite target files
  --names-check             Also scan the source for names Azure Files can't store (slow on big trees)
  --exact                   verify: fail if the target holds accounts that were not selected`;

// Internal (KV) sub-containers copied by --all. Everything else under .internal is
// short-lived (cookies, forgot-password, locks, notifications, idp tokens, other adapter entries).
const INTERNAL_KEEP = [ 'accounts/data', 'accounts/index', 'idp/keys', 'idp/adapter/Client', 'setup' ];
const INTERNAL_SKIP = [
  'accounts/cookies', 'accounts/forgot-password', 'locks', 'notifications', 'idp/tokens', 'idp/adapter',
];
// Top-level directories that are never pods.
const NOT_PODS = new Set([ 'www', '.internal', 'lost+found' ]);

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function maskEmail(email) {
  const [ local, domain ] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

function describeToken(token) {
  return token.includes('@') ? maskEmail(token) : token;
}

function humanBytes(kib) {
  const units = [ 'KiB', 'MiB', 'GiB', 'TiB' ];
  let value = kib;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function parseOptions() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'source': { type: 'string' },
      'target': { type: 'string' },
      'all': { type: 'boolean', default: false },
      'accounts': { type: 'string' },
      'source-base-url': { type: 'string', default: 'https://solidcommunity.net/' },
      'source-layout': { type: 'string', default: 'subdomain' },
      'target-base-url': { type: 'string' },
      'target-layout': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'merge': { type: 'boolean', default: false },
      'names-check': { type: 'boolean', default: false },
      'exact': { type: 'boolean', default: false },
      'help': { type: 'boolean', default: false },
    },
  });
  const command = positionals[0];
  if (values.help || ![ 'copy', 'plan', 'verify' ].includes(command)) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  if (values.all === Boolean(values.accounts)) {
    fail('pass exactly one of --all or --accounts');
  }
  if (!values.target) {
    fail('--target is required');
  }
  if (command !== 'verify' && !values.source) {
    fail('--source is required');
  }
  const source = new Layout(values['source-base-url'], values['source-layout']);
  const target = new Layout(values['target-base-url'] ?? source.baseUrl, values['target-layout'] ?? source.layout);
  const tokens = values.accounts ?
    [ ...new Set(values.accounts.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)) ] :
    undefined;
  return {
    command: command === 'plan' ? 'copy' : command,
    dryRun: values['dry-run'] || command === 'plan',
    merge: values.merge,
    namesCheck: values['names-check'],
    exact: values.exact,
    sourceSpec: values.source,
    targetDir: resolve(values.target),
    tokens,
    sourceLayout: source,
    targetLayout: target,
  };
}

// ---------------------------------------------------------------------------------------
// Reading accounts (works on a Source or on the local target through a Source wrapper)

function internalPath(layout, key) {
  return `${layout.internalDir}/${keyToRelPath(key)}`;
}

function readEntry(src, layout, key) {
  const entry = src.readJson(internalPath(layout, key));
  if (entry && entry.key !== key) {
    throw new Error(`KV file for ${key} holds key ${entry.key}; the on-disk format is not what this script expects`);
  }
  return entry;
}

/** Resolves pod names / e-mails to account IDs. */
function resolveAccounts(src, layout, tokens) {
  const ids = new Map();
  const missing = [];
  for (const token of tokens) {
    const key = token.includes('@') ?
      indexKey('password', 'email', token) :
      indexKey('pod', 'baseUrl', layout.podBaseUrl(token));
    const entry = readEntry(src, layout, key);
    if (!entry || !Array.isArray(entry.payload) || entry.payload.length === 0) {
      missing.push(describeToken(token));
      continue;
    }
    for (const id of entry.payload) {
      ids.set(id, [ ...ids.get(id) ?? [], describeToken(token) ]);
    }
  }
  return { ids, missing };
}

function loadAccount(src, layout, id) {
  const entry = readEntry(src, layout, accountDataKey(id));
  if (!entry) {
    throw new Error(`Account ${id} is in the index but has no data file`);
  }
  return entry.payload;
}

// ---------------------------------------------------------------------------------------
// Local target helpers

function isEmptyDir(dir) {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function* walkFiles(dir, skip = () => false) {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (skip(path, entry)) {
      continue;
    }
    if (entry.isDirectory()) {
      yield* walkFiles(path, skip);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

function extensionOf(path) {
  const name = path.split('/').pop().replace(/\$(\.[^.]+)$/u, '$1');
  return /\.([^./]+)$/u.exec(name)?.[1]?.toLowerCase();
}

/** Rewrites absolute URLs in the RDF files of a directory tree. Returns the number changed. */
function rewriteTextTree(dir, rewriter, skip) {
  let changed = 0;
  for (const path of walkFiles(dir, skip)) {
    const ext = extensionOf(path);
    if (!ext || !REWRITE_EXTENSIONS.has(ext)) {
      continue;
    }
    const text = readFileSync(path, 'utf8');
    const updated = rewriter.rewrite(text);
    if (updated !== text) {
      writeFileSync(path, updated);
      changed += 1;
    }
  }
  return changed;
}

/** Writes an index entry, merging with an existing one, after rewriting its key. */
function writeIndexEntry(targetRoot, targetLayout, rewriter, entry, keepIds) {
  const payload = entry.payload.filter((id) => !keepIds || keepIds.has(id));
  if (payload.length === 0) {
    return undefined;
  }
  const slash = entry.key.lastIndexOf('/');
  const value = decodeURIComponent(entry.key.slice(slash + 1));
  const newValue = rewriter.rewrite(value);
  const key = newValue === value ? entry.key : `${entry.key.slice(0, slash + 1)}${encodeURIComponent(newValue)}`;
  const path = join(targetRoot, internalPath(targetLayout, key));
  let merged = payload;
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8'));
    merged = [ ...new Set([ ...existing.payload, ...payload ]) ];
  }
  writeJsonFile(path, { key, payload: merged });
  return key;
}

// ---------------------------------------------------------------------------------------
// copy

function planSelected(src, opts) {
  const { ids, missing } = resolveAccounts(src, opts.sourceLayout, opts.tokens);
  if (missing.length > 0) {
    fail(`no account found for: ${missing.join(', ')}`);
  }
  const accounts = [];
  for (const [ id, matchedBy ] of ids) {
    const account = loadAccount(src, opts.sourceLayout, id);
    const { keys, unknownTypes } = deriveIndexKeys(account);
    const pods = podBaseUrls(account).map((baseUrl) => {
      const name = opts.sourceLayout.podName(baseUrl);
      if (!name) {
        throw new Error(`Pod ${baseUrl} of account ${id} is not under ${opts.sourceLayout.baseUrl}`);
      }
      return { name, baseUrl, dir: opts.sourceLayout.podDir(name) };
    });
    accounts.push({ id, matchedBy, account, indexKeys: keys, unknownTypes, pods });
  }
  return accounts;
}

function podStats(src, dirs) {
  if (dirs.length === 0) {
    return new Map();
  }
  const script = dirs.map((dir) =>
    `printf '%s\\t%s\\t%s\\n' ${shellQuote(dir)} "$(du -sk -- ${shellQuote(dir)} 2>/dev/null | cut -f1)" ` +
    `"$(find ${shellQuote(dir)} -type f 2>/dev/null | wc -l | tr -d ' ')"`).join('; ');
  return new Map(src.lines(script).map((line) => {
    const [ dir, kib, files ] = line.split('\t');
    return [ dir, { kib: Number(kib) || 0, files: Number(files) || 0, exists: kib !== '' } ];
  }));
}

function namesCheck(src) {
  // Azure Files: names are case-insensitive, at most 255 characters, can't end in a dot or
  // space, and can't contain " \ / : | < > * ? or control characters.
  const script = `find . -mindepth 1 | awk -F/ '
    { name=$NF; total++
      if (length(name) > 255) long++
      if (name ~ /[. ]$/) trailing++
      if (name ~ /["\\\\:|<>*?]/ || name ~ /[[:cntrl:]]/) bad++
      print tolower($0) > "/dev/stderr" }
    END { printf "entries=%d long=%d trailing=%d badchars=%d\\n", total, long, trailing, bad }
  ' 2>&1 >/dev/null | sort | uniq -d | wc -l | tr -d ' '; find . -mindepth 1 | awk -F/ '
    { name=$NF; total++; if (length(name) > 255) long++; if (name ~ /[. ]$/) trailing++
      if (name ~ /["\\\\:|<>*?]/ || name ~ /[[:cntrl:]]/) bad++ }
    END { printf "entries=%d long=%d trailing=%d badchars=%d\\n", total, long, trailing, bad }'`;
  const [ caseDupes, summary ] = src.lines(script);
  return `${summary} case-insensitive-duplicates=${caseDupes}`;
}

function copyCommand(opts) {
  const src = new Source(opts.sourceSpec);
  const { sourceLayout, targetLayout, targetDir } = opts;
  const rewriter = new UrlRewriter(sourceLayout, targetLayout);
  if (!src.isRemote) {
    const rel = relative(src.root, targetDir);
    if (rel === '' || !rel.startsWith('..')) {
      fail('the target must not be the source or inside it');
    }
  }
  if (!isEmptyDir(targetDir) && !opts.merge) {
    fail(`target ${targetDir} is not empty (use --merge to copy into it)`);
  }
  if (!src.isDir(sourceLayout.internalDir)) {
    fail(`source has no ${sourceLayout.internalDir}; check --source-layout and --source`);
  }

  console.log(`source: ${src.label} (${sourceLayout.layout}, ${sourceLayout.baseUrl})`);
  console.log(`target: ${targetDir} (${targetLayout.layout}, ${targetLayout.baseUrl})`);
  console.log(`url rewrite: ${rewriter.identity ? 'none (same base URL and layout)' : `${sourceLayout.baseUrl} -> ${targetLayout.baseUrl}`}`);

  return opts.tokens ? copySelected(src, opts, rewriter) : copyAll(src, opts, rewriter);
}

function copySelected(src, opts, rewriter) {
  const { sourceLayout, targetLayout, targetDir } = opts;
  const accounts = planSelected(src, opts);
  const stats = podStats(src, accounts.flatMap((a) => a.pods.map((p) => p.dir)));
  console.log(`mode: selected accounts (${accounts.length})`);
  let totalKib = 0;
  for (const a of accounts) {
    const summary = loginSummary(a.account);
    console.log(`  account ${a.id} (matched by ${a.matchedBy.join(', ')}): ${summary.passwords} password login(s), ` +
      `${summary.webIds} WebID link(s), ${summary.clientCredentials} client credential(s), ${a.indexKeys.length} index entries`);
    for (const type of a.unknownTypes) {
      console.log(`    warning: unknown record type ${type}; only its ID index is copied`);
    }
    for (const pod of a.pods) {
      const s = stats.get(pod.dir);
      if (!s?.exists) {
        console.log(`    warning: pod ${pod.name} has no directory ${pod.dir}/ in the source`);
        continue;
      }
      totalKib += s.kib;
      console.log(`    pod ${pod.name}: ${s.files} files, ${humanBytes(s.kib)}`);
    }
  }
  console.log(`  plus: idp/keys, setup markers, base-host root files; total pod data ${humanBytes(totalKib)}`);
  if (opts.namesCheck) {
    console.log(`names check (whole source): ${namesCheck(src)}`);
  }
  if (opts.dryRun) {
    console.log('dry run: nothing written');
    return;
  }

  const keep = new Set(accounts.map((a) => a.id));
  const tInternal = join(targetDir, targetLayout.internalDir);
  mkdirSync(tInternal, { recursive: true });
  let indexWritten = 0;
  let indexMissing = 0;
  for (const a of accounts) {
    writeJsonFile(join(targetDir, internalPath(targetLayout, accountDataKey(a.id))),
      { key: accountDataKey(a.id), payload: rewriter.rewriteJson(a.account) });
    for (const key of a.indexKeys) {
      const entry = readEntry(src, sourceLayout, key);
      if (!entry) {
        indexMissing += 1;
        continue;
      }
      if (writeIndexEntry(targetDir, targetLayout, rewriter, entry, keep)) {
        indexWritten += 1;
      }
    }
  }
  copyServerFiles(src, opts, rewriter, [ 'idp/keys', 'setup' ]);
  for (const a of accounts) {
    for (const pod of a.pods) {
      if (!src.isDir(pod.dir)) {
        continue;
      }
      const targetPod = targetLayout.podDir(targetLayout.podName(rewriter.rewrite(pod.baseUrl)));
      const dest = join(targetDir, targetPod);
      mkdirSync(dest, { recursive: true });
      src.rsync(pod.dir, dest);
      if (!rewriter.identity) {
        rewriteTextTree(dest, rewriter);
      }
    }
  }
  console.log(`done: ${accounts.length} account(s), ${indexWritten} index entries` +
    `${indexMissing ? ` (${indexMissing} expected index entries missing in the source)` : ''}, ` +
    `${accounts.reduce((n, a) => n + a.pods.length, 0)} pod(s)`);
}

/** Copies base-host root files and the given internal sub-containers. */
function copyServerFiles(src, opts, rewriter, internalParts) {
  const { sourceLayout, targetLayout, targetDir } = opts;
  const tBase = join(targetDir, targetLayout.baseDir);
  mkdirSync(tBase, { recursive: true });
  // Root files of the base host (e.g. .acl, index.html), not its sub-containers.
  const rootFiles = src.lines(`find ${shellQuote(sourceLayout.baseDir || '.')} -mindepth 1 -maxdepth 1 -type f -exec basename {} \\;`);
  for (const name of rootFiles) {
    const data = src.read(sourceLayout.baseDir ? `${sourceLayout.baseDir}/${name}` : name);
    const ext = extensionOf(name);
    writeFileSync(join(tBase, name), ext && REWRITE_EXTENSIONS.has(ext) ? rewriter.rewrite(data.toString('utf8')) : data);
  }
  for (const part of internalParts) {
    const from = `${sourceLayout.internalDir}/${part}`;
    if (!src.isDir(from)) {
      continue;
    }
    const dest = join(targetDir, targetLayout.internalDir, part);
    mkdirSync(dest, { recursive: true });
    src.rsync(from, dest);
  }
  if (!rewriter.identity) {
    const setupDir = join(targetDir, targetLayout.internalDir, 'setup');
    for (const path of walkFiles(setupDir)) {
      const entry = JSON.parse(readFileSync(path, 'utf8'));
      writeFileSync(path, JSON.stringify(rewriter.rewriteJson(entry)));
    }
  }
}

function copyAll(src, opts, rewriter) {
  const { sourceLayout, targetLayout, targetDir } = opts;
  const si = sourceLayout.internalDir;
  const count = (rel) => src.isDir(rel) ? Number(src.lines(`find ${shellQuote(rel)} -type f | wc -l`)[0]) : 0;
  const topDirs = src.lines('find . -mindepth 1 -maxdepth 1 -type d -exec basename {} \\;');
  const topFiles = Number(src.lines('find . -mindepth 1 -maxdepth 1 ! -type d | wc -l')[0]);
  const isSuffixSource = sourceLayout.layout === 'suffix';
  // In a suffix layout the base host's own containers sit next to the pods.
  const indexedPods = new Set(
    (src.isDir(`${si}/accounts/index/pod/baseUrl`) ?
      src.lines(`ls -1 ${shellQuote(`${si}/accounts/index/pod/baseUrl`)}`) :
      [])
      .map((file) => {
        try {
          const url = file.startsWith('$hash$') ?
            src.readJson(`${si}/accounts/index/pod/baseUrl/${file}`).key.split('/').pop() :
            file.replace(/\$\.json$/u, '');
          return sourceLayout.podName(decodeURIComponent(url));
        } catch {
          return undefined;
        }
      })
      .filter(Boolean)
      .map((name) => sourceLayout.podDir(name)),
  );
  const podDirs = topDirs.filter((d) => !NOT_PODS.has(d) && !(isSuffixSource && !indexedPods.has(d)));
  const orphans = podDirs.filter((d) => !indexedPods.has(d));
  const kept = Object.fromEntries(INTERNAL_KEEP.map((p) => [ p, count(`${si}/${p}`) ]));
  const skipped = Object.fromEntries(INTERNAL_SKIP.map((p) => [ p, count(`${si}/${p}`) ]));
  skipped['idp/adapter'] -= kept['idp/adapter/Client'];
  const sizeKib = Number(src.lines('du -sk . | cut -f1')[0]);
  console.log('mode: all');
  console.log(`  pods: ${podDirs.length} directories (${orphans.length} without a pod record in the account index)`);
  console.log(`  skipped top-level: ${topDirs.filter((d) => NOT_PODS.has(d) && d !== 'www').join(', ') || 'none'}; ` +
    `${topFiles} top-level non-directories`);
  console.log(`  internal kept: ${Object.entries(kept).map(([ k, v ]) => `${k}=${v}`).join(' ')}`);
  console.log(`  internal skipped: ${Object.entries(skipped).map(([ k, v ]) => `${k}=${v}`).join(' ')}`);
  console.log(`  source size: ${humanBytes(sizeKib)}`);
  if (opts.namesCheck) {
    console.log(`  names check: ${namesCheck(src)}`);
  }
  if (opts.dryRun) {
    console.log('dry run: nothing written');
    return;
  }

  mkdirSync(targetDir, { recursive: true });
  // Pods: every top-level directory except the base host, internal data and lost+found.
  if (isSuffixSource) {
    for (const dir of podDirs) {
      mkdirSync(join(targetDir, dir), { recursive: true });
      src.rsync(dir, join(targetDir, dir));
    }
  } else {
    // One rsync for all pods: skip the non-pod directories, keep other top-level
    // directories and drop top-level files.
    src.rsync('', targetDir, [
      ...[ ...NOT_PODS ].map((d) => `--exclude=/${d}/`),
      '--include=/*/',
      '--exclude=/*',
    ]);
  }
  copyServerFiles(src, opts, rewriter, INTERNAL_KEEP);

  const tInternal = join(targetDir, targetLayout.internalDir);
  if (!rewriter.identity) {
    // Pod directories may need renaming (Unicode subdomain -> punycode path segment).
    for (const dir of podDirs) {
      const name = domainToASCII(dir) || dir;
      const newDir = targetLayout.podDir(targetLayout.podName(rewriter.rewrite(sourceLayout.podBaseUrl(name))));
      if (newDir !== dir) {
        renameSync(join(targetDir, dir), join(targetDir, newDir));
      }
    }
    let accounts = 0;
    for (const path of walkFiles(join(tInternal, 'accounts/data'))) {
      const entry = JSON.parse(readFileSync(path, 'utf8'));
      writeFileSync(path, JSON.stringify({ key: entry.key, payload: rewriter.rewriteJson(entry.payload) }));
      accounts += 1;
    }
    const { renamed, mismatched } = rewriteIndexTree(targetDir, targetLayout, rewriter);
    if (mismatched > 0) {
      fail(`${mismatched} index files are not where this script expects them; stopping before pod rewriting`);
    }
    const internalAbs = resolve(tInternal);
    const changed = rewriteTextTree(targetDir, rewriter, (path) => resolve(path) === internalAbs);
    console.log(`rewrote ${accounts} account records, ${renamed} index entries, ${changed} RDF files`);
  }
  console.log(`done: ${podDirs.length} pod directories, ${kept['accounts/data']} accounts`);
}

/** Renames index entries whose key contains a rewritten URL. */
function rewriteIndexTree(targetDir, targetLayout, rewriter) {
  const indexDir = join(targetDir, targetLayout.internalDir, 'accounts/index');
  const entries = [];
  let mismatched = 0;
  for (const path of walkFiles(indexDir)) {
    const entry = JSON.parse(readFileSync(path, 'utf8'));
    const expected = join(targetDir, internalPath(targetLayout, entry.key));
    if (resolve(expected) !== resolve(path)) {
      mismatched += 1;
      continue;
    }
    entries.push({ path, entry });
  }
  if (mismatched > 0) {
    return { renamed: 0, mismatched };
  }
  let renamed = 0;
  for (const { path, entry } of entries) {
    rmSync(path);
    const key = writeIndexEntry(targetDir, targetLayout, rewriter, entry);
    if (key !== entry.key) {
      renamed += 1;
    }
  }
  return { renamed, mismatched };
}

// ---------------------------------------------------------------------------------------
// verify

function verifyCommand(opts) {
  const { targetDir, targetLayout } = opts;
  const tgt = new Source(targetDir);
  const problems = [];
  const problem = (text) => problems.push(text);

  let ids;
  if (opts.tokens) {
    const { ids: found, missing } = resolveAccounts(tgt, targetLayout, opts.tokens);
    for (const token of missing) {
      problem(`no account for ${token} in the target`);
    }
    ids = [ ...found.keys() ];
  } else {
    ids = tgt.isDir(`${targetLayout.internalDir}/accounts/data`) ?
      tgt.lines(`ls -1 ${shellQuote(`${targetLayout.internalDir}/accounts/data`)}`).map((f) => f.replace(/\$\.json$/u, '')) :
      [];
  }

  for (const file of [ 'idp/keys/jwks', 'setup/current-base-url' ]) {
    if (!readEntry(tgt, targetLayout, file)) {
      problem(`missing ${file}`);
    }
  }

  let pods = 0;
  let indexEntries = 0;
  for (const id of ids) {
    let account;
    try {
      account = loadAccount(tgt, targetLayout, id);
    } catch (error) {
      problem(error.message);
      continue;
    }
    const { keys } = deriveIndexKeys(account);
    for (const key of keys) {
      const entry = readEntry(tgt, targetLayout, key);
      if (!entry?.payload?.includes(id)) {
        problem(`account ${id}: index entry missing (${key.split('/').slice(2, 4).join('/')})`);
      } else {
        indexEntries += 1;
      }
    }
    for (const baseUrl of podBaseUrls(account)) {
      const name = targetLayout.podName(baseUrl);
      if (!name) {
        problem(`account ${id}: pod URL is not under ${targetLayout.baseUrl} (was the base URL rewritten?)`);
        continue;
      }
      const dir = targetLayout.podDir(name);
      const meta = tgt.read(`${dir}/.meta`)?.toString('utf8');
      if (!tgt.read(`${dir}/.acl`)) {
        problem(`pod ${name}: no root .acl`);
      }
      if (!meta?.includes(`<${baseUrl}>`)) {
        problem(`pod ${name}: root .meta does not mark <pod root> as storage`);
      }
      pods += 1;
    }
  }

  let others = 0;
  if (opts.tokens) {
    const dataDir = `${targetLayout.internalDir}/accounts/data`;
    const all = tgt.isDir(dataDir) ? tgt.lines(`ls -1 ${shellQuote(dataDir)}`).length : 0;
    others = all - ids.length;
    if (opts.exact && others > 0) {
      problem(`${others} account(s) in the target were not selected`);
    }
  }

  if (opts.sourceSpec) {
    const src = new Source(opts.sourceSpec);
    const rewriter = new UrlRewriter(opts.sourceLayout, targetLayout);
    for (const id of ids) {
      const account = readEntry(src, opts.sourceLayout, accountDataKey(id))?.payload;
      if (!account) {
        problem(`account ${id} is not in the source`);
        continue;
      }
      const expected = JSON.stringify(rewriter.rewriteJson(account));
      if (expected !== JSON.stringify(loadAccount(tgt, targetLayout, id))) {
        problem(`account ${id}: record differs from the source`);
      }
      for (const baseUrl of podBaseUrls(account)) {
        const srcDir = opts.sourceLayout.podDir(opts.sourceLayout.podName(baseUrl));
        const tgtDir = targetLayout.podDir(targetLayout.podName(rewriter.rewrite(baseUrl)));
        const [ s ] = src.lines(`find ${shellQuote(srcDir)} -type f | wc -l`);
        const [ t ] = tgt.lines(`find ${shellQuote(tgtDir)} -type f | wc -l`);
        if (Number(s) !== Number(t)) {
          problem(`pod ${srcDir}: ${s.trim()} files in the source, ${t.trim()} in the target`);
        }
      }
    }
  }

  console.log(`verified ${ids.length} account(s), ${indexEntries} index entries, ${pods} pod(s)` +
    `${opts.tokens ? `; ${others} other account(s) in the target` : ''}`);
  if (problems.length > 0) {
    for (const text of problems) {
      console.log(`  FAIL ${text}`);
    }
    process.exit(2);
  }
  console.log('OK');
}

// ---------------------------------------------------------------------------------------

const opts = parseOptions();
try {
  if (opts.command === 'verify') {
    verifyCommand(opts);
  } else {
    copyCommand(opts);
  }
} catch (error) {
  fail(error.message);
}
