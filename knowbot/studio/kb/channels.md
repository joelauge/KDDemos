# Channels

## Where a KnowBot can answer

Source: /studio/

A launched KnowBot can answer on six channels: a website chat widget, SMS, telephone (phone calls), WhatsApp, email, and a voice chatbot in the browser. Every channel uses the same answering pipeline, so answers are cited and the refusal sentence is the same everywhere. The Channels gallery in KnowBot Studio shows each channel's webhook address and copyable setup.

## Website chat widget

Source: /studio/

The text chatbot goes on your website with one line of embed code. It can be a floating widget, an inline panel or a full-page chat. You can try the widget in KnowBot Studio before launch; on your own site it goes live after launch.

## SMS

Source: /studio/

The SMS channel uses Twilio Messaging. It needs a Twilio account, with Twilio pointed at the bot's SMS webhook address. Replies are at most 320 characters, with citation numbers and a short link to the full proof of the answer.

## Telephone

Source: /studio/

The telephone (Phone) channel uses Twilio Voice and works for any KnowBot, a trial bot in KnowBot Studio or a launched bot. Callers ask out loud and hear the answer from the bot's own files only, with spoken attribution such as "According to the Returns Policy, …". When the answer is not in the files, the caller hears the same refusal sentence as on every other channel. It needs a Twilio account, with the Twilio number's voice webhook pointed at the bot's telephone webhook address.

## Telephone voice engine

Source: /studio/

Phone calls are voice-to-voice with Gemini Live: the call audio streams to Gemini Live, which listens and speaks itself, and before every answer it looks the question up in the bot's files and reads back the cited answer. If it ever speaks a figure, such as a price or a date, without having looked the question up, that turn is flagged as ungrounded in the bot's question insights. A call ends with a short goodbye after 15 minutes by default, and only a limited number of calls can be open at once. KnowBot runs the voice service for you, so there is nothing extra to set up. Every question asked by phone shows up in the bot's question insights under Phone.

## Texted checkout links on calls

Source: /studio/

On a phone call, a bot built from a Shopify store import can offer to text the caller a link that puts the products in their cart and opens checkout. This keeps working after the bot is launched. Bots without a Shopify store never offer texted links. One link can hold up to 5 products, so several products go in one text. It confirms the version and quantity of each product and the number first, refuses a sold-out version and offers the in-stock ones, and sends at most 3 texts per call. A link opens a new checkout with exactly the items in that link; it does not add to, or include, anything already in a cart on the store's website. Texts go to the number the caller is calling from. Another number is accepted only in the same country as the sending number, and never a premium-rate number or short code. By default one number gets at most 3 texts a day, and each bot has a daily texting cap. Each link is tagged for attribution with UTM parameters, a referral code and the call id. Texting needs the Twilio account SID and a Twilio number to send from.

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
