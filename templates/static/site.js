// solidcommunity.net page helpers, shared by the home page and the CSS account pages.
//  - sc.loadProfile(webId): name and photo from a public WebID profile (see profile.js).
//  - sc.avatar(profile): a round picture, or initials when there is no picture.
//  - When someone is logged in, the header's "Log in" / "Sign up" links become a profile menu.
(() => {
  const base = new URL('../../', document.currentScript?.src ?? location.href);

  // The RDF work lives in profile.js (N3.js + typed accessors). It is loaded on first use,
  // so pages that never show a profile (log in, sign up) do not load the RDF libraries.
  const profileModule = new URL('.well-known/sc/profile.js?v=3', base);
  async function loadProfile(webId) {
    try {
      return await (await import(profileModule)).loadProfile(webId);
    } catch {
      return { webId, name: undefined, photo: undefined, storages: [] };
    }
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
