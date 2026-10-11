# Alps Trip Guide (offline PWA)
Offline-first guide for the 2027 Japan Alps & Izu road trip (members only: trip content is encrypted, see tools/build-locked.js): GPS place cards with history and nearby spots, itinerary with a "next step" banner, an offline route sketch, and an encrypted group chat (text, quick pings, hold-to-record voice messages) relayed via ntfy.sh.

- Edit the itinerary: `content/itinerary.json` (plaintext, never publish it), then run `node tools/build-locked.js` to write the encrypted `data/*.json` (items with `"placeholder": true` need filling in). Then bump `CACHE_VERSION` in `sw.js`.
- Edit places: `content/pois.json` (or `tools/build_pois.py`).
- Test hooks: `?sim=<poi-id>` simulates location, `?now=2027-09-25T10:45` simulates JST time, or use ⚙️.
- Coordinates © OpenStreetMap contributors (ODbL). Vendor libraries: see js/vendor/LICENSES.txt.
