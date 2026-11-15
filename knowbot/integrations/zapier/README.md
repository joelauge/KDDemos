# KnowBot for Zapier

A Zapier Platform CLI app with one trigger, **New Lead**: a Zap starts whenever a KnowBot captures a lead.

This app is **not published**. Until it is, KnowBot owners use Zapier through the Webhook connector: in Zapier, start a
Zap with "Webhooks by Zapier", choose "Catch Hook", and paste the hook address into Stats & Leads, Connect your CRM,
Webhook. That needs no app at all.

## What is here

| File | What it is |
| --- | --- |
| `index.js` | the app: authentication, the API key on every request, error handling |
| `authentication.js` | custom auth: one field, the bot's API key (`kb_zap_…`); the test call is `GET /me` |
| `triggers/new_lead.js` | the REST hook trigger (subscribe, unsubscribe, perform) and its polling list for samples |
| `test/` | `node --test`: the app's shape, without Zapier's servers |

## The KnowBot endpoints it calls

Base: `https://agent.knowbot.app/api/studio/zapier/v1` (override with `KNOWBOT_API_BASE` for a dev server).
All take `Authorization: Bearer kb_zap_…` (the key from the Studio: Stats & Leads, Connect your CRM, Zapier).

| Call | Purpose | Answer |
| --- | --- | --- |
| `GET /me` | auth test, connection label | `200 { id, name }`, `401` for a bad key |
| `POST /hooks` `{ hookUrl }` | subscribe a Zap | `201 { id }` |
| `DELETE /hooks/:id` | unsubscribe | `200 { ok: true }` |
| `GET /leads?limit=10` | samples / polling fallback | `200 [ lead, … ]` newest first, stable `id` |

A hook delivery is one `POST` of one lead (the same JSON as an item of `GET /leads`). If Zapier answers `410 Gone`,
KnowBot removes that hook.

## Publish it (the owner does this; nothing here has been pushed)

1. `npm install -g zapier-platform-cli` and `zapier login` (a Zapier account that will own the integration).
2. In this folder: `npm install`, then `npm test` and `zapier validate`.
3. `zapier register "KnowBot"` (once: creates the integration under your account and writes `.zapierapprc`; do not commit it).
4. `zapier push` uploads this version. It is private: only you can use it.
5. Try it: in KnowBot Studio create an API key (Stats & Leads, Connect your CRM, Zapier), then in Zapier make a Zap
   with KnowBot, New Lead. Use Send a test lead in the Studio.
6. Share it before it is public: `zapier users:add someone@example.com 1.0.0` (an invite link), or
   `zapier users:links` for a shareable link.
7. To list it in Zapier's app directory: fill in the integration's name, logo, description and category in the Zapier
   developer dashboard, then submit it for review (`zapier promote 1.0.0` once approved). Zapier asks for a test
   account for the reviewer, working samples, and a number of live users before it leaves beta; check their current
   publishing requirements when you submit.

When `zapier-platform-core` moves on, update the pinned version in `package.json` (`zapier validate` says if it is too old).
