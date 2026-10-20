# Codiff pane for Claude Code

A Claude Code plugin that opens Codiff's review UI in a native pane beside the conversation: a
file tree, diffs, viewed marks, pull requests, and Codiff's guided walkthroughs. It works in the
terminal and in the Claude desktop app's Code tab.

The pane does not reimplement Codiff. It runs the Codiff CLI's `--json` mode, so files, hunk ids,
and walkthroughs come from the same code the app uses, and walkthroughs share the app's cache and
agent settings in `~/.codiff/codiff.jsonc`.

## Install locally

This folder's parent is a local marketplace. From a terminal:

```sh
claude plugin marketplace add ./plugins/claude
claude plugin install codiff-pane@codiff-local
```

Claude Code reads the plugin from this folder rather than a copy, so after editing it run
`/reload-plugins` in a session. To try it for one session without installing, start Claude with
`claude --plugin-dir ./plugins/claude/codiff-pane`.

## Use

- `/codiff` opens the current checkout's working tree.
- `/codiff 42` (or `/codiff #42`) opens pull request #42, fetched with `gh` from the checkout's
  remote.

In the pane, `f` and `w` switch between files and the walkthrough, `j` and `k` move to the next
and previous file or stop, `v` opens view options, `r` refreshes, and `g` generates a walkthrough.
Click inside the pane first so it has the keyboard. The working-tree view refreshes after Claude
edits files.

Generating a walkthrough runs Codiff's pipeline with the agent chosen in the Agent menu (Codiff's
own setting by default) and passes this conversation as context. It sends the diff to that agent
and uses its normal limits.

## Choosing the Codiff CLI

The `codiffPath` setting picks the CLI: an executable, or a checkout's `bin/codiff.js` (a leading
`~/` is expanded). When it is empty, the pane uses this repository's own CLI inside a Codiff
checkout and `codiff` on your PATH everywhere else. The installed Codiff needs `--json`, so point
`codiffPath` at a checkout until a release includes it.

The CLI runs through a `zsh` login shell, so sessions the desktop app starts find `codiff` and
`node` on the same PATH as your terminal.

## Develop

```sh
claude plugin validate plugins/claude/codiff-pane
claude plugin test plugins/claude/codiff-pane
```

The plugin is type-checked against the `claude-code` declarations Claude Code writes to
`.claude-plugin/types/` when it loads the plugin, so it is excluded from the repository's own
type check and lint.
