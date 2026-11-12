# How KnowBot proves its answers

## Citations on every answer

Source: /studio/

Every fact in a KnowBot answer has a numbered citation such as [1]. Clicking or hovering a citation opens the exact quoted line from your file, the file's name, and where in the file it is: a page, slide or row when the file has one, otherwise the atom number (for example "atom #3 of 41").

## Match scores

Source: /studio/

Each source card under an answer shows a match score from 0 to 100. The match score is the vector similarity between the question and that passage of your file. A passage found only by keyword search is labelled "keyword match" and shows no number, because KnowBot never shows a ranking score as if it were a similarity.

## The refusal sentence

Source: /studio/

When your files do not answer a question, KnowBot replies with exactly this sentence and nothing else: "Looks like we don't have that in our files." In Studio, a "Why?" view shows the closest passages it found and how far each was below the bot's floor.

## The floor

Source: /studio/

The floor is the minimum match a passage needs before KnowBot will answer from it. The default floor is 70 (a similarity of 0.70). Under "Advanced" in the spec drawer you can make the bot stricter, up to 85. The floor can only be raised, never lowered below the default.

## Proof view

Source: /studio/

By default KnowBot Studio shows each answer with a light proof layer: source chips, citation numbers and a provenance pill. The full Proof view adds the evidence strip, a claim ledger that matches every sentence to its quote, and a "How this was answered" trace. It opens on your first click or hover on a citation.

## The Proof Run

Source: /studio/

The Proof Run is KnowBot Studio's test of your bot before launch. It asks 8 questions your files should answer and 3 questions they should refuse, such as "What's the weather in Paris today?", and shows the results as a scorecard. Every test question is checked against your files before it is shown.

## Why the bot cannot be talked into guessing

Source: /studio/

KnowBot's answering model only chooses which numbered lines of your files to quote; it does not write facts of its own. Any sentence without a supporting quote is removed before the answer is shown. Instructions hidden inside a file are treated as data, not as commands.
