# Etembe Share — deployment build

A static Progressive Web App for peer-to-peer transfer of text, links, and multiple files between compatible browsers using WebRTC DataChannels.

## Included
- `index.html` — responsive UI and local styles
- `app.js` — WebRTC manual signaling, two-way text/file transfer, chunked sends, send-buffer backpressure, progress, SHA-256 integrity verification for each chunk, received-file download links, and protocol validation
- `manifest.json`, `icon.svg`, `sw.js` — PWA metadata and offline app-shell caching

## Deploy
1. Upload **all files** in this folder to the root of a static website.
2. Serve over HTTPS. Localhost is suitable for local testing; plain HTTP on a public host is not.
3. Open the site in two current browsers/devices.
4. On device A, click **Create connection offer**, then copy the complete offer text.
5. On device B, paste the offer into the offer field and click **Create receiver answer**. Copy the full answer text.
6. On device A, paste the answer and click **Apply answer & connect**.
7. Wait until both sides show that the peer is connected. On either device, select Files or Text / links, prepare content, and click **Send selected content**. Each transfer is one-way at a time; either peer can initiate a new transfer.

## What has been checked
- JavaScript syntax validation with Node.js.
- Automated browser smoke tests with Chromium should be run against the final deployed URL before announcing general availability. Local browser tests do not establish support across all mobile browsers, network types, or file sizes.

## Important limits before public launch
- **Manual pairing only:** there is no hosted signaling service, QR flow, username-based rendezvous, or automatic device discovery. Offer/answer text must be exchanged through another channel.
- **No TURN relay included:** public STUN servers are configured. Some mobile carriers, corporate networks, VPNs, and restrictive NATs will fail without a TURN relay. For reliable public availability, configure a trusted TURN provider and use credentials that are not embedded as permanent secrets in a static frontend.
- **Memory-based receive:** the app enforces a 512 MiB total batch limit because received file chunks are buffered in browser memory until each file is complete. Device memory pressure can still occur below that limit. Multi-gigabyte reliability, resumable transfer, disk streaming, and interrupted-transfer recovery are not promised.
- **No independent identity verification:** WebRTC encrypts the data channel in transit, but this static app does not authenticate the human at the other end. Exchange pairing descriptions privately and only connect to trusted recipients.
- **Integrity checks are not sender authentication.** Each received chunk is checked against a SHA-256 digest sent over the encrypted data channel, helping detect accidental/corrupt chunk delivery. A malicious connected peer can still send harmful files; there is no malware scanning, independent sender identity verification, server-side audit trail, or delivery guarantee. Check files before opening them.
- **Browser compatibility:** Bluetooth, native device APIs, guaranteed offline discovery, and universal cross-platform connectivity are not implemented. Offline app-shell loading after the first visit does not guarantee that a peer connection can be established without network connectivity.

## Release recommendation
This package is a functional browser-based transfer release candidate, not a universal production certification. Before promoting it to subscribers as dependable for all devices/networks, add TURN-backed connectivity, test on the actual supported Android/iOS/desktop browser matrix, and validate transfer size, memory use, cancellation, and failure recovery on real devices.
