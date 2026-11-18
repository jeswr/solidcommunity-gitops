// solidcommunity.net page helpers, shared by the home page and the CSS account pages.
//  - sc.loadProfile(webId): name and photo from a public WebID profile.
//  - sc.avatar(profile): a round picture, or initials when there is no picture.
//  - When someone is logged in, the header's "Log in" / "Sign up" links become a profile menu.
(() => {
  const base = new URL('../../', document.currentScript?.src ?? location.href);

  const FOAF = 'http://xmlns.com/foaf/0.1/';
  const VCARD = 'http://www.w3.org/2006/vcard/ns#';
  const NAME = [ `${FOAF}name`, `${VCARD}fn` ];
  const PHOTO = [ `${VCARD}hasPhoto`, `${FOAF}img`, `${FOAF}depiction` ];

  function firstValue(node, predicates) {
    for (const p of predicates) {
      for (const v of [].concat(node?.[p] ?? [])) {
        const value = typeof v === 'string' ? v : v['@value'] ?? v['@id'];
        if (value) {
          return String(value);
        }
      }
    }
  }

  // Minimal fallback for servers that only send Turtle: <webId> ... foaf:name "x" / vcard:fn "x" / vcard:hasPhoto <y>.
  function fromTurtle(text, webId) {
    const literal = (re) => re.exec(text)?.[1];
    const name = literal(/(?:foaf:name|vcard:fn|<http:\/\/xmlns\.com\/foaf\/0\.1\/name>|<http:\/\/www\.w3\.org\/2006\/vcard\/ns#fn>)\s+"([^"]+)"/u);
    const photo = literal(/(?:vcard:hasPhoto|foaf:img|<http:\/\/www\.w3\.org\/2006\/vcard\/ns#hasPhoto>|<http:\/\/xmlns\.com\/foaf\/0\.1\/img>)\s+<([^>]+)>/u);
    return { name, photo: photo && new URL(photo, webId).href };
  }

  const cache = new Map();
  function loadProfile(webId) {
    if (!cache.has(webId)) {
      cache.set(webId, (async() => {
        const fallback = { webId, name: undefined, photo: undefined };
        try {
          const res = await fetch(webId, { headers: { accept: 'application/ld+json, text/turtle;q=0.8' }});
          if (!res.ok) {
            return fallback;
          }
          if (/turtle/u.test(res.headers.get('content-type') ?? '')) {
            return { ...fallback, ...fromTurtle(await res.text(), webId) };
          }
          const json = await res.json();
          const nodes = [].concat(json['@graph'] ?? json);
          const me = nodes.find((n) => n['@id'] === webId) ?? {};
          const photo = firstValue(me, PHOTO);
          return { ...fallback, name: firstValue(me, NAME), photo: photo && new URL(photo, webId).href };
        } catch {
          return fallback;
        }
      })());
    }
    return cache.get(webId);
  }

  // A readable label for a WebID without a name: the Pod's name from its address.
  function shortName(webId) {
    try {
      const url = new URL(webId);
      const path = url.pathname.split('/').filter(Boolean);
      // https://alice.example/profile/card#me -> alice ; https://example/alice/profile/card#me -> alice
      return path.length > 2 ? path[0] : url.hostname.split('.')[0];
    } catch {
      return webId;
    }
  }

  function displayName(profile) {
    return profile.name || shortName(profile.webId);
  }

  function avatar(profile, size = 32) {
    const el = document.createElement('span');
    el.className = 'avatar';
    el.style.setProperty('--size', `${size}px`);
    el.setAttribute('aria-hidden', 'true');
    const initials = displayName(profile).split(/\s+/u).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    el.textContent = initials || '?';
    if (profile.photo) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = profile.photo;
      img.addEventListener('load', () => {
        el.textContent = '';
        el.append(img);
      });
    }
    return el;
  }

  async function fetchJson(url) {
    const res = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'include' });
    return res.ok ? res.json() : {};
  }

  async function setUpHeader() {
    const nav = document.querySelector('.site-nav');
    if (!nav) {
      return;
    }
    try {
      const { controls } = await fetchJson(new URL('.account/', base));
      const accountPage = controls?.html?.account?.account;
      if (!accountPage) {
        return;
      }
      document.documentElement.classList.add('signed-in');

      const [ { webIdLinks = {} }, { pods = {} } ] = await Promise.all([
        controls.account?.webId ? fetchJson(controls.account.webId) : {},
        controls.account?.pod ? fetchJson(controls.account.pod) : {},
      ]);
      const podUrl = Object.keys(pods)[0];
      const webIds = Object.keys(webIdLinks);
      const webId = webIds.find((id) => podUrl && id.startsWith(podUrl)) ?? webIds[0];
      const profile = webId ? await loadProfile(webId) : { webId: accountPage, name: 'Your account' };

      const menu = document.createElement('div');
      menu.className = 'profile-menu';
      menu.innerHTML = `
        <button type="button" class="profile-button" aria-haspopup="true" aria-expanded="false">
          <span class="profile-name"></span>
        </button>
        <div class="profile-dropdown" hidden>
          <div class="profile-head"><strong></strong><span></span></div>
          <a href="">Your account</a>
          <a href="" data-pod>Open your Pod</a>
          <a href="" data-profile>View your profile</a>
          <button type="button" data-logout>Log out</button>
        </div>`;
      const button = menu.querySelector('.profile-button');
      button.prepend(avatar(profile, 32));
      menu.querySelector('.profile-name').textContent = displayName(profile);
      button.setAttribute('aria-label', `Account menu for ${displayName(profile)}`);
      menu.querySelector('.profile-head strong').textContent = displayName(profile);
      menu.querySelector('.profile-head span').textContent = podUrl ? new URL(podUrl).host + new URL(podUrl).pathname.replace(/\/$/u, '') : '';
      menu.querySelector('a').href = accountPage;
      const pod = menu.querySelector('[data-pod]');
      const prof = menu.querySelector('[data-profile]');
      if (podUrl) {
        pod.href = podUrl;
      } else {
        pod.remove();
      }
      if (webId) {
        prof.href = webId;
      } else {
        prof.remove();
      }

      const dropdown = menu.querySelector('.profile-dropdown');
      const toggle = (open) => {
        dropdown.hidden = !open;
        button.setAttribute('aria-expanded', String(open));
      };
      button.addEventListener('click', () => toggle(dropdown.hidden));
      document.addEventListener('click', (event) => !menu.contains(event.target) && toggle(false));
      document.addEventListener('keydown', (event) => event.key === 'Escape' && toggle(false));
      menu.querySelector('[data-logout]').addEventListener('click', async() => {
        await fetch(controls.account.logout, { method: 'POST', credentials: 'include' });
        location.href = base.href;
      });

      for (const link of nav.querySelectorAll('.when-signed-in')) {
        link.remove();
      }
      nav.append(menu);
      for (const link of document.querySelectorAll('[data-account-link]')) {
        link.href = accountPage;
      }
    } catch {
      // Leave the logged-out links in place.
    }
  }

  window.sc = { loadProfile, avatar, displayName };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setUpHeader);
  } else {
    setUpHeader();
  }
})();
