# KDDemos

Demo-booking site for [KnowDrive.ai](https://knowdrive.ai), served via GitHub Pages at **https://demos.knowdrive.ai**.

Booking is powered by a Google Calendar appointment schedule (auto-creates the event + Google Meet link). The current `index.html` is an interim page that forwards visitors to the booking calendar; the branded front-end (Claude Design, KnowDrive brand language) replaces it.

## Deploy

Static site, no build step. Pushes to `main` deploy automatically via GitHub Pages. `CNAME` pins the custom domain — don't delete it.

## Lab demos

- [`latent-fovea/`](latent-fovea/): **Foveal Latent Explorer**. A latent-space visualizer that renders and streams data like a foveated VR headset, with the heavy lifting in WebAssembly. See its README for the design.
