import { execFileSync } from 'node:child_process';
import { URL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const PLACEHOLDER_VALUES = new Set([
  'https://your-truenas-host',
  'http://your-truenas-host',
  'your_api_key',
  'new_key_here',
]);

const MUTATING_METHOD_PATTERN =
  /(^|\.)(create|update|delete|destroy|remove|set|start|stop|restart|reboot|shutdown|rollback|restore|run|sync|import|export|apply|attach|detach|activate|deactivate|install|uninstall|enable|disable|renew|replace|clone|move|mount|unmount|lock|unlock|promote|demote|wipe|format|scrub|login|logout)$/i;

function readLaunchctlEnv(name) {
  if (process.platform !== 'darwin') {
    return '';
  }

  try {
    return execFileSync('launchctl', ['getenv', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function sanitizeEnvValue(value) {
  if (!value) {
    return '';
  }

  const trimmed = String(value).trim();
  return PLACEHOLDER_VALUES.has(trimmed) ? '' : trimmed;
}

function getConfigValue(name) {
  const fromLaunchctl = sanitizeEnvValue(readLaunchctlEnv(name));
  if (fromLaunchctl) {
    return fromLaunchctl;
  }

  return sanitizeEnvValue(process.env[name]);
}

function getConfig() {
  return {
    url: getConfigValue('TRUENAS_URL'),
    apiKey: getConfigValue('TRUENAS_API_KEY'),
    allowInsecure: getConfigValue('TRUENAS_ALLOW_INSECURE') === '1',
    tlsInsecure: getConfigValue('TRUENAS_TLS_INSECURE') === '1',
    allowMutations: getConfigValue('TRUENAS_ALLOW_MUTATIONS') === '1',
    timeoutMs: Number.parseInt(getConfigValue('TRUENAS_TIMEOUT_MS') || '8000', 10),
  };
}

function buildSocketUrl(baseUrl, allowInsecure) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch (error) {
    throw new Error(`TRUENAS_URL must be a valid absolute URL. ${error.message}`);
  }

  if (parsed.protocol === 'http:' && !allowInsecure) {
    throw new Error(
      'Refusing insecure TrueNAS transport. Use an https:// TRUENAS_URL or set TRUENAS_ALLOW_INSECURE=1 if you really mean it.'
    );
  }

  const socketProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${socketProtocol}//${parsed.host}/api/current`;
}

function waitForOpen(ws, timeoutMs, wsUrl) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out connecting to ${wsUrl}`));
    }, timeoutMs);

    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Could not connect to ${wsUrl}`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
    };

    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onError, { once: true });
  });
}

function waitForMessage(ws) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      cleanup();
      resolve(typeof event.data === 'string' ? event.data : String(event.data));
    };
    const onError = (event) => {
      cleanup();
      reject(new Error(event?.message || 'WebSocket error'));
    };
    const onClose = (event) => {
      cleanup();
      reject(new Error(`Socket closed before response (${event.code})`));
    };
    const cleanup = () => {
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    };

    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
  });
}

async function rpcCall(ws, id, method, params) {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));

  while (true) {
    const raw = await waitForMessage(ws);
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      continue;
    }

    if (message.id !== id) {
      continue;
    }

    if (message.error) {
      throw new Error(JSON.stringify(message.error));
    }

    return message.result;
  }
}

function assertSafeMethod(method, allowMutations) {
  if (!allowMutations && MUTATING_METHOD_PATTERN.test(method)) {
    throw new Error(
      `Blocked potentially mutating TrueNAS method "${method}". Set TRUENAS_ALLOW_MUTATIONS=1 if you want the MCP server to permit writes.`
    );
  }
}

async function callTrueNAS(method, params = [], options = {}) {
  const config = getConfig();

  if (!config.url) {
    throw new Error('TRUENAS_URL is required.');
  }

  if (!config.apiKey) {
    throw new Error('TRUENAS_API_KEY is required.');
  }

  const allowMutations = options.allowMutations === true && config.allowMutations;
  assertSafeMethod(method, allowMutations);

  if (config.tlsInsecure) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  const wsUrl = buildSocketUrl(config.url, config.allowInsecure);
  const ws = new WebSocket(wsUrl);
  await waitForOpen(ws, config.timeoutMs, wsUrl);

  try {
    const authResult = await rpcCall(ws, 1, 'auth.login_with_api_key', [config.apiKey]);
    if (authResult !== true) {
      throw new Error('TrueNAS rejected the API key.');
    }

    return await rpcCall(ws, 2, method, params);
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

function asToolResult(method, result) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ method, result }, null, 2),
      },
    ],
    structuredContent: {
      method,
      result,
    },
  };
}

const server = new McpServer({
  name: 'truenas-local',
  version: '0.1.0',
});

server.registerTool(
  'system_info',
  {
    description: 'Return basic system information for the connected TrueNAS host.',
    inputSchema: {},
  },
  async () => asToolResult('system.info', await callTrueNAS('system.info'))
);

server.registerTool(
  'alert_list',
  {
    description: 'List current alerts from the TrueNAS system.',
    inputSchema: {},
  },
  async () => asToolResult('alert.list', await callTrueNAS('alert.list'))
);

const querySchema = {
  filters: z.array(z.any()).optional().describe('TrueNAS query filters array.'),
  options: z.any().optional().describe('TrueNAS query options object.'),
};

server.registerTool(
  'pool_query',
  {
    description: 'Query storage pools.',
    inputSchema: querySchema,
  },
  async ({ filters = [], options = {} }) =>
    asToolResult('pool.query', await callTrueNAS('pool.query', [filters, options]))
);

server.registerTool(
  'dataset_query',
  {
    description: 'Query datasets.',
    inputSchema: querySchema,
  },
  async ({ filters = [], options = {} }) =>
    asToolResult('pool.dataset.query', await callTrueNAS('pool.dataset.query', [filters, options]))
);

server.registerTool(
  'disk_query',
  {
    description: 'Query disks.',
    inputSchema: querySchema,
  },
  async ({ filters = [], options = {} }) =>
    asToolResult('disk.query', await callTrueNAS('disk.query', [filters, options]))
);

server.registerTool(
  'app_query',
  {
    description: 'Query installed apps.',
    inputSchema: querySchema,
  },
  async ({ filters = [], options = {} }) =>
    asToolResult('app.query', await callTrueNAS('app.query', [filters, options]))
);

server.registerTool(
  'replication_query',
  {
    description: 'Query replication tasks.',
    inputSchema: querySchema,
  },
  async ({ filters = [], options = {} }) =>
    asToolResult('replication.query', await callTrueNAS('replication.query', [filters, options]))
);

server.registerTool(
  'snapshot_query',
  {
    description: 'Query snapshots.',
    inputSchema: querySchema,
  },
  async ({ filters = [], options = {} }) =>
    asToolResult('pool.snapshot.query', await callTrueNAS('pool.snapshot.query', [filters, options]))
);

server.registerTool(
  'truenas_call',
  {
    description:
      'Call an arbitrary TrueNAS JSON-RPC method. Mutating methods are blocked unless TRUENAS_ALLOW_MUTATIONS=1.',
    inputSchema: {
      method: z.string().describe('TrueNAS JSON-RPC method name, for example pool.query.'),
      params: z.array(z.any()).optional().describe('JSON-RPC params array.'),
      allowMutations: z
        .boolean()
        .optional()
        .describe('Set true only if you intentionally enabled TRUENAS_ALLOW_MUTATIONS=1.'),
    },
  },
  async ({ method, params = [], allowMutations = false }) =>
    asToolResult(method, await callTrueNAS(method, params, { allowMutations }))
);

const transport = new StdioServerTransport();

server.connect(transport).catch((error) => {
  console.error('TrueNAS MCP server error:', error);
  process.exit(1);
});
