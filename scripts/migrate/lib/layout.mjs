// Where CSS puts things on disk for a base URL and identifier strategy, and how URLs move
// when the base URL or the identifier strategy changes.
//
// subdomain (css:config/util/identifiers/subdomain.json, SubdomainExtensionBasedMapper):
//   https://example.org/...        -> <root>/www/...
//   https://alice.example.org/...  -> <root>/alice/...   (punycode labels become Unicode)
// suffix (css:config/util/identifiers/suffix.json, ExtensionBasedMapper):
//   https://example.org/...        -> <root>/...
//   https://example.org/alice/...  -> <root>/alice/...
import { domainToASCII, domainToUnicode } from 'node:url';

export const LAYOUTS = [ 'subdomain', 'suffix' ];

function ensureSlash(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

function escapeRe(text) {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export class Layout {
  constructor(baseUrl, layout) {
    if (!LAYOUTS.includes(layout)) {
      throw new Error(`Unknown layout ${layout}, expected one of ${LAYOUTS.join(', ')}`);
    }
    this.baseUrl = ensureSlash(baseUrl);
    this.layout = layout;
    const url = new URL(this.baseUrl);
    if (url.pathname !== '/') {
      throw new Error(`Base URLs with a path are not supported: ${baseUrl}`);
    }
    this.scheme = url.protocol;
    this.host = url.host;
  }

  /** Directory (relative to the root) that holds the base host's resources. */
  get baseDir() {
    return this.layout === 'subdomain' ? 'www' : '';
  }

  /** Directory (relative to the root) of the internal KV container. */
  get internalDir() {
    return this.baseDir ? `${this.baseDir}/.internal` : '.internal';
  }

  /** Base URL of a pod with the given (ASCII) name. */
  podBaseUrl(name) {
    if (this.layout === 'subdomain') {
      return `${this.scheme}//${domainToASCII(name) || name}.${this.host}/`;
    }
    return `${this.baseUrl}${encodeURIComponent(name)}/`;
  }

  /** Pod name (ASCII form) from a pod base URL, or undefined if it isn't a pod root here. */
  podName(podBaseUrl) {
    const url = new URL(podBaseUrl);
    if (url.protocol !== this.scheme) {
      return undefined;
    }
    if (this.layout === 'subdomain') {
      const suffix = `.${this.host}`;
      if (url.pathname !== '/' || !url.host.endsWith(suffix)) {
        return undefined;
      }
      const label = url.host.slice(0, -suffix.length);
      return label.includes('.') ? undefined : label;
    }
    if (url.host !== this.host) {
      return undefined;
    }
    const match = /^\/([^/]+)\/$/u.exec(url.pathname);
    return match ? decodeURIComponent(match[1]) : undefined;
  }

  /** Directory (relative to the root) of a pod with the given (ASCII) name. */
  podDir(name) {
    return this.layout === 'subdomain' ? domainToUnicode(name) || name : name;
  }
}

/**
 * Rewrites absolute URLs of a subdomain-layout source server to a target server.
 * Matches the base host and any single-label subdomain of it (a pod), with or without a
 * trailing slash, and always emits the target URL with a trailing slash.
 */
export class UrlRewriter {
  constructor(source, target) {
    this.source = source;
    this.target = target;
    this.identity = source.baseUrl === target.baseUrl && source.layout === target.layout;
    if (!this.identity && source.layout !== 'subdomain') {
      throw new Error('Changing the base URL is only supported from a subdomain-layout source.');
    }
    const scheme = escapeRe(source.scheme);
    const host = escapeRe(source.host);
    this.regex = new RegExp(
      `(?<![\\w.+-])${scheme}//(?:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\\.)?${host}(?![\\w.:-])/?`,
      'giu',
    );
  }

  rewrite(text) {
    if (this.identity) {
      return text;
    }
    return text.replace(this.regex, (_, label) => {
      if (!label || label.toLowerCase() === 'www') {
        return this.target.baseUrl;
      }
      return this.target.podBaseUrl(label.toLowerCase());
    });
  }

  /** Deep-rewrites every string in a JSON value. */
  rewriteJson(value) {
    if (this.identity) {
      return value;
    }
    if (typeof value === 'string') {
      return this.rewrite(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.rewriteJson(item));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([ k, v ]) => [ k, this.rewriteJson(v) ]));
    }
    return value;
  }
}

/** Pod files whose contents are rewritten when the base URL changes (RDF serialisations). */
export const REWRITE_EXTENSIONS = new Set([ 'acl', 'meta', 'ttl', 'n3', 'nt', 'nq', 'trig', 'jsonld' ]);
