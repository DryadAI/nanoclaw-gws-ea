#!/usr/bin/env node
/**
 * Anthropic Messages API → OpenAI Chat Completions proxy
 *
 * Bridges the Anthropic SDK (used inside agent containers) to any
 * OpenAI-compatible backend — Bifrost, LM Studio, vLLM, etc.
 *
 * Usage:
 *   BIFROST_URL=http://100.72.190.41:8080/v1 BIFROST_MODEL=qwen3:14b npx tsx scripts/ollama-proxy.ts
 *
 * Legacy env vars still accepted:
 *   OLLAMA_URL  → treated as BIFROST_URL base (appends /v1 if missing)
 *   OLLAMA_MODEL → treated as BIFROST_MODEL
 */

import * as http from 'http';

function resolveBase(): string {
  const raw = process.env.BIFROST_URL ?? process.env.OLLAMA_URL;
  if (raw) {
    const trimmed = raw.replace(/\/$/, '');
    // If caller supplied a bare Ollama URL without /v1, add it
    return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
  }
  return 'http://100.72.190.41:8080/v1';
}

const BIFROST_BASE  = resolveBase();
const DEFAULT_MODEL = process.env.BIFROST_MODEL ?? process.env.OLLAMA_MODEL ?? 'qwen3:14b';
const PORT          = parseInt(process.env.PROXY_PORT ?? '4000', 10);
const BIFROST_API_KEY = process.env.BIFROST_API_KEY ?? '';

// ── Type definitions ─────────────────────────────────────────────────────────

interface TextBlock       { type: 'text'; text: string }
interface ToolUseBlock    { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string | TextBlock[]; is_error?: boolean }

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicRequest {
  model?: string;
  messages: AnthropicMessage[];
  system?: string;
  tools?: AnthropicTool[];
  max_tokens?: number;
  stream?: boolean;
}

// OpenAI types
interface OAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OAIMessage {
  role: string;
  content: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

interface OAIRequest {
  model: string;
  messages: OAIMessage[];
  tools?: Array<{
    type: 'function';
    function: { name: string; description?: string; parameters: Record<string, unknown> };
  }>;
  stream: boolean;
  max_tokens?: number;
}

interface OAIChoice {
  message: OAIMessage;
  finish_reason: string | null;
}

interface OAIResponse {
  choices: OAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// ── ID generators ─────────────────────────────────────────────────────────────

let msgSeq  = 0;
let toolSeq = 0;
const newMsgId  = () => `msg_${(++msgSeq).toString().padStart(8, '0')}`;
const newToolId = () => `toolu_${(++toolSeq).toString().padStart(8, '0')}`;

// ── Message conversion: Anthropic → OpenAI ────────────────────────────────────

function toolResultText(content: string | TextBlock[]): string {
  if (typeof content === 'string') return content;
  return content.map(b => b.text).join('');
}

function argsToString(input: Record<string, unknown>): string {
  return JSON.stringify(input);
}

function convertMessages(messages: AnthropicMessage[], system?: string): OAIMessage[] {
  const out: OAIMessage[] = [];

  if (system) {
    out.push({ role: 'system', content: system });
  }

  for (const msg of messages) {
    const { role, content } = msg;

    if (typeof content === 'string') {
      out.push({ role, content });
      continue;
    }

    const textParts:   string[]           = [];
    const toolUses:    ToolUseBlock[]     = [];
    const toolResults: ToolResultBlock[]  = [];

    for (const block of content) {
      if (block.type === 'text')         textParts.push(block.text);
      else if (block.type === 'tool_use')    toolUses.push(block);
      else if (block.type === 'tool_result') toolResults.push(block);
    }

    if (toolResults.length > 0) {
      // Each tool result → separate OpenAI "tool" message with tool_call_id
      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          content: toolResultText(tr.content ?? ''),
          tool_call_id: tr.tool_use_id,
        });
      }
    } else {
      const oaiMsg: OAIMessage = { role, content: textParts.join('') || null };
      if (toolUses.length > 0) {
        oaiMsg.tool_calls = toolUses.map(tu => ({
          id: tu.id,
          type: 'function' as const,
          function: { name: tu.name, arguments: argsToString(tu.input) },
        }));
        // OpenAI: content must be null when tool_calls present
        oaiMsg.content = null;
      }
      out.push(oaiMsg);
    }
  }

  return out;
}

function convertTools(tools: AnthropicTool[]) {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// ── Response conversion: OpenAI → Anthropic ──────────────────────────────────

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

function oaiMessageToBlocks(msg: OAIMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (msg.content?.trim()) {
    blocks.push({ type: 'text', text: msg.content });
  }

  for (const tc of msg.tool_calls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: tc.id ?? newToolId(),
      name: tc.function.name,
      input: parseArgs(tc.function.arguments),
    });
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '' });
  }

  return blocks;
}

function stopReason(finishReason: string | null, hasToolUse: boolean): string {
  if (hasToolUse || finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  return 'end_turn';
}

// ── Non-streaming response ────────────────────────────────────────────────────

function buildResponse(requestModel: string, resp: OAIResponse): object {
  const choice     = resp.choices[0];
  const blocks     = oaiMessageToBlocks(choice.message);
  const hasToolUse = blocks.some(b => b.type === 'tool_use');
  return {
    id:            newMsgId(),
    type:          'message',
    role:          'assistant',
    content:       blocks,
    model:         requestModel,
    stop_reason:   stopReason(choice.finish_reason, hasToolUse),
    stop_sequence: null,
    usage: {
      input_tokens:  resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
    },
  };
}

// ── SSE streaming response ────────────────────────────────────────────────────

function emitSse(res: http.ServerResponse, requestModel: string, resp: OAIResponse): void {
  const choice     = resp.choices[0];
  const blocks     = oaiMessageToBlocks(choice.message);
  const hasToolUse = blocks.some(b => b.type === 'tool_use');
  const msgId      = newMsgId();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event: string, data: object) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send('message_start', {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant', content: [],
      model: requestModel, stop_reason: null, stop_sequence: null,
      usage: { input_tokens: resp.usage?.prompt_tokens ?? 0, output_tokens: 0 },
    },
  });

  send('ping', { type: 'ping' });

  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', {
        type: 'content_block_start', index,
        content_block: { type: 'text', text: '' },
      });
      if (block.text) {
        send('content_block_delta', {
          type: 'content_block_delta', index,
          delta: { type: 'text_delta', text: block.text },
        });
      }
      send('content_block_stop', { type: 'content_block_stop', index });
    } else if (block.type === 'tool_use') {
      send('content_block_start', {
        type: 'content_block_start', index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      send('content_block_delta', {
        type: 'content_block_delta', index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
      send('content_block_stop', { type: 'content_block_stop', index });
    }
  });

  send('message_delta', {
    type: 'message_delta',
    usage: { output_tokens: resp.usage?.completion_tokens ?? 0 },
    delta: { stop_reason: stopReason(choice.finish_reason, hasToolUse), stop_sequence: null },
  });

  send('message_stop', { type: 'message_stop' });
  res.end();
}

// ── Request handler ───────────────────────────────────────────────────────────

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // HTTP forward proxies (e.g. onecli via HTTPS_PROXY) deliver absolute-form
  // request URIs. Normalize to pathname so routing matches in both modes.
  const reqPath = (() => {
    try { return new URL(req.url ?? '/', 'http://_').pathname; }
    catch { return req.url ?? '/'; }
  })();
  console.log(`req ${req.method} ${req.url} → ${reqPath}`);

  if (req.method === 'POST' && reqPath === '/v1/audio/transcriptions') {
    console.log(`→ transcription request`);
    try {
      const targetUrl = `${BIFROST_BASE}/audio/transcriptions`;
      const proxyReq = http.request(targetUrl, {
        method: 'POST',
        headers: req.headers,
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      });
      req.pipe(proxyReq);
      proxyReq.on('error', (err) => {
        console.error('Transcription proxy error:', err);
        res.writeHead(502);
        res.end(JSON.stringify({ error: 'Transcription proxy failed', detail: String(err) }));
      });
      return;
    } catch (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: 'Transcription proxy setup failed', detail: String(err) }));
      return;
    }
  }

  if (req.method !== 'POST' || reqPath !== '/v1/messages') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const body = JSON.parse(Buffer.concat(chunks).toString()) as AnthropicRequest;

  const oaiReq: OAIRequest = {
    model:    DEFAULT_MODEL,
    messages: convertMessages(body.messages, body.system),
    stream:   false,
    ...(body.tools      ? { tools:      convertTools(body.tools) } : {}),
    ...(body.max_tokens ? { max_tokens: body.max_tokens         } : {}),
  };

  console.log(`→ ${DEFAULT_MODEL}  tools=${body.tools?.length ?? 0}  msgs=${body.messages.length}`);

  let oaiResp: OAIResponse;
  try {
    const r = await fetch(`${BIFROST_BASE}/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(BIFROST_API_KEY ? { 'Authorization': `Bearer ${BIFROST_API_KEY}` } : {}),
      },
      body:    JSON.stringify(oaiReq),
    });
    if (!r.ok) {
      const text = await r.text();
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Bifrost ${r.status}`, detail: text }));
      return;
    }
    oaiResp = await r.json() as OAIResponse;
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Bifrost unreachable: ${err}` }));
    return;
  }

  const requestModel = body.model ?? DEFAULT_MODEL;
  const choice       = oaiResp.choices?.[0];
  const hasTools     = (choice?.message?.tool_calls?.length ?? 0) > 0;
  console.log(`← ${choice?.finish_reason ?? 'stop'}  tool_calls=${hasTools ? choice.message.tool_calls!.length : 0}`);

  if (body.stream) {
    emitSse(res, requestModel, oaiResp);
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildResponse(requestModel, oaiResp)));
  }
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error('Proxy error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`Anthropic → OpenAI proxy (Bifrost)`);
  console.log(`  Listening: http://localhost:${PORT}`);
  console.log(`  Bifrost:   ${BIFROST_BASE}`);
  console.log(`  Model:     ${DEFAULT_MODEL}`);
});
