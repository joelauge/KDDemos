# Privacy and data handling

## Where your files live

Source: /studio/

Files you add in KnowBot Studio are stored in KnowDrive, the document store KnowBot searches. Each trial's files are tagged with that trial, and KnowBot only answers from the trial's own files. Settings such as your bot's name and tone are saved alongside them.

## Who can open your trial bot

Source: /studio/

A trial bot is opened with a signed link that only works for that trial and stops working when the trial expires. You can copy the link, or ask for it by email where email sending is set up, to come back to your bot on another device.

## Removing files

Source: /studio/

You can remove any file from your trial bot in KnowBot Studio, and you can remove the sample files at any time. A removed file is deleted from the store and no longer used for answers.

To delete everything at once, use **Start over** in the Studio header. After you confirm, it permanently deletes your trial bot's uploaded and imported files, its settings, the conversation and the questions it logged, and the old bot's link stops working. The shared sample files are not yours, so they are never deleted. A bot that has already launched is managed from your KnowDrive account instead.

## Seven-day expiry

Source: /studio/

Trial files are kept for 7 days. After a trial expires, a cleanup job deletes its files from the store. Launching your bot keeps your files and moves them to your KnowDrive account.

## Website imports

Source: /studio/

The store and website importer only reads public pages, follows robots.txt, and only imports sites you confirm you own or manage.

## Keys and secrets

Source: /studio/

API keys are stored only as hashes, and stored provider keys are sealed with AES-256-GCM encryption. TODO(owner): state the policy on model training with customer data; nothing in the product documentation covers it yet, so the Builder must not make a claim about it.
