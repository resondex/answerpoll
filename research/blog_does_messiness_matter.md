# We gave ChatGPT 120 sloppy prompts. It didn't care.

*How we tested whether typos bias AI brand measurement - and what it means
for anyone tracking their visibility in AI answers.*

---

When you measure how AI assistants recommend brands, you face an awkward
fact: your test prompts are synthetic by construction. You write questions,
feed them to the model, and score which brands come back. The measurement is
only as good as the questions - and real buyers don't write like analysts.

We learned this the hard way. Our prompt batteries are calibrated against
1,006 verified commercial prompts sampled from WildChat, the largest public
corpus of real ChatGPT conversations. We matched the things you can measure:
length distribution (median 17 words, with a long tail of context-dumps),
capitalization habits (42% of real commercial prompts start lowercase),
punctuation (65% end with none), and the mix of question types (59% of real
commercial asks are "what's the best X" discovery questions).

Then we ran a blind test. A judge model saw pairs of prompts - one real, one
generated - and had to pick the fake. Chance is 50%. Our judge scored 28%.

Below chance is a strange result worth sitting with. It means the judge
*could* tell the sets apart - it just labeled them backwards. Real prompts,
full of typos and non-native grammar and "buy I can't choose. Help", read as
suspicious to the judge. Our generated prompts read as convincingly human
*because* they were cleaner than the real thing. We had matched everything
except the mess.

So the honest question became: does the mess matter? If AI models answer
messy questions differently than clean ones - surfacing different brands,
recommending differently - then polished test prompts would bias every
measurement built on them. Ours included.

## The experiment

We took a battery of 12 buyer-intent prompts about team messaging apps and
created a messy twin of each one. Same meaning, same details, same budgets
and team sizes - but typed the way real people type:

> **Clean:** I run IT for a quick-service restaurant chain of 20 locations.
> What chat app would work well for both managers and kitchen staff
>
> **Messy:** I run IT for a quick-service restuarant chain of 20 locatons.
> What chat app would work good for both Managers and kitchen Staff

Both batteries went through our full measurement pipeline: every prompt
asked 10 times (120 answers per condition, 240 total), every answer parsed
for brand mentions, position, and framing. Then we compared the two
conditions brand by brand, with proper multiple-comparison correction.

## The result: nothing moved

| Brand | Clean prompts | Messy prompts |
|---|---|---|
| Slack | 65% | 63% |
| Microsoft Teams | 57% | 57% |
| Signal | 48% | 49% |
| Telegram | 46% | 46% |
| Mattermost | 40% | 45% |
| Discord | 40% | 39% |
| Google Chat | 31% | 32% |

The largest gap for any brand was seven points - well inside sampling noise
(p = 0.29 before correction). Answers named 10.1 brands on average in one
condition and 10.2 in the other. The model reads "budjet" as "budget" and
answers the same question the same way.

That behavior makes sense once you consider what these models are trained
on: an internet full of typos. Spelling normalization is one of the things
they do effortlessly. The surface of the prompt is noise; the intent is the
signal, and the intent was identical by design.

## What this means for AI visibility measurement

Three things, in order of importance.

**Calibrate the dimensions that carry signal.** Prompt length, question
structure, and the mix of intent types all shape which brands an AI surfaces
- a terse "best team chat app" pulls different answers than a three-sentence
context-dump about a 25-person support team. Those dimensions are worth
calibrating against real data, and we do.

**Test the dimensions you can't match, instead of faking them.** We could
inject artificial typos into every generated prompt and claim perfect
realism. The experiment says that would be theater: it changes nothing about
the measurement while making batteries harder to read and review. The
stronger position is a disclosed difference with evidence that it's inert.

**Show the receipts.** Every number in this post comes from a reproducible
pipeline - corpus sampling with fixed seeds, per-prompt classification,
paired experimental design, stated statistical power (differences under
about 18 points would need a larger sample, and this test covered one
category). Measurement claims deserve that standard, especially in a young
field where "AI visibility" numbers often arrive with no methodology
attached.

The experiment cost about a dollar in API calls. The confidence it bought -
that our batteries measure brand visibility rather than prompt cosmetics -
is the kind of thing we think every measurement vendor should be buying.

---

*Procerno measures how AI assistants rank your brand - with sampled runs,
confidence intervals, and raw data you can download. Built by Resondex.*
