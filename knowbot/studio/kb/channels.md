# Channels

## Where a KnowBot can answer

Source: /studio/

A launched KnowBot can answer on six channels: a website chat widget, SMS, telephone, WhatsApp, email, and a voice chatbot in the browser. Every channel uses the same answering pipeline, so answers are cited and the refusal sentence is the same everywhere. The Channels gallery in KnowBot Studio shows each channel's webhook address and copyable setup.

## Website chat widget

Source: /studio/

The text chatbot goes on your website with one line of embed code. It can be a floating widget, an inline panel or a full-page chat. You can try the widget in KnowBot Studio before launch; on your own site it goes live after launch.

## SMS

Source: /studio/

The SMS channel uses Twilio Messaging. It needs a Twilio account, with Twilio pointed at the bot's SMS webhook address. Replies are at most 320 characters, with citation numbers and a short link to the full proof of the answer.

## Telephone

Source: /studio/

The telephone channel uses Twilio Voice: callers ask out loud and hear the answer, with spoken attribution such as "According to your returns policy, …". Speech can be recognised with Google Cloud Speech-to-Text and spoken with Google Cloud Text-to-Speech when those are set up; otherwise Twilio's own speech recognition and voice are used. It needs a Twilio account.

## WhatsApp

Source: /studio/

The WhatsApp channel works with the Meta WhatsApp Business Cloud API or with Twilio WhatsApp. The Meta route needs a verify token, an app secret, an access token and a phone number ID from Meta. Replies carry citation numbers, numbered source footnotes and the proof link.

## Email

Source: /studio/

The email channel answers messages received through an inbound-parse webhook from SendGrid, Postmark or Mailgun. Replies include footnoted citations, the quoted lines and a list of sources. Auto-replies are ignored so no mail loops start.

## Voice chatbot in the browser

Source: /studio/

The voice chatbot lets a visitor talk to the bot in their browser and hear the answer. In KnowBot Studio, "Try it" works with no account. It uses Google speech services when they are configured and the browser's own speech recognition and speech synthesis otherwise.

## When a channel is not set up

Source: /studio/

A channel that is missing its provider settings answers with a clear "channel not configured" message instead of failing silently. Provider messages are checked with the provider's signature (Twilio or Meta) when the secret is set. TODO(owner): describe how a customer supplies their own Twilio, Meta, email or Google credentials after launch.
