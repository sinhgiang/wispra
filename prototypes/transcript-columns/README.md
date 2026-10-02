# Four-column Transcript — design prototype (ticket T-0021)

A clickable design prototype of the planned four-column Transcript tab of a finished
Meeting session: time and speaker, topic, transcript, action items. It is a standalone
page: open `index.html` in Chrome or Edge (double-click it). It does not run inside the
app, is not bundled into the installer, and never calls the AI or the network.

- `index.html` — a static copy of the Meeting session view with the new layout (styles inline).
- `sample-data.js` — an invented 42-minute planning meeting in Vietnamese: paragraphs,
  speakers, topics and action items.
- `app.js` — wiring: builds the columns, jump-to-paragraph, theme / window size switches.

The dark bar at the top belongs to the prototype, not to the app. Its "Window" switch
shows the three layouts: four columns (large), topic as a heading row (1100 × 680 and
similar), and action items in a slide-over panel (the default 900 × 600 window).
