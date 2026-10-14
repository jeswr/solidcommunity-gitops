// Helpers for test.sh: seeds a running CSS with synthetic accounts and checks a migrated
// server over HTTP. All accounts, passwords and secrets here are synthetic test values.
//
//   node e2e.mjs seed  <baseUrl> <state.json>
//   node e2e.mjs check <baseUrl> <subdomain|suffix> <state.json> <present,names> <absent,names> [--clients]
//   node e2e.mjs index <sourceInternalDir> <targetInternalDir>
import { generateKeyPairSync, createHash, randomUUID, sign } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ACCOUNTS = [
  { name: 'alice', email: 'alice@example.org', password: 'alice-pass-1' },
  { name: 'bob', email: 'bob@example.org', password: 'bob-pass-1' },
  // NSS-migrated style login.
  { name: 'carol', email: 'carol@users.css.pod', password: 'carol-pass-1' },
  // Long e-mail: its index key is over 150 characters, so CSS hashes the file name.
  {
    name: 'dave',
    email: `${'d'.repeat(64)}@a-very-long-subdomain-name-for-testing-hashed-keys.example.org`,
    password: 'dave-pass-1',
    extraPod: 'dave-two',
  },
];

const b64u = (data) => Buffer.from(data).toString('base64url');
let failures = 0;

function check(ok, text) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${text}`);
  if (!ok) {
    failures += 1;
  }
}

async function json(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${response.url} (${response.status}): ${text.slice(0, 200)}`);
  }
}

async function post(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// --- Solid-OIDC client credentials with DPoP --------------------------------------------

function dpopKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  const proof = (htm, htu, accessToken) => {
    const header = b64u(JSON.stringify({ alg: 'ES256', typ: 'dpop+jwt', jwk: { kty, crv, x, y } }));
    const claims = {
      htm, htu, iat: Math.floor(Date.now() / 1000), jti: randomUUID(),
      ...accessToken ? { ath: createHash('sha256').update(accessToken).digest('base64url') } : {},
    };
    const payload = b64u(JSON.stringify(claims));
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return `${header}.${payload}.${b64u(signature)}`;
  };
  return proof;
}

async function clientCredentialsSession(baseUrl, id, secret) {
  const config = await json(await fetch(`${baseUrl}.well-known/openid-configuration`));
  const proof = dpopKey();
  const response = await fetch(config.token_endpoint, {
    method: 'POST',
    headers: {
      'authorization': `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      'dpop': proof('POST', config.token_endpoint),
    },
    body: 'grant_type=client_credentials&scope=webid',
  });
  if (response.status !== 200) {
    return { ok: false, status: response.status };
  }
  const { access_token: token } = await json(response);
  return {
    ok: true,
    fetch: (url, init = {}) => fetch(url, {
      ...init,
      headers: { ...init.headers, authorization: `DPoP ${token}`, dpop: proof(init.method ?? 'GET', url, token) },
    }),
  };
}

// --- seed -------------------------------------------------------------------------------

async function seed(baseUrl, stateFile) {
  const state = { accounts: [] };
  for (const spec of ACCOUNTS) {
    const { authorization } = await json(await post(`${baseUrl}.account/account/`, {}));
    const auth = { authorization: `CSS-Account-Token ${authorization}` };
    const { controls } = await json(await fetch(`${baseUrl}.account/`, { headers: auth }));
    let res = await post(controls.password.create, { email: spec.email, password: spec.password }, auth);
    if (res.status !== 200) {
      throw new Error(`password for ${spec.name}: ${res.status} ${await res.text()}`);
    }
    const pod = await json(await post(controls.account.pod, { name: spec.name }, auth));
    if (spec.extraPod) {
      await json(await post(controls.account.pod, { name: spec.extraPod }, auth));
    }
    const cc = await json(await post(controls.account.clientCredentials, { name: `${spec.name}-token`, webId: pod.webId }, auth));
    state.accounts.push({ ...spec, pod: pod.pod, webId: pod.webId, ccId: cc.id, ccSecret: cc.secret });
  }

  const byName = Object.fromEntries(state.accounts.map((a) => [ a.name, a ]));
  for (const account of state.accounts) {
    const session = await clientCredentialsSession(baseUrl, account.ccId, account.ccSecret);
    if (!session.ok) {
      throw new Error(`token for ${account.name}: ${session.status}`);
    }
    const put = async (path, body, type) => {
      const r = await session.fetch(`${account.pod}${path}`, { method: 'PUT', headers: { 'content-type': type }, body });
      if (![ 200, 201, 205 ].includes(r.status)) {
        throw new Error(`PUT ${path} for ${account.name}: ${r.status} ${await r.text()}`);
      }
    };
    const owner = `<#owner> a acl:Authorization; acl:agent <${account.webId}>; acl:accessTo <PATH>; acl:mode acl:Read, acl:Write, acl:Control.\n`;
    const prefix = '@prefix acl: <http://www.w3.org/ns/auth/acl#>.\n@prefix foaf: <http://xmlns.com/foaf/0.1/>.\n';
    await put('public-note.txt', `hello from ${account.name}`, 'text/plain');
    await put('public-note.txt.acl', `${prefix}${owner.replace('PATH', './public-note.txt')}<#public> a acl:Authorization; acl:agentClass foaf:Agent; acl:accessTo <./public-note.txt>; acl:mode acl:Read.\n`, 'text/turtle');
    await put('private/secret.ttl', `<#it> <http://example.org/says> "secret of ${account.name}".\n`, 'text/turtle');
    await put('private/photo.bin', Buffer.from([ 0, 1, 2, 3, 255 ]), 'application/octet-stream');
    if (account.name === 'alice') {
      // Shared with bob by WebID: the ACL holds an absolute URL of another pod.
      await put('shared/note.ttl', '<#it> <http://example.org/says> "for bob".\n', 'text/turtle');
      await put('shared/note.ttl.acl', `${prefix}${owner.replace('PATH', './note.ttl')}<#bob> a acl:Authorization; acl:agent <${byName.bob.webId}>; acl:accessTo <./note.ttl>; acl:mode acl:Read.\n`, 'text/turtle');
    }
  }

  // A dynamic OIDC client registration (persisted under idp/adapter/Client/).
  const config = await json(await fetch(`${baseUrl}.well-known/openid-configuration`));
  const reg = await json(await post(config.registration_endpoint, {
    client_name: 'migration test app',
    redirect_uris: [ 'http://app.test.example/callback' ],
    grant_types: [ 'authorization_code', 'refresh_token' ],
    response_types: [ 'code' ],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
  }));
  state.clientId = reg.client_id;
  state.jwks = await json(await fetch(config.jwks_uri));
  writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.log(`seeded ${state.accounts.length} accounts, ${state.accounts.length + 1} pods and 1 client registration`);
}

// --- check ------------------------------------------------------------------------------

function podUrl(baseUrl, layout, name) {
  const url = new URL(baseUrl);
  return layout === 'subdomain' ? `${url.protocol}//${name}.${url.host}/` : `${baseUrl}${name}/`;
}

async function checkServer(baseUrl, layout, stateFile, present, absent, withClients) {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const byName = Object.fromEntries(state.accounts.map((a) => [ a.name, a ]));
  const config = await json(await fetch(`${baseUrl}.well-known/openid-configuration`));
  check(config.issuer === baseUrl, `issuer is ${baseUrl}`);
  const jwks = await json(await fetch(config.jwks_uri));
  check(JSON.stringify(jwks) === JSON.stringify(state.jwks), 'JWKS unchanged (same issuer signing keys)');

  const sessions = {};
  for (const name of present) {
    const account = byName[name];
    const pod = podUrl(baseUrl, layout, name);
    const login = await post(`${baseUrl}.account/login/password/`, { email: account.email, password: account.password });
    check(login.status === 200, `${name}: password login works`);
    if (login.status === 200) {
      const { authorization } = await json(login);
      const auth = { authorization: `CSS-Account-Token ${authorization}` };
      const { controls } = await json(await fetch(`${baseUrl}.account/`, { headers: auth }));
      const pods = await json(await fetch(controls.account.pod, { headers: auth }));
      check(Object.keys(pods.pods ?? {}).includes(pod), `${name}: account lists pod ${pod}`);
      const webIds = await json(await fetch(controls.account.webId, { headers: auth }));
      check(Object.keys(webIds.webIdLinks ?? {}).includes(`${pod}profile/card#me`), `${name}: account links WebID ${pod}profile/card#me`);
    }
    const wrong = await post(`${baseUrl}.account/login/password/`, { email: account.email, password: 'wrong-password' });
    check(wrong.status === 403, `${name}: wrong password rejected`);

    const card = await fetch(`${pod}profile/card`, { headers: { accept: 'text/turtle' } });
    const cardText = await card.text();
    check(card.status === 200 && cardText.includes(`<${baseUrl}>`), `${name}: profile readable, oidcIssuer is ${baseUrl}`);
    const pub = await fetch(`${pod}public-note.txt`);
    check(pub.status === 200 && (await pub.text()) === `hello from ${name}`, `${name}: public file readable anonymously`);
    const anon = await fetch(`${pod}private/secret.ttl`, { headers: { accept: 'text/turtle' } });
    check(anon.status === 401, `${name}: private file refused anonymously (${anon.status})`);

    const session = await clientCredentialsSession(baseUrl, account.ccId, account.ccSecret);
    check(session.ok, `${name}: client-credentials token issued`);
    if (session.ok) {
      sessions[name] = session;
      const own = await session.fetch(`${pod}private/secret.ttl`, { headers: { accept: 'text/turtle' } });
      check(own.status === 200 && (await own.text()).includes(`secret of ${name}`), `${name}: owner reads private file with DPoP token`);
      const bin = await session.fetch(`${pod}private/photo.bin`);
      check(Buffer.from(await bin.arrayBuffer()).equals(Buffer.from([ 0, 1, 2, 3, 255 ])), `${name}: binary file intact`);
      if (name === 'alice') {
        // The 50 MB pod quota only works if the pod root is still recognised as a storage.
        const big = await session.fetch(`${pod}too-big.bin`, {
          method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(60_000_000),
        });
        check(big.status === 413, `${name}: pod quota enforced on the migrated pod (${big.status})`);
      }
    }
  }
  for (const [ name, extra ] of Object.entries(byName).filter(([ n ]) => present.includes(n)).map(([ n, a ]) => [ n, a.extraPod ])) {
    if (extra) {
      const r = await fetch(`${podUrl(baseUrl, layout, extra)}profile/card`, { headers: { accept: 'text/turtle' } });
      check(r.status === 200, `${name}: second pod ${extra} migrated`);
    }
  }

  if (present.includes('alice')) {
    const shared = `${podUrl(baseUrl, layout, 'alice')}shared/note.ttl`;
    for (const [ name, session ] of Object.entries(sessions).filter(([ n ]) => n !== 'alice')) {
      const r = await session.fetch(shared, { headers: { accept: 'text/turtle' } });
      const expected = name === 'bob' ? 200 : 403;
      check(r.status === expected, `${name}: alice's note shared with bob -> ${r.status} (expected ${expected})`);
    }
    if (sessions.carol) {
      const r = await sessions.carol.fetch(`${podUrl(baseUrl, layout, 'alice')}private/secret.ttl`);
      check(r.status === 403, `carol: cannot read alice's private file (${r.status})`);
    }
  }

  for (const name of absent) {
    const account = byName[name];
    const login = await post(`${baseUrl}.account/login/password/`, { email: account.email, password: account.password });
    check(login.status === 403, `${name}: not migrated, login refused (${login.status})`);
    const card = await fetch(`${podUrl(baseUrl, layout, name)}profile/card`, { headers: { accept: 'text/turtle' } });
    // CSS answers 401 rather than 404 when no ACL exists, so it doesn't reveal existence.
    check([ 401, 404 ].includes(card.status), `${name}: not migrated, pod not served (${card.status})`);
    const session = await clientCredentialsSession(baseUrl, account.ccId, account.ccSecret);
    check(!session.ok, `${name}: not migrated, client credentials refused`);
  }

  const auth = new URL(config.authorization_endpoint);
  auth.search = new URLSearchParams({
    client_id: state.clientId, redirect_uri: 'http://app.test.example/callback',
    response_type: 'code', scope: 'openid webid', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
  }).toString();
  const authResponse = await fetch(auth, { redirect: 'manual' });
  const known = authResponse.status >= 300 && authResponse.status < 400;
  if (withClients) {
    check(known, `OIDC client registration kept (authorize -> ${authResponse.status})`);
  } else {
    check(!known, `OIDC client registration not copied (authorize -> ${authResponse.status})`);
  }
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// --- index --------------------------------------------------------------------------------

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      yield* files(path);
    } else {
      yield path;
    }
  }
}

/** Checks the target index holds exactly the source entries that mention target accounts. */
function checkIndex(sourceInternal, targetInternal) {
  const ids = new Set(readdirSync(join(targetInternal, 'accounts/data')).map((f) => f.replace(/\$\.json$/u, '')));
  const expected = new Map();
  for (const path of files(join(sourceInternal, 'accounts/index'))) {
    const entry = JSON.parse(readFileSync(path, 'utf8'));
    const kept = entry.payload.filter((id) => ids.has(id));
    if (kept.length > 0) {
      expected.set(relative(sourceInternal, path), kept);
    }
  }
  const actual = new Map();
  for (const path of files(join(targetInternal, 'accounts/index'))) {
    actual.set(relative(targetInternal, path), JSON.parse(readFileSync(path, 'utf8')).payload);
  }
  const same = expected.size === actual.size &&
    [ ...expected ].every(([ rel, ids ]) => JSON.stringify(actual.get(rel)) === JSON.stringify(ids));
  check(same, `target index = source index entries of the ${ids.size} migrated account(s) (${expected.size} expected, ${actual.size} present)`);
  const hashed = [ ...actual.keys() ].filter((rel) => rel.includes('$hash$')).length;
  console.log(`  (${hashed} hashed index file name(s) in the target)`);
  process.exit(failures === 0 ? 0 : 1);
}

const [ command, ...args ] = process.argv.slice(2);
if (command === 'seed') {
  await seed(args[0], args[1]);
} else if (command === 'check') {
  const list = (text) => text ? text.split(',').filter(Boolean) : [];
  await checkServer(args[0], args[1], args[2], list(args[3]), list(args[4]), args.includes('--clients'));
} else if (command === 'index') {
  checkIndex(args[0], args[1]);
} else {
  console.error('usage: e2e.mjs seed|check|index ...');
  process.exit(1);
}

