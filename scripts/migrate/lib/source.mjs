// Read-only access to a CSS root: a local directory or `ssh://user@host/path`.
// Only read commands (cat, test, find, du, ls) are ever run on the source, and rsync only
// ever pulls from it.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export function shellQuote(text) {
  return `'${String(text).replaceAll('\'', '\'\\\'\'')}'`;
}

function run(cmd, args, { input, allowFail = false } = {}) {
  const result = spawnSync(cmd, args, { input, maxBuffer: 1024 * 1024 * 1024 });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${cmd} exited with ${result.status}: ${result.stderr.toString().trim().slice(0, 500)}`);
  }
  return result;
}

export class Source {
  constructor(spec) {
    if (spec.startsWith('ssh://')) {
      const url = new URL(spec);
      this.remote = `${url.username ? `${decodeURIComponent(url.username)}@` : ''}${url.hostname}`;
      this.port = url.port || undefined;
      this.root = decodeURIComponent(url.pathname).replace(/\/+$/u, '') || '/';
      this.label = spec;
    } else {
      this.root = resolve(spec);
      if (!existsSync(this.root) || !statSync(this.root).isDirectory()) {
        throw new Error(`Source ${this.root} is not a directory`);
      }
      this.label = this.root;
    }
  }

  get isRemote() {
    return Boolean(this.remote);
  }

  sshArgs() {
    return [ '-o', 'BatchMode=yes', ...this.port ? [ '-p', this.port ] : [] ];
  }

  /** Runs a read-only shell command with the source root as working directory. */
  sh(command, options) {
    const script = `cd ${shellQuote(this.root)} && ${command}`;
    if (this.isRemote) {
      return run('ssh', [ ...this.sshArgs(), this.remote, script ], options);
    }
    return run('sh', [ '-c', script ], options);
  }

  /** Contents of a file relative to the root, or undefined if it doesn't exist. */
  read(rel) {
    if (!this.isRemote) {
      const path = resolve(this.root, rel);
      return existsSync(path) && statSync(path).isFile() ? readFileSync(path) : undefined;
    }
    const result = this.sh(`if [ -f ${shellQuote(rel)} ]; then cat -- ${shellQuote(rel)}; else exit 3; fi`,
      { allowFail: true });
    if (result.status === 3) {
      return undefined;
    }
    if (result.status !== 0) {
      throw new Error(`Reading ${rel} failed: ${result.stderr.toString().trim()}`);
    }
    return result.stdout;
  }

  readJson(rel) {
    const data = this.read(rel);
    return data === undefined ? undefined : JSON.parse(data.toString('utf8'));
  }

  /** Lines of output of a command (empty lines dropped). */
  lines(command) {
    return this.sh(command).stdout.toString('utf8').split('\n').filter(Boolean);
  }

  isDir(rel) {
    return this.sh(`test -d ${shellQuote(rel)}`, { allowFail: true }).status === 0;
  }

  /** rsync source argument for a directory relative to the root (with trailing slash). */
  rsyncPath(rel) {
    const path = rel ? `${this.root}/${rel}/` : `${this.root}/`;
    return this.isRemote ? `${this.remote}:${path}` : path;
  }

  /** Copies a source directory into a local directory with rsync (pull only). */
  rsync(rel, destination, filters = []) {
    const args = [ '-a', ...filters ];
    if (this.isRemote) {
      args.push('-e', [ 'ssh', ...this.sshArgs() ].join(' '));
    }
    args.push(this.rsyncPath(rel), destination.endsWith('/') ? destination : `${destination}/`);
    run('rsync', args);
  }
}
