Qodo reviewed pull request #{{pr}} for ticket #{{number}}. Its open findings are in `{{notes}}/findings.md`.

1. Look into each finding in the code before you decide. A finding is confirmed when the problem it describes is real in this change.
2. Fix each confirmed finding, with a test when it changes what the code does. Stay inside the ticket and leave `factory/` and `.github/` alone.
3. Run `npm test` and `npm run check`. Both have to pass. Commit on `{{branch}}`. Don't push; the runner pushes after its own checks.
4. Write your answer to the review in `{{notes}}/reply.md`. The runner posts it on the pull request. Answer each finding by its number and title: what you changed and the commit, or what you did about it when you left the code as it is. Keep it short, thank the reviewer once at the top, and write in plain words.
