# REVIEW.md

What I want from a review of this repository. [AGENTS.md](AGENTS.md) has the rules and the quality gate. This file says which product decisions matter most to me and what I want to hear about a change.

## The product

A user builds a profile picture for their coding agent by picking one layer in each trait group, then downloads it. The art starts in Midjourney and I cut it into layers. A user can pick any combination of those layers. A style goes in the builder once the render check passes it.

## Decisions to respect

- I set alignment in the art. When a trait sits wrong I fix the layer. Don't recommend an offset, a scale, a crop, a wider zone or a higher tolerance as the fix (rules 1 and 2).
- The render check has to look at the same picture the user gets. The check and the builder page both draw with `compositeLayers` (rule 3).
- A user only gets art I've picked. Nothing in a downloaded picture comes from a model call or from a file the style's manifest doesn't name (rule 4).

## What to tell me

- A change gives the user pixels the render check never draws. That covers a picture that is scaled, cropped, converted or encoded again after `compositeLayers`, and a second place that stacks layers. Name the file the user ends up with and say what checks it.
- A change resizes, moves or crops pixels. Say whether it does that to a layer before the layers are stacked, or to the finished picture after. Before is a rule 1 violation.
- A manifest changes a `zone`, an `over` entry, a `bleed` edge, `overlapTolerance` or `alphaThreshold`, and the pull request doesn't name the layers the change is for.
- A pull request adds or changes layer images. Check the manifest entries for them and that the pull request says I approved the art (rule 5).

## How to write a finding

Start with what a user would see or download. Then give the file and the line.
