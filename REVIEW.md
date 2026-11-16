# REVIEW.md

What I want from a review of this repository. [AGENTS.md](AGENTS.md) has the rules and the quality gate. This file says which product decisions matter most to me and what I want to hear about a change.

## The product

A user builds a profile picture for their coding agent by picking one layer in each trait group, then downloads it. The art starts in Midjourney and I cut it into layers. A user can pick any combination of those layers. A style goes in the builder once the render check passes it.

## Decisions to respect

- I set alignment in the art. When a trait sits wrong I fix the layer. Don't recommend a fix that goes against rule 1 or rule 2.
- A picture a user downloads is one the render check has drawn (rule 3).
- The art in a downloaded picture is art I picked and cut into layers (rule 4).

## What to tell me

- A change gives the user pixels the render check never draws, for example a picture that is scaled, cropped or encoded again after `compositeLayers` drew it, or a second place that stacks layers. Name the file the user ends up with and say what checks it. Qodo's issue finder gets the same ask from `issues_user_guidelines` in `.pr_agent.toml`, so change both together.
- A change resizes, moves or crops pixels. Say whether it does that to a layer before the layers are stacked, or to the finished picture after. Rule 1 covers the first case.
- A manifest changes one of the fields rule 2 names, and the pull request doesn't name the layers the change is for.
- A pull request adds or changes layer images. Check the manifest entries for them and that the pull request says I approved the art (rule 5).

## How to write a finding

Start with what a user would see or download. Then give the file and the line.
