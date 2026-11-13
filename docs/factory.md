# The factory runner

The runner starts the coding agent on a ticket without anyone opening a session. I put the `ready-for-agent` label on an issue, and a scheduled job on my Mac picks it up within 5 minutes.

The code is in [`factory/`](../factory): `tick.sh` is what the job runs, `tick.js` runs the commands, `decisions.js` holds each decision the runner makes and `prompts/` holds what the agent is told. The tests for the decisions are in `test/factory.test.js`.

## What one run does

1. It takes the lowest-numbered open issue with `ready-for-agent`. I have to be the one who opened the issue and the one who added the label. The run skips any other issue and logs why.
2. A ticket needs a numbered list under an "Acceptance criteria" heading. Without one, the ticket gets `agent-needs-help` and the agent doesn't start. A collapsed `<details>` block doesn't count, so I can keep a ticket's first wording in one. The block opens where a line starts with the tag. The tag named in a sentence, in inline code or in a fenced code block opens nothing. A tag inside an HTML comment neither opens nor closes a block.
3. The run swaps the label for `agent-working` and makes a git worktree on a new branch from `origin/main`. The branch is the ticket number and a short form of the title, like `3-style-picker`.
4. It starts Claude Code with `claude -p` in that worktree. The prompt holds the ticket's acceptance criteria as the runner read them in step 2. The agent reads the rest of the ticket with `gh issue view`, reads AGENTS.md, makes the change, runs `npm test` and `npm run check`, commits, and writes the pull request description.
5. The runner looks at the result itself. It wants a commit, a clean tree, no change in `factory/` or `.github/`, and both checks passing when it runs them again.
6. The runner pushes the branch and opens the pull request. It writes `Closes #<ticket>` and the ticket's acceptance criteria at the top itself, the same list the agent got in its prompt, and the agent's description goes below.
7. It waits for CI and for Qodo's review of the newest commit. A review counts only once Qodo reports the review run on that commit as completed: each check asks `qodo read pr-review-session findings --json` first, and the run's `review_session` has to name the commit, read `completed` and have `review_complete` true. Until then the runner keeps waiting, even when the review comment already names the commit, because Qodo edits that comment while the run is going. When the run on the commit reads `failed`, `aborted`, `skipped` or `superseded`, the statuses Qodo's Review Resolver skill lists as ended without completing, the wait stops at once with `agent-needs-help` and the comment names the status. `started` and any other status keep the runner waiting. A failed qodo read is logged and counts as not complete. The findings come from the review comment. It reads each finding's severity from the group Qodo lists it under, and follows the quality gate in [AGENTS.md](../AGENTS.md#quality-gate). With an open High or Medium finding, the agent gets those findings as text, fixes the ones it confirms and writes an answer. A finding it doesn't confirm keeps its code as it is, with the agent's evidence in the answer: the file and line, and the test or command that shows it. That finding stays open, so it comes back in the next round, and when it is still open after the last round the run ends with `agent-needs-help` and the task comes back to me as not done. A finding with a severity the runner can't read counts as High. The runner checks again, pushes and posts the answer on the pull request. Then it waits for the next review.
8. With CI green and no High or Medium finding open, the ticket gets `agent-review` and a comment. Low findings don't start a fix round, and the comment lists the ones still open for me, each with its title, type and file. The pull request waits for me. The runner never merges.

## Labels

| Label | Meaning |
| --- | --- |
| `ready-for-agent` | I want the agent to take this ticket. |
| `agent-working` | A run has it. |
| `agent-review` | The pull request is open, checked and reviewed. My turn. |
| `agent-needs-help` | The run stopped. The comment on the ticket says where. |

To send a ticket through again, fix what the comment names, delete the branch when one was pushed, and swap `agent-needs-help` for `ready-for-agent`.

## Limits

| Limit | Value |
| --- | --- |
| Tickets per run | 1 |
| Runs at once | 1. The run holds a lock on a file through `lockf`, and macOS gives that lock back when the run ends, also when it was cut off. |
| Fix rounds after the first pull request | 2. A check that fails before the pull request also uses one. |
| One agent call | 20 minutes |
| Waiting for CI and Qodo on one commit | 15 minutes. CI or a review run that doesn't finish in that time stops the run, and while the review run isn't complete the comment names the last qodo error. A review run that ended without completing stops the run before then. |
| One qodo read of the review run | 30 seconds |

A run that hits a limit ends with `agent-needs-help`. So does a High or Medium finding still open after the last round, a failed check after the last round, an agent that finishes without a commit, and a branch that is on GitHub already.

## What the agent can do

`agentArgs` in `factory/decisions.js` builds the Claude Code call, and it is the whole of what the agent can do:

- It has the built-in tools `Read`, `Glob`, `Grep`, `Edit`, `Write` and `Bash`, and no MCP server.
- `AGENT_TOOLS` lists what is approved: reading and editing files in its worktree, the tests and the render check, `git add` and `git commit`, and reading issues and pull requests with `gh`.
- `AGENT_DENIED` refuses `Edit` and `Write` in `factory/` and `.github/`.
- The call loads no settings file (`--setting-sources ""`), so a permission saved on the Mac doesn't add to the list. Nobody is there to approve a prompt (`--permission-prompts none`), so a command that isn't on the list is refused. That covers `git push`, a merge and each `gh` command that writes.

The runner still checks after the agent's commit that nothing in `factory/` or `.github/` changed. A test the agent runs can write files, and that check is what catches it.

## Setup on a Mac

You need Node 22 or newer, `git` with push access to the repository, the GitHub CLI signed in as the repository owner, Claude Code signed in, and the Qodo command line (`qodo`) signed in.

1. Make the labels once:

   ```sh
   gh label create ready-for-agent --description "The agent takes this ticket"
   gh label create agent-working --description "An agent run has this ticket"
   gh label create agent-review --description "The agent's pull request is ready for me"
   gh label create agent-needs-help --description "The agent run stopped"
   ```

2. Clone the repository into a folder that only the runner uses, and leave it on `main`. `tick.sh` pulls `main` before each run, so the runner is the version that went through review.

3. Try it: `factory/tick.sh --dry-run` prints the ticket a run would take. A dry run changes nothing on GitHub, doesn't pull and writes no log.

4. Save this as `~/Library/LaunchAgents/agent-pfp.factory.plist` with your own paths, then load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/agent-pfp.factory.plist`:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>agent-pfp.factory</string>
     <key>ProgramArguments</key>
     <array><string>/path/to/runner-clone/factory/tick.sh</string></array>
     <key>StartInterval</key><integer>300</integer>
     <key>EnvironmentVariables</key>
     <dict>
       <key>PATH</key><string>/Users/you/.local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
       <key>FACTORY_HOME</key><string>/path/to/factory-home</string>
     </dict>
     <key>StandardOutPath</key><string>/path/to/factory-home/launchd.log</string>
     <key>StandardErrorPath</key><string>/path/to/factory-home/launchd.log</string>
   </dict>
   </plist>
   ```

   `PATH` has to hold the folders `node`, `git`, `gh`, `claude` and `qodo` are in. `/Users/you/.local/bin` stands for the folder `qodo` is installed in.

   `launchctl bootout gui/$(id -u)/agent-pfp.factory` stops it.

## Settings

| Variable | Default | What it is |
| --- | --- | --- |
| `FACTORY_HOME` | `~/.agent-pfp-factory` | Worktrees in `runs/`, logs in `logs/` and the lock file |
| `FACTORY_CLAUDE` | `claude` | The Claude Code command |
| `FACTORY_QODO` | `qodo` | The Qodo command line, which says when a review run is complete |
| `FACTORY_MODEL` | Claude Code's default | The model for the agent |

Each run writes `logs/issue-<number>.log` with the time of each step. Ticks that find no ticket write one line to `logs/ticks.log`.
