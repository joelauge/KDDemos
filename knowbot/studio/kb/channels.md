# Channels

## Where a KnowBot can answer

Source: /studio/

A launched KnowBot can answer on seven channels: a website chat widget, SMS, telephone (phone calls), WhatsApp, email, a voice chatbot in the browser, and homepage search. Every channel uses the same answering pipeline, so answers are cited and the refusal sentence is the same everywhere. The Channels gallery in KnowBot Studio shows each channel's webhook address and copyable setup.

## Website chat widget

Source: /studio/

The text chatbot goes on your website with one line of embed code. It can be a floating widget, an inline panel or a full-page chat. You can try the widget in KnowBot Studio before launch; on your own site it goes live after launch.

## SMS

Source: /studio/

The SMS channel works with a KnowBot number. The number's messaging webhook points at the bot's SMS webhook address. Replies are at most 320 characters, with citation numbers and a short link to the full proof of the answer.

## Telephone

Source: /studio/

The telephone (Phone) channel works with a KnowBot number and works for any KnowBot, a trial bot in KnowBot Studio or a launched bot. Callers ask out loud and hear the answer from the bot's own files only, with spoken attribution such as "According to the Returns Policy, …". When the answer is not in the files, the caller hears the same refusal sentence as on every other channel. It needs a KnowBot number, with the number's voice webhook pointed at the bot's telephone webhook address.

## Telephone voice engine

Source: /studio/

Phone calls are live voice to voice: the bot listens and speaks in real time, and before every answer it looks the question up in the bot's files and reads back the cited answer. If it ever speaks a figure, such as a price or a date, without having looked the question up, that turn is flagged as ungrounded in the bot's question insights. A call ends with a short goodbye after 15 minutes by default, and only a limited number of calls can be open at once. KnowBot runs the voice service for you, so there is nothing extra to set up. Every question asked by phone shows up in the bot's question insights under Phone.

## Texted checkout links on calls

Source: /studio/

On a phone call, a bot built from a Shopify store import can offer to text the caller a link that puts the products in their cart and opens checkout. This keeps working after the bot is launched. Bots without a Shopify store never offer texted links. One link can hold up to 5 products, so several products go in one text. It confirms the version and quantity of each product and the number first, refuses a sold-out version and offers the in-stock ones, and sends at most 3 texts per call. A link opens a new checkout with exactly the items in that link; it does not add to, or include, anything already in a cart on the store's website. Texts go to the number the caller is calling from. Another number is accepted only in the same country as the sending number, and never a premium-rate number or short code. By default one number gets at most 3 texts a day, and each bot has a daily texting cap. Each link is tagged for attribution with UTM parameters, a referral code and the call id. Texting needs a KnowBot number to send from.

## Sending an answer by email or text

Source: /studio/

On every channel, a visitor can ask the bot to send them the information, for example "can you email me that?" or "text me the info". The bot asks for an email address or a mobile number, unless the visitor already gave one, then sends its last answer from the files: the answer, the quoted lines with their sources, and the proof link. It confirms with the address partly hidden, such as "Sent to j***@example.com.", and asks again if the address does not look valid. It never sends a refusal: when nothing has been answered yet, it says there is nothing to send. On a phone call the bot offers to text the number the caller is calling from, and it reads the number back, or spells the email address back, for the caller to confirm before it sends. Emails are sent under the bot's own name from KnowBot's sending address. Texts end with "Reply STOP to opt out", and a number that replies STOP is never texted again. Each visitor can be sent a few messages an hour and each bot has a daily cap. Sends are counted in the bot's question insights, but email addresses and phone numbers are never stored there. If email is not available the bot offers a text instead, and the other way around.

## WhatsApp

Source: /studio/

The WhatsApp channel works with the Meta WhatsApp Business Cloud API. The Meta route needs a verify token, an app secret, an access token and a phone number ID from Meta. Replies carry citation numbers, numbered source footnotes and the proof link.

## Email

Source: /studio/

The email channel answers messages received through an inbound-parse webhook from SendGrid, Postmark or Mailgun. Replies include footnoted citations, the quoted lines and a list of sources. Auto-replies are ignored so no mail loops start.

## Voice chatbot in the browser

Source: /studio/

The voice chatbot lets a visitor talk to the bot in their browser and hear the answer. In KnowBot Studio, "Try it" works with no account. It uses the same live voice as phone calls: the visitor talks naturally, and the bot answers out loud from the bot's files while the sources show on screen as links.

## Homepage search

Source: /studio/

The homepage search is a simple search box that sits on top of your homepage as an overlay. It hovers over your homepage instead of replacing it: your site shows faintly behind it. It is built from the bot's own files and is kept very simple: a waving hand, the business name, one big search box with an "Ask" button, and one quiet line that says answers come only from your own pages. Visitors ask a question and get the same cited answers as the website chat, with a Sources list that links each answer to the page it came from on your website, or to the proof page for an uploaded file. When the answer is not in the files, it says the same refusal sentence as every other channel. Visitors close it with the × button in the top right corner and see your homepage as usual; a small "Ask" button stays in the bottom right corner to open it again. In KnowBot Studio (Channels, Homepage search, or the bot spec) you can change the business name and the line under the search box, upload a logo that shows under the waving hand in place of the name (suggested size 600 × 200 pixels, a PNG or SVG with a transparent background; larger images are fitted to that size), choose whether it shows until the visitor closes it (after that only the small "Ask" button shows) or on every visit, turn topic buttons under the search box on or off (they are off by default), and publish it.

## Adding the homepage search to your homepage

Source: /studio/

To add it to your homepage, paste one line of code into your homepage, just before the closing body tag, or into your website builder's custom code box. The line is a script tag that loads knowbot.knowdrive.ai/site/overlay.js with your bot id, and you can copy it from Set up in KnowBot Studio. Your own homepage stays as it is: the search box shows on top of it, and your site's styles and the search box's styles never mix. It only shows while the site is published. It also has a hosted link at knowbot.knowdrive.ai/site/ with your bot id that shows the search box over your homepage, and you can download a short how-to page with the line to paste. While the bot is a trial, the hosted link tells search engines not to list it.

## When a channel is not set up

Source: /studio/

A channel that is missing its provider settings answers with a clear "channel not configured" message instead of failing silently. Provider messages are checked with a signature when the secret is set. TODO(owner): describe how a customer supplies their own WhatsApp or email credentials after launch.
