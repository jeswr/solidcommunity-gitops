// How CSS (main @ 3cd2aca2d) lays out its key/value storage on disk with
// `css:config/storage/key-value/resource-store.json` and a file backend.
//
// - Every value is a JSON document inside the internal container (`.internal/`), written by
//   JsonResourceStorage and wrapped by MaxKeyLengthStorage, so each file holds
//   `{"key": "<full key>", "payload": <value>}`.
// - A key longer than 150 characters has its last `/` segment replaced by `$hash$<sha256 hex>`.
// - The key is joined to the container URL and mapped to a file by the ExtensionBasedMapper:
//   URL path components are percent-decoded (but encoded slashes stay `%2F`, and characters
//   that are illegal in Windows file names stay encoded), and `$.json` is appended unless the
//   name already ends in an extension that maps to application/json.
// - Accounts use WrappedIndexedStorage: `accounts/data/<accountId>` holds the whole account,
//   with nested objects under `**<type>**` keys, and `accounts/index/...` holds lists of
//   account IDs:
//     `<type>/<encodeURIComponent(id)>`                         for every non-root object
//     `<type>/<field>/<encodeURIComponent(value)>`              for every indexed field
import { createHash } from 'node:crypto';

export const MAX_KEY_LENGTH = 150;
export const HASH_PREFIX = '$hash$';

/**
 * Indexed fields per account sub-type, from the `createIndex` calls in CSS. Indexes on the
 * reference to the parent (`accountId`, `podId`) are no-ops in WrappedIndexedStorage.
 */
export const INDEXED_FIELDS = {
  password: [ 'email' ],
  webIdLink: [ 'webId' ],
  pod: [ 'baseUrl' ],
  owner: [],
  clientCredentials: [ 'label' ],
};

const FORBIDDEN = { '<': '%3C', '>': '%3E', ':': '%3A', '"': '%22', '|': '%7C', '?': '%3F', '*': '%2A' };
const FORBIDDEN_RE = /[<>:"|?*]/gu;
// Extensions that the `mime-types` package maps to application/json.
const JSON_EXTENSIONS = new Set([ 'json', 'map' ]);

/** CSS PathUtil.decodeUriPathComponents. */
export function decodeUriPathComponents(path) {
  return path
    .split(/(\/|\\|%(?:25)*(?:2f|5c))/iu)
    .map((part, i) => i % 2 === 0 ?
      decodeURIComponent(part).replaceAll(FORBIDDEN_RE, (c) => FORBIDDEN[c]) :
      part.toUpperCase())
    .join('');
}

/** MaxKeyLengthStorage: hash the last segment of a key that is too long. */
export function storedKey(key) {
  if (key.length <= MAX_KEY_LENGTH) {
    return key;
  }
  const parts = key.split('/');
  const last = parts.length - 1;
  parts[last] = `${HASH_PREFIX}${createHash('sha256').update(parts[last]).digest('hex')}`;
  return parts.join('/');
}

/** Path of a KV entry relative to the internal container directory. */
export function keyToRelPath(key) {
  let path = decodeUriPathComponents(storedKey(key));
  const ext = /\.([^./]+)$/u.exec(path)?.[1]?.toLowerCase();
  if (!ext || !JSON_EXTENSIONS.has(ext)) {
    path += '$.json';
  }
  return path;
}

export function accountDataKey(accountId) {
  return `accounts/data/${accountId}`;
}

export function indexKey(type, field, value) {
  return `accounts/index/${encodeURIComponent(type)}/${field ? `${field}/` : ''}${encodeURIComponent(String(value))}`;
}

/**
 * All index keys that CSS keeps for one account record (the `payload` of its data file).
 * Unknown sub-types only get their ID index and are reported in `unknownTypes`.
 */
export function deriveIndexKeys(account) {
  const keys = [];
  const unknownTypes = new Set();
  const walk = (obj) => {
    for (const [ prop, children ] of Object.entries(obj)) {
      const match = /^\*\*(.+)\*\*$/u.exec(prop);
      if (!match || !children || typeof children !== 'object') {
        continue;
      }
      const type = match[1];
      const fields = INDEXED_FIELDS[type];
      if (!fields) {
        unknownTypes.add(type);
      }
      for (const [ id, child ] of Object.entries(children)) {
        keys.push(indexKey(type, undefined, id));
        for (const field of fields ?? []) {
          if (child[field] !== undefined && child[field] !== null) {
            keys.push(indexKey(type, field, child[field]));
          }
        }
        walk(child);
      }
    }
  };
  walk(account);
  return { keys, unknownTypes: [ ...unknownTypes ] };
}

/** Pod base URLs of an account record. */
export function podBaseUrls(account) {
  return Object.values(account['**pod**'] ?? {}).map((pod) => pod.baseUrl);
}

/** Count logins without revealing them. */
export function loginSummary(account) {
  return {
    passwords: Object.keys(account['**password**'] ?? {}).length,
    webIds: Object.keys(account['**webIdLink**'] ?? {}).length,
    pods: Object.keys(account['**pod**'] ?? {}).length,
    clientCredentials: Object.keys(account['**clientCredentials**'] ?? {}).length,
  };
}
