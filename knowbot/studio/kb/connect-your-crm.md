# Connect your CRM

## Sending leads to your CRM

Source: /studio/

A lead is an email address or phone number someone gave your bot: they asked it to send them an answer, they texted, called or emailed it, left a message or asked for a callback. KnowBot can send every new lead to the tools you already use, the moment it is captured.

Open Stats & Leads and go to the section called Connect your CRM. You can also get there from Set up, in the Send me this card. Each service has a Connect button. Once connected you can change a few settings, send a test lead, sync past leads, read the delivery log and disconnect.

You can connect HubSpot, Salesforce, Pipedrive, Zoho CRM, Mailchimp, Constant Contact, Zapier, or any system that accepts a webhook. Only leads are sent, never plain questions. Each lead says how you got it, for example "Asked the bot to send them the answer" or "Called the bot (caller ID)".

## How to connect HubSpot

Source: /studio/

In Stats & Leads, open Connect your CRM and choose Connect next to HubSpot. Sign in to HubSpot in the window that opens, or paste a private app access token: in HubSpot go to Settings, Integrations, Private Apps, create an app with the contacts read and write scopes, and copy its access token.

Each lead becomes a HubSpot contact. KnowBot looks for an existing contact with the same email address (or the same phone number when there is no email) and updates it instead of creating a duplicate. A note on the contact holds what they asked, the links your bot sent, and how you got their details. In the settings you can choose the lifecycle stage and lead status for new contacts, a contact owner, and a property of yours to stamp as the lead source.

## How to connect Salesforce, Pipedrive or Zoho CRM

Source: /studio/

Choose Connect next to the service in Connect your CRM and sign in in the window that opens. Pipedrive can also be connected by pasting your personal API token (in Pipedrive: Personal preferences, API).

- Salesforce: each lead becomes a Lead, matched by email, with a completed task that holds the question. You can set the lead source, the company name used for new leads, and an owner. Choose Sandbox when signing in to connect a sandbox.
- Pipedrive: each lead becomes a person with a lead in your Leads Inbox (or a deal, if you prefer) and a note.
- Zoho CRM: each lead becomes a Lead, matched by email, with a note. Pick where your Zoho account lives (United States, Europe, India, Australia, Japan, Canada) before you sign in.

If a service shows "Not available yet", use the Webhook connection with Zapier or Make in the meantime.

## Mailchimp and Constant Contact

Source: /studio/

Mailchimp and Constant Contact are email marketing lists, so KnowBot is careful about consent. Asking your bot for an answer is not agreeing to marketing emails.

After you connect, choose the audience (Mailchimp) or contact list (Constant Contact) that new leads go to. By default people are added as contacts only: they are not subscribed to your marketing. In the settings you can instead have Mailchimp send its confirmation email (double opt-in), or state that you have their consent. People already on your list keep the status they have, so someone who unsubscribed stays unsubscribed.

Leads with only a phone number are skipped for these two services, because they need an email address. The delivery log shows them as "Skipped: no email address".

## Zapier, Make, n8n and webhooks

Source: /studio/

The Webhook connection sends each lead as JSON to any https address. It works today with Zapier, Make and n8n. In Zapier, start a Zap with "Webhooks by Zapier", choose "Catch Hook", copy the address Zapier gives you, and paste it into Webhook in Connect your CRM. Then choose Send a test lead so Zapier can see the fields.

When you connect a webhook, KnowBot shows a signing secret once. Every request carries an X-KnowBot-Signature header made with it, so your own system can check a lead really came from KnowBot. Zapier, Make and n8n work without it.

The Zapier row also creates an API key for the KnowBot Zapier app, for people who were invited to it.

## Test leads, past leads and the delivery log

Source: /studio/

- Send a test lead sends one clearly marked test lead (named KnowBot Test Lead) right away, so you can see where it lands.
- Sync past leads sends the leads from the last 90 days that the service has not received yet. Each lead is only ever sent once.
- The delivery log lists the last 50 deliveries with the result. If a service is down, KnowBot keeps trying for several hours. If it still fails, the lead is marked Failed with the reason, and Retry failed sends it again.
- A connection that shows Needs attention says what to do, usually to reconnect.

Connection keys and tokens are stored encrypted and are never shown again after you enter them. Disconnect stops leads going to that service.
