# Codiff desktop plugin

Open **Codiff** from a desktop thread's app menu to review the changes in its
local checkout. The plugin renders Codiff's `ReviewSurface` as a Model Context
Protocol (MCP) App. It shows the current staged, unstaged, and untracked changes,
including changes made outside the conversation. It does not reconstruct a
historical diff attributable only to the thread.

## Install locally

Use Node.js 24 or newer and the Codex CLI. Install the repository dependencies
and build Codiff, then build and install the plugin:

```sh
vp install
vpr build
node plugins/codiff/build.mjs
codex plugin marketplace add ./plugins
codex plugin add codiff@codiff-local
```

Restart the desktop app after installation to load the plugin connection, then
open **Codiff** from the thread's app menu. The generated `dist/` files are not
tracked in Git, but the local plugin installer includes them.

## Review controls

The **Agent** menu selects the Codiff agent, model, reasoning effort, and
Codex-only Fast Mode. These settings persist in `~/.codiff/codiff.jsonc` and
control Codiff agent runs. They do not change the host conversation's model.

The **View** menu controls diff style, word wrapping, whitespace, unchanged lines,
font size, theme, and refresh. Display preferences persist locally. These menus
appear only after the viewer connects to an MCP Apps host.

Select **Walkthrough** to generate an explanation with the configured agent.
Generation sends the working-tree diff to that agent and uses its normal limits
or credits. Fast Mode uses the higher Fast rate. Tree loading does not invoke an
agent. Failures expose a retry action; refreshing discards the previous sequence.
Comments and repository writes remain disabled in this view.

## Thread lookup and lifecycle

The `review_thread` entrypoint obtains the thread ID from host request metadata.
A separate local `codex app-server` connection calls read-only `thread/read` to
resolve the checkout. This lookup never resumes the chat or starts a model turn.
The existing Codiff Git reader supplies eager file contents to the viewer.

The server loads its HTML resources and bundled backends at startup. Running
connections can still serve the viewer when an update removes their old plugin
cache directory. The tool timeout allows 20 minutes for generation, including
Codiff's per-model timeouts and fallback attempts.

The plugin logo and composer icon use `assets/icon.svg`, the white vector glyph
from Codiff's app icon without its gradient background or effects. MCP entrypoints
advertise its PNG rendering through `tools/list[].icons`, with `serverInfo.icons`
as the fallback.

## Diagnostics

`inspect_metadata` and the `.codiffprobe` file entrypoint inspect selected host
metadata. The server records selected thread/session IDs, workspace roots,
resource paths, client identity, process cwd, and UI context key names in
`/tmp/codiff/events.jsonl`. It does not log diff contents, arbitrary environment
variables, or arbitrary metadata values.

The protocol implementation supports the MCP methods used by this plugin.
Remote checkouts and multiple concurrent workspaces are not supported by the
local thread lookup.
