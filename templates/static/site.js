// Shows "Your account" instead of "Log in" / "Sign up" when someone is already logged in.
// Uses the same account API (/.account/) as the CSS login pages; no cookies are read here.
(async() => {
  const base = new URL('../../', document.currentScript?.src ?? location.href);
  try {
    const res = await fetch(new URL('.account/', base), {
      headers: { accept: 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) {
      return;
    }
    const { controls } = await res.json();
    const account = controls?.html?.account?.account;
    if (account) {
      for (const link of document.querySelectorAll('[data-account-link]')) {
        link.href = account;
      }
      document.documentElement.classList.add('signed-in');
    }
  } catch {
    // Leave the logged-out links in place.
  }
})();
