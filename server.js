const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(process.cwd(), "proxy.log");
const CONFIG_FILE = path.join(__dirname, "config.json");

// ── Config ───────────────────────────────────────────────────────────────────

const DEFAULTS = {
  port: 8788,
  base_url: "https://api.example.com/v1",
  anthropic_base_url: "https://api.example.com/anthropic",
  api_key: "",
  default_model: "default-model",
  multimodal_model: "multimodal-model",
};

function loadConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) }; }
  catch { return DEFAULTS; }
}

// ── Logging ──────────────────────────────────────────────────────────────────

function log(msg) { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); }
console.log = (...args) => log(args.join(" "));
console.error = (...args) => log("[ERROR] " + args.join(" "));

// ── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

let idCounter = 0;
function newId(prefix) { return `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`; }

// ── Request: Responses API → Chat Completions API ────────────────────────────

function hasImages(input) {
  if (!Array.isArray(input)) return false;
  for (const item of input) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) { if (part.type === "input_image") return true; }
    }
  }
  return false;
}

function modelSupportsImages(model) {
  const base = model.replace(/\[[^\]]*\]$/, "").toLowerCase();
  return base.includes("omni") || base.includes("vision") || base.includes("multimodal");
}

function partsToContent(parts, model) {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return String(parts || "");
  const out = [];
  const supportsImages = modelSupportsImages(model);
  for (const p of parts) {
    if (p.type === "input_text" || p.type === "output_text") {
      const text = typeof p.text === "string" ? p.text : "";
      if (text.length > 0) out.push({ type: "text", text });
    } else if (p.type === "input_image") {
      if (supportsImages) {
        const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url || "";
        out.push({ type: "image_url", image_url: { url } });
      }
      // Drop images for non-multimodal models
    } else if (p.type === "text") {
      out.push({ type: "text", text: p.text || "" });
    }
  }
  if (out.length === 0) return "";
  if (out.every(p => p.type === "text")) return out.map(p => p.text).join("");
  return out;
}

function toolOutputToString(output) {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) { try { return JSON.stringify(output); } catch { return String(output); } }
  const chunks = [];
  for (const p of output) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "input_text" || p.type === "output_text") {
      const text = typeof p.text === "string" ? p.text : "";
      if (text.length > 0) chunks.push(text);
    }
  }
  return chunks.join("");
}

// Buffer assistant message: text + reasoning + tool_calls → one message
function flushAssistant(messages, state) {
  if (!state.pendingText && !state.pendingReasoning && state.pendingToolCalls.length === 0) return;
  const msg = { role: "assistant", content: state.pendingText || null };
  if (state.pendingToolCalls.length > 0) msg.tool_calls = state.pendingToolCalls;
  if (state.pendingReasoning) msg.reasoning_content = state.pendingReasoning;
  messages.push(msg);
  state.pendingText = null;
  state.pendingReasoning = null;
  state.pendingToolCalls = [];
}

function inputToMessages(input, model) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [{ role: "user", content: String(input) }];

  const messages = [];
  const state = { pendingText: null, pendingReasoning: null, pendingToolCalls: [] };

  for (const item of input) {
    // Legacy format: {role, content} without type
    if (item && typeof item === "object" && !("type" in item) && typeof item.role === "string") {
      const text = typeof item.content === "string" ? item.content : Array.isArray(item.content) ? item.content.map(p => typeof p === "string" ? p : p?.text ?? "").join("") : "";
      item = { type: "message", role: item.role, content: [{ type: item.role === "assistant" ? "output_text" : "input_text", text }] };
    }

    switch (item.type) {
      case "message": {
        const role = item.role === "developer" ? "system" : item.role;
        if (role === "system") continue; // handled separately
        if (role === "assistant") {
          if (state.pendingText !== null) flushAssistant(messages, state);
          const content = partsToContent(item.content, model);
          state.pendingText = typeof content === "string" ? content : "";
        } else {
          flushAssistant(messages, state);
          messages.push({ role, content: partsToContent(item.content, model) });
        }
        break;
      }
      case "reasoning": {
        flushAssistant(messages, state);
        let text = "";
        if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
          text = item.encrypted_content;
        } else if (Array.isArray(item.summary)) {
          text = item.summary.filter(s => s.type === "summary_text").map(s => s.text).join("");
        }
        if (text) state.pendingReasoning = text;
        break;
      }
      case "function_call": {
        state.pendingToolCalls.push({
          id: item.call_id || item.id || newId("call"),
          type: "function",
          function: { name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}) },
        });
        break;
      }
      case "function_call_output": {
        flushAssistant(messages, state);
        messages.push({ role: "tool", tool_call_id: item.call_id, content: toolOutputToString(item.output) });
        break;
      }
    }
  }
  flushAssistant(messages, state);
  return messages;
}

function extractSystem(input) {
  if (!Array.isArray(input)) return null;
  const parts = [];
  for (const item of input) {
    if (item.type === "message" && (item.role === "developer" || item.role === "system")) {
      if (typeof item.content === "string") parts.push(item.content);
      else if (Array.isArray(item.content)) {
        for (const p of item.content) { if (p.type === "input_text") parts.push(p.text); }
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function convertTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools
    .filter(t => t.type === "function" || t.type === "local_shell")
    .map(t => {
      if (t.type === "local_shell") {
        return {
          type: "function",
          function: {
            name: "shell",
            description: "Execute a shell command on the local machine.",
            parameters: {
              type: "object",
              properties: {
                command: { type: "array", items: { type: "string" }, description: "Argv array" },
                workdir: { type: "string", description: "Working directory (optional)" },
                timeout_ms: { type: "number", description: "Timeout in ms (optional)" },
              },
              required: ["command"],
            },
          },
        };
      }
      return {
        type: "function",
        function: { name: t.name, description: t.description || "", parameters: t.parameters || { type: "object", properties: {} } },
      };
    });
}

function buildChatRequest(oaiReq) {
  const cfg = loadConfig();
  let model = cfg.default_model || "default-model";
  if (hasImages(oaiReq.input)) model = cfg.multimodal_model || "multimodal-model";

  const messages = [];
  const sys = extractSystem(oaiReq.input) || oaiReq.instructions;
  if (sys) messages.push({ role: "system", content: sys });
  messages.push(...inputToMessages(oaiReq.input, model));

  // Merge consecutive same-role messages
  const merged = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = messages[i];
    if (curr.role === "tool" || prev.role === "tool") { merged.push(curr); continue; }
    if (curr.role === prev.role) {
      const prevC = typeof prev.content === "string" ? prev.content : "";
      const currC = typeof curr.content === "string" ? curr.content : "";
      prev.content = prevC + "\n" + currC;
    } else { merged.push(curr); }
  }

  const chatReq = { model, messages: merged, stream: !!oaiReq.stream, max_tokens: oaiReq.max_output_tokens || 8192 };
  if (chatReq.stream) chatReq.stream_options = { include_usage: true };

  const tools = convertTools(oaiReq.tools);
  if (tools && tools.length > 0) {
    chatReq.tools = tools;
    chatReq.tool_choice = oaiReq.tool_choice === "none" ? "none" : oaiReq.tool_choice === "required" ? "required" : "auto";
  }

  if (oaiReq.temperature !== undefined) chatReq.temperature = oaiReq.temperature;
  if (oaiReq.top_p !== undefined) chatReq.top_p = oaiReq.top_p;

  return chatReq;
}

// ── Response: Chat Completions → Responses API ──────────────────────────────

function buildOaiResponse(chatResp, model) {
  const output = [];
  const choice = chatResp.choices?.[0];
  if (!choice) return { id: newId("resp"), object: "response", status: "completed", output: [], model };

  const msg = choice.message;

  // reasoning_content → reasoning output item with encrypted_content for round-trip
  if (msg.reasoning_content) {
    output.push({
      type: "reasoning", id: newId("rs"),
      summary: [{ type: "summary_text", text: msg.reasoning_content }],
      encrypted_content: msg.reasoning_content,
      status: "completed",
    });
  }

  if (msg.content) {
    output.push({
      type: "message", id: newId("msg"), role: "assistant", status: "completed",
      content: [{ type: "output_text", text: msg.content, annotations: [] }],
    });
  }

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: "function_call", id: newId("fc"), call_id: tc.id,
        name: tc.function?.name || "", arguments: tc.function?.arguments || "{}", status: "completed",
      });
    }
  }

  return {
    id: chatResp.id || newId("resp"), object: "response", created_at: chatResp.created || Date.now() / 1000,
    model: chatResp.model || model,
    status: choice.finish_reason === "stop" ? "completed" : choice.finish_reason === "length" ? "incomplete" : "completed",
    output,
    usage: chatResp.usage ? { input_tokens: chatResp.usage.prompt_tokens || 0, output_tokens: chatResp.usage.completion_tokens || 0, total_tokens: chatResp.usage.total_tokens || 0 } : undefined,
  };
}

// ── Streaming ────────────────────────────────────────────────────────────────

function createStreamConverter(res, model) {
  let seqNum = 0, outputIndex = 0;
  let activeKind = null, activeItemId = null, activeBuffer = "";
  let currentToolCalls = new Map();
  const responseId = newId("resp");
  const createdAt = Math.floor(Date.now() / 1000);
  let inputTokens = 0, outputTokens = 0;

  function send(event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data, sequence_number: seqNum++ })}\n\n`); }

  function finalizeActive() {
    if (activeKind === null) return;
    const idx = outputIndex - 1;
    if (activeKind === "reasoning") {
      const finalItem = { id: activeItemId, type: "reasoning", summary: [{ type: "summary_text", text: activeBuffer }], encrypted_content: activeBuffer, status: "completed" };
      send("response.output_item.done", { output_index: idx, item: finalItem });
    } else if (activeKind === "message") {
      send("response.output_text.done", { item_id: activeItemId, output_index: idx, content_index: 0, text: activeBuffer });
      send("response.content_part.done", { item_id: activeItemId, output_index: idx, content_index: 0, part: { type: "output_text", text: activeBuffer, annotations: [] } });
      send("response.output_item.done", { output_index: idx, item: { id: activeItemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: activeBuffer, annotations: [] }] } });
    }
    activeKind = null; activeItemId = null; activeBuffer = "";
  }

  function openReasoning() {
    finalizeActive();
    activeKind = "reasoning";
    activeItemId = newId("rs");
    activeBuffer = "";
    send("response.output_item.added", { output_index: outputIndex++, item: { id: activeItemId, type: "reasoning", summary: [], encrypted_content: null, status: "in_progress" } });
  }

  function openMessage() {
    finalizeActive();
    activeKind = "message";
    activeItemId = newId("msg");
    activeBuffer = "";
    send("response.output_item.added", { output_index: outputIndex++, item: { id: activeItemId, type: "message", role: "assistant", status: "in_progress", content: [] } });
    send("response.content_part.added", { item_id: activeItemId, output_index: outputIndex - 1, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  }

  function openToolCall(index, id, name) {
    finalizeActive();
    const itemId = newId("fc");
    const callId = id || `call_${itemId.slice(3)}`;
    const tc = { itemId, outputIndex, callId, name: name || "", argsBuffer: "" };
    currentToolCalls.set(index, tc);
    send("response.output_item.added", { output_index: outputIndex++, item: { id: itemId, type: "function_call", call_id: callId, name: tc.name, arguments: "", status: "in_progress" } });
    return tc;
  }

  return {
    handleEvent(data) {
      if (data === "[DONE]") {
        finalizeActive();
        // Finalize tool calls
        const ordered = Array.from(currentToolCalls.entries()).sort((a, b) => a[0] - b[0]);
        for (const [, tc] of ordered) {
          send("response.function_call_arguments.done", { item_id: tc.itemId, output_index: tc.outputIndex, arguments: tc.argsBuffer });
          send("response.output_item.done", { output_index: tc.outputIndex, item: { id: tc.itemId, type: "function_call", call_id: tc.callId, name: tc.name, arguments: tc.argsBuffer, status: "completed" } });
        }
        send("response.completed", { response: { id: responseId, object: "response", created_at: createdAt, model, status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } } });
        res.end();
        return;
      }

      let chunk;
      try { chunk = JSON.parse(data); } catch { return; }

      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens || inputTokens;
        outputTokens = chunk.usage.completion_tokens || outputTokens;
      }

      const choice = chunk.choices?.[0];
      if (!choice) return;
      const delta = choice.delta;

      // First chunk — emit created/in_progress
      if (seqNum === 0) {
        send("response.created", { response: { id: responseId, object: "response", created_at: createdAt, model, status: "in_progress", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
        send("response.in_progress", { response: { id: responseId, status: "in_progress" } });
      }

      // reasoning_content → buffer as reasoning item
      if (delta?.reasoning_content) {
        if (activeKind !== "reasoning") openReasoning();
        activeBuffer += delta.reasoning_content;
      }

      // text content
      if (delta?.content) {
        if (activeKind !== "message") openMessage();
        activeBuffer += delta.content;
        send("response.output_text.delta", { item_id: activeItemId, output_index: outputIndex - 1, content_index: 0, delta: delta.content });
      }

      // tool calls
      if (delta?.tool_calls) {
        for (const tcDelta of delta.tool_calls) {
          let tc = currentToolCalls.get(tcDelta.index);
          if (!tc) tc = openToolCall(tcDelta.index, tcDelta.id, tcDelta.function?.name);
          else if (tcDelta.function?.name && !tc.name) tc.name = tcDelta.function.name;
          if (tcDelta.function?.arguments) {
            tc.argsBuffer += tcDelta.function.arguments;
            send("response.function_call_arguments.delta", { item_id: tc.itemId, output_index: tc.outputIndex, delta: tcDelta.function.arguments });
          }
        }
      }
    },

    end() { if (!res.writableEnded) res.end(); },
  };
}

// ── Forward Anthropic Messages API (passthrough) ───────────────────────────

function forwardAnthropic(rawBody, isStream, clientReq, clientRes) {
  const cfg = loadConfig();
  const url = new URL(cfg.anthropic_base_url);
  const targetPath = url.pathname.replace(/\/$/, "") + "/v1/messages";

  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(rawBody),
    "x-api-key": cfg.api_key,
    "anthropic-version": clientReq.headers["anthropic-version"] || "2023-06-01",
  };
  if (clientReq.headers["anthropic-beta"]) headers["anthropic-beta"] = clientReq.headers["anthropic-beta"];

  const options = {
    hostname: url.hostname, port: 443, path: targetPath, method: "POST",
    headers,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    if (proxyRes.statusCode !== 200) {
      let errBody = "";
      proxyRes.on("data", (c) => errBody += c.toString());
      proxyRes.on("end", () => { console.log(`[anthropic] UPSTREAM ERROR ${proxyRes.statusCode}: ${errBody.slice(0, 500)}`); clientRes.writeHead(proxyRes.statusCode, { "Content-Type": "application/json" }); clientRes.end(errBody); });
      return;
    }

    if (isStream) {
      clientRes.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      proxyRes.pipe(clientRes);
    } else {
      let body = "";
      proxyRes.on("data", (c) => body += c.toString());
      proxyRes.on("end", () => { clientRes.writeHead(200, { "Content-Type": "application/json" }); clientRes.end(body); });
    }
  });

  proxyReq.on("error", (err) => { console.error(`[anthropic] upstream error: ${err.message}`); if (!clientRes.headersSent) clientRes.writeHead(502, { "Content-Type": "application/json" }); clientRes.end(JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } })); });
  proxyReq.setTimeout(300000, () => { proxyReq.destroy(new Error("upstream timeout")); });
  proxyReq.write(rawBody);
  proxyReq.end();
}

// ── Forward to API ──────────────────────────────────────────────────────────

function forwardToApi(chatReq, isStream, res) {
  const cfg = loadConfig();
  const body = JSON.stringify(chatReq);
  const url = new URL(cfg.base_url);
  const targetPath = url.pathname.replace(/\/$/, "") + "/chat/completions";

  const options = {
    hostname: url.hostname, port: 443, path: targetPath, method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Authorization": `Bearer ${cfg.api_key}` },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    if (proxyRes.statusCode !== 200) {
      let errBody = "";
      proxyRes.on("data", (c) => errBody += c.toString());
      proxyRes.on("end", () => { console.log(`[proxy] UPSTREAM ERROR ${proxyRes.statusCode}: ${errBody.slice(0, 500)}`); res.writeHead(proxyRes.statusCode, { "Content-Type": "application/json" }); res.end(errBody); });
      return;
    }

    if (isStream) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const converter = createStreamConverter(res, chatReq.model);
      let buffer = "";
      proxyRes.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) { if (line.startsWith("data: ")) converter.handleEvent(line.slice(6).trim()); }
      });
      proxyRes.on("end", () => { if (buffer.startsWith("data: ")) converter.handleEvent(buffer.slice(6).trim()); converter.end(); });
    } else {
      let body = "";
      proxyRes.on("data", (c) => body += c.toString());
      proxyRes.on("end", () => {
        try { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(buildOaiResponse(JSON.parse(body), chatReq.model))); }
        catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "Failed to parse upstream response", type: "proxy_error" } })); }
      });
    }
  });

  proxyReq.on("error", (err) => { console.error(`[proxy] upstream error: ${err.message}`); if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: err.message, type: "proxy_error" } })); });
  proxyReq.setTimeout(300000, () => { proxyReq.destroy(new Error("upstream timeout")); });
  proxyReq.write(body);
  proxyReq.end();
}

// ── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/health") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "ok" })); return; }

  if (req.method === "POST" && url.pathname === "/v1/responses") {
    try {
      const rawBody = await readBody(req);
      const oaiReq = JSON.parse(rawBody);
      const inputTypes = Array.isArray(oaiReq.input) ? oaiReq.input.map(i => i.type || typeof i).join(", ") : typeof oaiReq.input;
      console.log(`[proxy] ${oaiReq.stream ? "streaming" : "non-streaming"} request, model=${oaiReq.model}, input=[${inputTypes}]`);
      const chatReq = buildChatRequest(oaiReq);
      console.log(`[proxy] → model=${chatReq.model}, messages=${chatReq.messages.length}, stream=${chatReq.stream}`);
      forwardToApi(chatReq, !!oaiReq.stream, res);
    } catch (err) { console.error(`[proxy] request error: ${err.message}`); res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: err.message, type: "invalid_request" } })); }
    return;
  }

  // ── Anthropic Messages API passthrough (for Claude Desktop) ───────────────
  if (req.method === "POST" && url.pathname === "/v1/messages") {
    try {
      const rawBody = await readBody(req);
      const anthropicReq = JSON.parse(rawBody);
      const isStream = !!anthropicReq.stream;
      console.log(`[anthropic] ${isStream ? "streaming" : "non-streaming"} messages request, model=${anthropicReq.model}, messages=${anthropicReq.messages?.length || 0}`);
      forwardAnthropic(rawBody, isStream, req, res);
    } catch (err) { console.error(`[anthropic] request error: ${err.message}`); res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: err.message } })); }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found", type: "not_found" } }));
});

const cfg = loadConfig();
server.listen(cfg.port, "127.0.0.1", () => {
  console.log(`[r2c-proxy] listening on http://127.0.0.1:${cfg.port}`);
  console.log(`[r2c-proxy] forwarding to ${cfg.base_url}/chat/completions`);
  console.log(`[r2c-proxy] API key: ${cfg.api_key ? "configured" : "NOT SET"}`);
});
