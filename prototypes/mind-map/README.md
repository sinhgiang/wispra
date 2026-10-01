# Mind map tab — design prototype (ticket T-0004)

A clickable design prototype of the planned "Mind map" tab in a finished Meeting session.
It is a standalone page: open `index.html` in Chrome or Edge (double-click it). It does not
run inside the app, is not bundled into the installer, and never calls the AI or the network.

- `index.html` — a static copy of the Meeting session view plus the new tab (styles inline).
- `sample-data.js` — an invented 2 h 38 min planning meeting: transcript blocks and the map.
- `mindmap.js` — the dependency-free SVG renderer proposed for the real build.
- `app.js` — wiring: tabs, detail card, "Show in transcript", export, theme switch.

The dark bar at the top belongs to the prototype, not to the app.
