# Before announcing Etembe Share

- [ ] Deploy the entire folder to the Vercel project root (or another HTTPS static host).
- [ ] Confirm the deployed homepage, `app.js`, `manifest.json`, and service worker return HTTP 200.
- [ ] Pair two real devices and confirm both sides show a connected state.
- [ ] Transfer a small text file, a zero-byte file, a photo, and multiple files in each direction.
- [ ] Test Android Chrome and iOS Safari plus desktop browsers you officially support.
- [ ] Test the actual mobile/carrier/VPN networks your subscribers use.
- [ ] Test the largest supported batch (the app enforces a 512 MiB total batch limit).
- [ ] Configure a TURN relay before promising reliable connectivity across restrictive networks.

The included automated validation checks the package structure and JavaScript syntax. It is not a substitute for the real-device/network checks above. The current app has manual offer/answer pairing, no TURN relay, SHA-256 per-chunk integrity checks, and memory-based receiving with a 512 MiB batch limit; see README.md.
