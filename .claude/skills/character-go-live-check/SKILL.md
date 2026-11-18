---
name: character-go-live-check
description: Checks a cut character's layer export before it goes live in the builder. Use when a new character (one the index lists under comingSoon) has an export folder of cut layers and someone asks whether it is ready to go live, or before a pull request adds a style folder under styles/. It stages a copy under the public id and name, marks see-through eyewear, runs the render check on every combination and checks no working name is left. It only checks; it never puts the character live.
---

# Character go-live check

A character goes live when its style folder is added under `styles/` and its entry moves from `comingSoon` to `styles` in `styles/index.json`. This skill is the check that comes first. It runs on a copy outside the repository and changes nothing in it.

## Inputs

Ask for any of these that the request doesn't give. Don't guess them.

1. **Export folder**: a folder with a `manifest.json` and the `layers/` it names. It can be outside the repository.
2. **Public id**: the id the character has in `comingSoon` in `styles/index.json`, for example `duck`.
3. **Picker name**: the name under its tile, with a capital, for example `Duck`. It is the `name` of its `comingSoon` entry.

The see-through options are worked out in step 3.

Read `docs/manifest.md` (the `over` and `seeThrough` fields) and `docs/render-check.md` (what each issue means) before step 3 if you haven't this session.

## Stop and ask

Stop, say what is missing, and wait when:

- An input above is missing, or the export folder has no `manifest.json`.
- The id is already in `styles` in `styles/index.json` (it is live already), or it isn't in `comingSoon` (it isn't one of the characters waiting).
- An eyewear option can't be placed as see-through or not in step 3.
- A command exits with 2 (it could not run). Show its output. `stage.mjs` also exits with 2 on purpose for a layer that carries text or metadata chunks, a working or public name with letters outside plain ASCII (an accent included), and a working-name word under three letters. Ask how to go on.
- A step goes wrong because of this skill or its script, not the art: `stage.mjs` leaves out a layer the manifest names, or a command does something other than this file says. Report it as a problem with the skill and give the verdict `Not ready`.

Never copy, delete or edit a file in `$STAGE` by hand. The check only counts on the copy `stage.mjs` made.

## Steps

Run every command from the repository root. Keep each command's full output for the report.

### 1. The character is waiting, not live

```sh
node -e 'const i=require("./styles/index.json"); const id=process.argv[1]; console.log("live:", i.styles.some(s=>s.id===id), "coming soon:", (i.comingSoon||[]).find(c=>c.id===id)?.name ?? "no")' <id>
```

Expected: `live: false coming soon: <Picker name>`. Anything else is a stop.

### 2. List the eyewear

```sh
node -e 'const m=require(require("path").resolve(process.argv[1],"manifest.json")); for (const g of m.groups) console.log(g.id, JSON.stringify(g.over||[]), g.options.map(o=>o.id+(o.seeThrough?"*":"")+" ("+o.label+")").join(", "))' <export folder>
```

This prints every group with its `over` list and options. Note the working id and name from the manifest too (`m.style`, `m.name`).

### 3. Decide the see-through options

An option is see-through when you can see the face through it: clear glasses, clear lenses, a frame with no lenses. Sunglasses, shades and goggles with dark lenses hide the eyes on purpose and are not see-through.

- Go by the label first. "Clear glasses" is see-through. "Wayfarers", "Round shades" and "Sunglasses" are not.
- When the label doesn't say (a monocle, a visor, "Goggles"), open the layer image and look at the lenses. Transparent lenses with only a frame drawn: see-through. Filled lenses: not.
- Still unsure: stop and ask.

Only an option in a group that lists groups in `over` can be see-through.

### 4. Stage the copy

```sh
STAGE=$(mktemp -d /tmp/go-live-<id>.XXXXXX)
node .claude/skills/character-go-live-check/stage.mjs <export folder> <id> "<Picker name>" "$STAGE" --see-through <group>/<option>,<group>/<option>
```

Give each see-through option with its group, for example `eyewear/clear-glasses`: option ids repeat across groups (clothes and eyes can each have a `default`). Leave out `--see-through` when step 3 found none. Expected: it prints the working and public id and name, one `Marked see-through` line per option, a `Took off a see-through mark` line for each option the export had marked that step 3 didn't pick, `Copied N layers`, the files it left out, the working words it searched for and found, `Combinations: N`, and ends with `Staged <id>`, exit 0. Exit 1 means a working word is left (step 5). Exit 2 is a stop.

Check each file it left out against the `src` paths in the export's `manifest.json`. A file the manifest doesn't name is not a failure, but name it in the report: someone cut it and it isn't in the manifest. A file the manifest does name means the script went wrong: stop (see Stop and ask).

### 5. No working name left

`stage.mjs` takes the words of the working id and name that the public id and name don't have and searches the staged manifest, the index and every staged path for each as a whole word, ignoring case. The layers can't hold a name: it refuses a layer with any text or metadata chunk. It prints them as `Working words to find:` and the result as `Working words left in the stage:`.

Expected: `Working words left in the stage: none`. Any file it names is a fail: put each in the report.

When it found words to look for, look at the paths once more yourself, for each word:

```sh
find "$STAGE" -ipath "*<word>*"
```

Expected: no output. When it printed `Working words to find: none`, there is nothing to search for; say so in the report.

### 6. Same trait groups as the live characters

```sh
node -e 'const live=require("./styles/alien/manifest.json").groups.map(g=>g.id); const m=require(process.argv[1]); const ids=m.groups.map(g=>g.id); const extra=ids.filter(i=>!live.includes(i)); const order=ids.filter(i=>live.includes(i)).join()===live.filter(i=>ids.includes(i)).join(); console.log("groups:", ids.join(", ")); console.log("not in the alien:", extra.join(", ")||"none"); console.log("same order:", order)' "$STAGE/styles/<id>/manifest.json"
```

Expected: `not in the alien: none` and `same order: true`. A character can leave a group out (some have no mouth options yet); say which ones in the report.

### 7. Render check on every combination

`N` is the number from step 4's `Combinations:` line. Passing it as `--max-combinations` makes the check draw every combination instead of a sample:

```sh
node bin/render-check.js "$STAGE/styles/<id>/manifest.json" --max-combinations <N> > "$STAGE/render-check.txt" 2>&1; code=$?; cat "$STAGE/render-check.txt"; echo "exit $code" | tee -a "$STAGE/render-check.txt"; test $code -eq 0
```

The command's own exit status is the check's. Expected: `Style: <id>`, `Combinations checked: all <N>, 0 failed`, `Render check passed.` and `exit 0`. A line that says `a sample of` means N was wrong: run it again with step 4's number. With a see-through option marked, this is also where the check proves each eye option shows through it: a `covered` issue means the glasses hide the eyes that were picked.

Exit 1 is a fail. Exit 2 is a stop. Copy each issue into the report as the check printed it. Don't change the art, the manifest's `over`, `bleed`, `zone` or tolerances to make it pass (AGENTS.md rule 2), and don't drop a `seeThrough` mark you set in step 3.

### 8. The repository is unchanged

```sh
git status --porcelain
```

Expected: no output. This skill never writes in the repository, commits, pushes or edits `styles/index.json`.

## Evidence

Write `$STAGE/REPORT.md` with:

- The inputs and the commit you ran on (`git rev-parse --short HEAD`).
- For each step, the command you ran and its output, word for word. Shorten only the combination lines of step 7, never the summary lines.
- The see-through decision for each eyewear option and why (label, or what the image showed).
- Last line, one of:
  - `Ready to go live: <id>` when steps 1 to 8 met their expected results.
  - `Not ready: <id>: <each failure, short>`.

End your reply with the path of `REPORT.md` and that last line.
