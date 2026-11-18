// Reads the name and photo from a public WebID profile.
// The document is parsed with N3.js and read through @solid/object / @rdfjs/wrapper typed accessors:
// no pattern matching over Turtle or JSON-LD text.
import { DataFactory, Parser, Store } from 'n3';
import { LiteralAs, NamedNodeAs, OptionalFrom } from '@rdfjs/wrapper';
import { Agent } from '@solid/object';

const FOAF = 'http://xmlns.com/foaf/0.1/';
const SCHEMA = 'http://schema.org/';
const VCARD = 'http://www.w3.org/2006/vcard/ns#';

// What N3.js can parse. Every Solid server must be able to send Turtle.
const FORMATS = new Set([ 'text/turtle', 'application/n-triples', 'application/n-quads', 'application/trig' ]);
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 8000;

// A value of the wrong kind (a literal where a link is expected) skips to the next predicate.
function first(...reads) {
  for (const read of reads) {
    try {
      const value = read();
      if (value) {
        return value;
      }
    } catch {
      // Try the next predicate.
    }
  }
}

// Same idea as the ProfileAgent reference class in the solid-object skill.
class ProfileAgent extends Agent {
  get displayName() {
    return first(
      () => OptionalFrom.subjectPredicate(this, `${VCARD}fn`, LiteralAs.string),
      () => OptionalFrom.subjectPredicate(this, `${FOAF}name`, LiteralAs.string),
      () => OptionalFrom.subjectPredicate(this, `${SCHEMA}name`, LiteralAs.string),
    );
  }

  get avatarUrl() {
    return first(
      () => OptionalFrom.subjectPredicate(this, `${VCARD}hasPhoto`, NamedNodeAs.string),
      () => OptionalFrom.subjectPredicate(this, `${FOAF}img`, NamedNodeAs.string),
      () => OptionalFrom.subjectPredicate(this, `${SCHEMA}image`, NamedNodeAs.string),
      () => OptionalFrom.subjectPredicate(this, `${FOAF}depiction`, NamedNodeAs.string),
    );
  }
}

async function readText(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    bytes += value.byteLength;
    if (bytes > MAX_BYTES) {
      await reader.cancel();
      throw new Error('Profile document is too large');
    }
    text += decoder.decode(value, { stream: true });
  }
}

export async function fetchProfileDataset(webId) {
  const res = await fetch(webId, { headers: { accept: 'text/turtle' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const format = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!res.ok || !FORMATS.has(format)) {
    throw new Error(`No RDF profile at ${webId}`);
  }
  // Relative IRIs resolve against the address the document was actually served from.
  return new Store(new Parser({ baseIRI: res.url, format }).parse(await readText(res)));
}

const cache = new Map();
export function loadProfile(webId) {
  if (!cache.has(webId)) {
    cache.set(webId, (async() => {
      try {
        const agent = new ProfileAgent(webId, await fetchProfileDataset(webId), DataFactory);
        const photo = agent.avatarUrl;
        return {
          webId,
          name: agent.displayName,
          photo: photo && /^https?:$/u.test(new URL(photo).protocol) ? photo : undefined,
          storages: [ ...agent.storageUrls ],
        };
      } catch {
        return { webId, name: undefined, photo: undefined, storages: [] };
      }
    })());
  }
  return cache.get(webId);
}
