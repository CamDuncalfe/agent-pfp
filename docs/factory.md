# The factory runner

The runner starts the coding agent on a ticket without anyone opening a session. I put the `ready-for-agent` label on an issue, and a scheduled job on my Mac picks it up within 5 minutes.

The code is in [`factory/`](../factory): `tick.sh` is what the job runs, `tick.js` runs the commands, `decisions.js` holds each decision the runner makes and `prompts/` holds what the agent is told. The tests for the decisions are in `test/factory.test.js`.

## What one run does

1. It takes the lowest-numbered open issue with `ready-for-agent`. I have to be the one who opened the issue and the one who added the label. The run skips any other issue and logs why.
2. A ticket needs a numbered list under an "Acceptance criteria" heading. Without one, the ticket gets `agent-needs-help` and the agent doesn't start.
3. The run swaps the label for `agent-working` and makes a git worktree on a new branch from `origin/main`. The branch is the ticket number and a short form of the title, like `3-style-picker`.
4. It starts Claude Code with `claude -p` in that worktree. The agent reads the ticket with `gh issue view`, reads AGENTS.md, makes the change, runs `npm test` and `npm run check`, commits, and writes the pull request description.
5. The runner looks at the result itself. It wants a commit, a clean tree, no change in `factory/` or `.github/`, and both checks passing when it runs them again.
6. The runner pushes the branch and opens the pull request with `Closes #<ticket>` and the agent's description.
7. It waits for CI and for Qodo's review of the newest commit. With open findings, the agent gets them as text, fixes the ones it confirms and writes an answer. The runner checks again, pushes and posts the answer on the pull request. Then it waits for the next review.
8. With CI green and no open finding, the ticket gets `agent-review` and a comment. The pull request waits for me. The runner never merges.

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
| Runs at once | 1, held by a lock folder. A lock older than 3 hours is ignored. |
| Fix rounds after the first pull request | 2. A check that fails before the pull request also uses one. |
| One agent call | 20 minutes |
| Waiting for CI and Qodo on one commit | 15 minutes |

A run that hits a limit ends with `agent-needs-help`. So does a failed check after the last round, an agent that finishes without a commit, and a branch that is on GitHub already.

## What the agent can do

The agent runs with a fixed list of tools, `AGENT_TOOLS` in `factory/decisions.js`. It can read and edit files in its worktree, run the tests and the render check, commit, and read issues and pull requests with `gh`. Pushing, merging and each `gh` command that writes are not on the list, and a command that isn't on the list is refused because nobody is there to approve it. The runner does the push and the pull request after its own checks.

## Setup on a Mac

You need Node 22 or newer, `git` with push access to the repository, the GitHub CLI signed in as the repository owner, and Claude Code signed in.

1. Make the labels once:

   ```sh
   gh label create ready-for-agent --description "The agent takes this ticket"
   gh label create agent-working --description "An agent run has this ticket"
   gh label create agent-review --description "The agent's pull request is ready for me"
   gh label create agent-needs-help --description "The agent run stopped"
   ```

2. Clone the repository into a folder that only the runner uses, and leave it on `main`. `tick.sh` pulls `main` before each run, so the runner is the version that went through review.

3. Try it: `node factory/tick.js --dry-run` prints the ticket a run would take and changes nothing.

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
       <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
       <key>FACTORY_HOME</key><string>/path/to/factory-home</string>
     </dict>
     <key>StandardOutPath</key><string>/path/to/factory-home/launchd.log</string>
     <key>StandardErrorPath</key><string>/path/to/factory-home/launchd.log</string>
   </dict>
   </plist>
   ```

   `launchctl bootout gui/$(id -u)/agent-pfp.factory` stops it.

## Settings

| Variable | Default | What it is |
| --- | --- | --- |
| `FACTORY_HOME` | `~/.agent-pfp-factory` | Worktrees in `runs/`, logs in `logs/` and the lock |
| `FACTORY_CLAUDE` | `claude` | The Claude Code command |
| `FACTORY_MODEL` | Claude Code's default | The model for the agent |

Each run writes `logs/issue-<number>.log` with the time of each step. Ticks that find no ticket write one line to `logs/ticks.log`.
