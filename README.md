# KDDemos

Demo-booking site for [KnowDrive.ai](https://knowdrive.ai), served via GitHub Pages at **https://demos.knowdrive.ai**.

Booking is powered by a Google Calendar appointment schedule (auto-creates the event + Google Meet link). The current `index.html` is an interim page that forwards visitors to the booking calendar; the branded front-end (Claude Design, KnowDrive brand language) replaces it.

## Deploy

Static site, no build step. Pushes to `main` deploy automatically via GitHub Pages. `CNAME` pins the custom domain — don't delete it.

## Other demos

- [`/unfurl/`](https://demos.knowdrive.ai/unfurl/dashboard.html): **Corpus Unfurl**. Paste a link into iMessage, WhatsApp or Signal and it unfurls as a KnowDrive search box for one store. See [`unfurl/README.md`](unfurl/README.md).
