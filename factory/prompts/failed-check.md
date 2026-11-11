The runner ran the checks on your commit for ticket #{{number}} and `{{check}}` failed. This is the end of its output:

```
{{output}}
```

Find the cause and fix it. Don't loosen a test or the render check to get it through (AGENTS.md rule 2). Run `npm test` and `npm run check`, commit on `{{branch}}` and update `{{notes}}/pr-body.md` when the description changed. Don't push.
