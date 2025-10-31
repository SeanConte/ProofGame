# →-Elim Sprint — Rules Practice

Minimal mobile-first logic game focused on Conditional Elimination (Modus Ponens) practice.

Local dev
- Open in VS Code and use Live Server or a simple static server serving the workspace root.
- Open /rules/index.html (Live Server will usually serve at http://127.0.0.1:5500/rules/)

Flip PWA on
- Edit `rules/config.js` and set `pwaEnabled: true`.
- In production, register the service worker by uncommenting the registration snippet in `rules/index.html`.

Hosting
- Deploy the project root to GitHub Pages or Netlify; ensure `/rules/` is the served path.

Embedding in Google Sites
- If embedded in an iframe, a small banner "Open full screen" appears and links to the page with `target="_top"`.

Notes
- No frameworks, small bundle. Sounds load after first interaction. Service worker is present but not registered by default.
