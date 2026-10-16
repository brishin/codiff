import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { URL } from 'node:url';

// Deliberately dependency-free: this server implements only the MCP methods it uses.
const logDirectory = '/tmp/codiff';
const resourceUri = 'ui://codiff/viewer-v1';
const reviewResourceUri = 'ui://codiff/thread-review-v3';
const require = createRequire(import.meta.url);
// Updates remove older cache directories while their MCP connections may still run.
// Keep the viewer and backends available for the lifetime of each connection.
const reviewHtml = readFileSync(new URL('./dist/review.html', import.meta.url), 'utf8');
const diagnosticsHtml = readFileSync(new URL('./viewer.html', import.meta.url), 'utf8');
const { loadThreadReview } = require('./dist/thread-review.cjs');
const { agentSettings } = require('./dist/agent-settings.cjs');
const icons = [
  {
    mimeType: 'image/png',
    sizes: ['128x128'],
    src: `data:image/png;base64,${readFileSync(new URL('./assets/icon.png', import.meta.url)).toString('base64')}`,
  },
];
mkdirSync(logDirectory, { mode: 0o700, recursive: true });
let clientInfo = null;
let clientCapabilityKeys = [];

const pick = (value, keys) =>
  Object.fromEntries(
    keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]),
  );

const summarizeMeta = (meta = {}) => {
  let turn = meta['x-codex-turn-metadata'];
  if (typeof turn === 'string') {
    try {
      turn = JSON.parse(turn);
    } catch {
      turn = {};
    }
  }
  return {
    keys: Object.keys(meta),
    ...pick(meta, ['threadId', 'sessionId', 'windowId', 'itemId', 'callId']),
    resource: pick(meta['openai/resource'], ['path']),
    turn: {
      ...pick(turn, ['thread_id', 'session_id', 'turn_id', 'codex_version']),
      keys: Object.keys(turn ?? {}),
      workspaceRoots: Object.keys(turn?.workspaces ?? {}),
    },
  };
};

const record = (method, params = {}) => {
  const event = {
    clientCapabilityKeys,
    clientInfo,
    environment: pick(process.env, ['CODEX_THREAD_ID', 'CODEX_SESSION_CWD', 'PWD']),
    metadata: summarizeMeta(params._meta),
    method,
    pid: process.pid,
    processCwd: process.cwd(),
    timestamp: new Date().toISOString(),
    tool: params.name ?? null,
    ui:
      params.name === 'report_ui_context'
        ? pick(params.arguments?.report, [
            'hostInfo',
            'hostContextKeys',
            'hostCapabilityKeys',
            'displayMode',
            'platform',
            'theme',
          ])
        : undefined,
  };
  appendFileSync(join(logDirectory, 'events.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return event;
};

const tool = (name, title, entrypoints = []) => ({
  _meta: {
    'openai/ui': { entrypoints },
    ui: { resourceUri },
  },
  annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: true },
  description:
    'Inspect local host-supplied thread and workspace metadata. Does not read repository files.',
  icons,
  inputSchema: { properties: {}, type: 'object' },
  name,
  title,
});

const tools = [
  tool('inspect_metadata', 'Inspect Codiff metadata'),
  tool('review_thread', 'Codiff', [{ type: 'thread' }]),
  tool('inspect_file_metadata', 'Codiff File Diagnostics', [
    { extensions: ['.codiffprobe'], type: 'file' },
  ]),
  {
    _meta: { ui: { visibility: ['app'] } },
    annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: true },
    description: 'Record selected UI host context fields for the local metadata diagnostics.',
    inputSchema: {
      properties: { report: { type: 'object' } },
      required: ['report'],
      type: 'object',
    },
    name: 'report_ui_context',
  },
];
const checkoutSchema = {
  additionalProperties: false,
  properties: {
    cwd: {
      description:
        'Absolute path of the checkout to review. Omit to use the host-supplied thread’s checkout.',
      type: 'string',
    },
  },
  type: 'object',
};
tools[1].description =
  'View the current working-tree changes in this thread’s local checkout, or in `cwd`, with Codiff.';
tools[1].inputSchema = checkoutSchema;
tools[1]._meta.ui.resourceUri = reviewResourceUri;
tools.push({
  _meta: { ui: { visibility: ['app'] } },
  annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: true },
  description: 'Reload the current working-tree review for the host-supplied thread or `cwd`.',
  inputSchema: checkoutSchema,
  name: 'review_refresh',
});
for (const name of ['agent_settings_read', 'agent_settings_update']) {
  tools.push({
    _meta: { ui: { visibility: ['app'] } },
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: name === 'agent_settings_read',
    },
    description:
      name === 'agent_settings_read'
        ? 'Read Codiff agent configuration and available models.'
        : 'Update Codiff agent configuration. Does not change the host conversation model.',
    inputSchema:
      name === 'agent_settings_read'
        ? { properties: {}, type: 'object' }
        : {
            additionalProperties: false,
            properties: {
              key: { enum: ['agent', 'model', 'reasoningEffort', 'fastMode'], type: 'string' },
              value: { type: ['string', 'boolean'] },
            },
            required: ['key', 'value'],
            type: 'object',
          },
    name,
  });
}
tools.push({
  _meta: { ui: { visibility: ['app'] } },
  annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true },
  description:
    'Generate a walkthrough of this thread checkout, or `cwd`, using the configured Codiff agent and model. Sends the diff to that agent.',
  inputSchema: checkoutSchema,
  name: 'review_walkthrough',
});
tools[2].inputSchema = {
  properties: {
    file: {
      properties: { name: { type: 'string' }, resourceUri: { type: 'string' } },
      type: 'object',
    },
  },
  type: 'object',
};

const dispatch = async (method, params = {}) => {
  if (method === 'initialize') {
    clientInfo = params.clientInfo;
    clientCapabilityKeys = Object.keys(params.capabilities ?? {});
    record(method, params);
    return {
      capabilities: { resources: {}, tools: {} },
      protocolVersion: '2025-11-25',
      serverInfo: { icons, name: 'codiff', title: 'Codiff', version: '0.7.3' },
    };
  }
  if (method === 'ping') {
    return {};
  }
  record(method, params);
  if (method === 'tools/list') {
    return { tools };
  }
  if (method === 'resources/list') {
    return {
      resources: [
        { mimeType: 'text/html;profile=mcp-app', name: 'Codiff', uri: reviewResourceUri },
        { mimeType: 'text/html;profile=mcp-app', name: 'Codiff Diagnostics', uri: resourceUri },
      ],
    };
  }
  if (method === 'resources/templates/list') {
    return { resourceTemplates: [] };
  }
  if (method === 'resources/read' && [resourceUri, reviewResourceUri].includes(params.uri)) {
    return {
      contents: [
        {
          _meta: {
            'openai/ui': {
              availableDisplayModes: ['fullscreen', 'inline'],
              preferredDisplayMode: 'fullscreen',
            },
          },
          mimeType: 'text/html;profile=mcp-app',
          text: params.uri === reviewResourceUri ? reviewHtml : diagnosticsHtml,
          uri: params.uri,
        },
      ],
    };
  }
  if (method === 'tools/call' && tools.some(({ name }) => name === params.name)) {
    if (['agent_settings_read', 'agent_settings_update'].includes(params.name)) {
      try {
        const settings =
          params.name === 'agent_settings_read'
            ? await agentSettings.read()
            : await agentSettings.update(params.arguments ?? {});
        return {
          content: [
            {
              text: `Codiff agent: ${settings.agent}; model: ${settings.model}; reasoning effort: ${settings.reasoningEffort || 'default'}.`,
              type: 'text',
            },
          ],
          structuredContent: settings,
        };
      } catch (error) {
        return { content: [{ text: error.message, type: 'text' }], isError: true };
      }
    }
    if (['review_thread', 'review_refresh', 'review_walkthrough'].includes(params.name)) {
      try {
        const review = await loadThreadReview(params._meta, {
          cwd: params.arguments?.cwd,
          generateWalkthrough: params.name === 'review_walkthrough',
        });
        return {
          _meta: { 'openai/outputTemplate': reviewResourceUri },
          content: [
            {
              text: `Loaded ${review.snapshot.files.length} changed files from ${review.snapshot.repository.root}.`,
              type: 'text',
            },
          ],
          structuredContent: review,
        };
      } catch (error) {
        return { content: [{ text: error.message, type: 'text' }], isError: true };
      }
    }
    const event = record('diagnostics/result', params);
    return { content: [{ text: JSON.stringify(event), type: 'text' }], structuredContent: event };
  }
  throw new Error(`Unsupported method: ${method}`);
};

const handleRequest = async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    if (request.id === undefined) {
      record(request.method, request.params);
      return;
    }
    const result = await dispatch(request.method, request.params);
    process.stdout.write(`${JSON.stringify({ id: request.id, jsonrpc: '2.0', result })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ error: { code: -32_601, message: error.message }, id: request?.id ?? null, jsonrpc: '2.0' })}\n`,
    );
  }
};
for await (const line of createInterface({ input: process.stdin })) {
  // Dispatch concurrently so generation cannot block read-only refresh or settings calls.
  // oxlint-disable-next-line unicorn/prefer-top-level-await
  void handleRequest(line);
}
