'use strict';

const { z } = require('zod');
const logger = require('../../config/logger');
const { generate } = require('./gemini.service');
const { AIProposal } = require('./ai.models');

const MAX_STEPS = 5;
const MAX_CALLS_PER_STEP = 5;
const TOOL_TIMEOUT_MS = 8000;
const MAX_TOOL_OUTPUT_CHARS = 12000;

function toDeclaration(tool) {
  const schema = z.toJSONSchema(tool.schema, { target: 'draft-7', unrepresentable: 'any' });
  delete schema.$schema;
  return { name: tool.name, description: tool.description, parametersJsonSchema: schema };
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => (t = setTimeout(() => rej(Object.assign(new Error('Tool timed out'), { code: 'tool_timeout' })), ms)))]).finally(() => clearTimeout(t));
}

/** Keeps tool output within budget by shortening the largest arrays first. */
function fitOutput(output) {
  let s = JSON.stringify(output ?? null);
  if (s.length <= MAX_TOOL_OUTPUT_CHARS) return output;
  const copy = JSON.parse(s);
  for (const key of Object.keys(copy || {})) {
    while (Array.isArray(copy[key]) && copy[key].length > 1 && JSON.stringify(copy).length > MAX_TOOL_OUTPUT_CHARS) copy[key].pop();
  }
  s = JSON.stringify(copy);
  return s.length <= MAX_TOOL_OUTPUT_CHARS ? { ...copy, truncated: true } : { truncated: true, note: 'Result too large; narrow the request.' };
}

/**
 * Controlled tool-calling loop. Gemini can only *request* named tools; the server validates every
 * argument against a strict Zod schema, re-checks permissions, derives identity from `ctx` (never
 * from model output), executes with a timeout, and returns structured results as untrusted data.
 */
async function runAgent({ scope, ctx, model, systemInstruction, contents, tools, maxSteps = MAX_STEPS }) {
  const declarations = tools.map(toDeclaration);
  const trace = [];
  const artifacts = { proposals: [], products: [], handoff: false };
  const conv = [...contents];
  const base = { scope, userId: ctx.userId, conversationId: ctx.conversationId, model, systemInstruction };

  for (let step = 0; step < maxSteps; step++) {
    const resp = await generate({ ...base, contents: conv, tools: declarations });
    const calls = resp.functionCalls || [];
    if (!calls.length) return { text: (resp.text || '').trim(), trace, artifacts };

    // Echo the model turn back verbatim (it carries thought signatures required by Gemini).
    conv.push(resp.candidates?.[0]?.content || { role: 'model', parts: calls.map((c) => ({ functionCall: c })) });
    const parts = [];
    for (const call of calls.slice(0, MAX_CALLS_PER_STEP)) {
      const started = Date.now();
      const tool = tools.find((t) => t.name === call.name);
      let output;
      if (!tool) output = { error: 'unknown_tool' };
      else {
        const parsed = tool.schema.safeParse(call.args || {});
        if (!parsed.success) {
          output = { error: 'invalid_arguments', details: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) };
        } else if (tool.permission && !ctx.permissions?.includes(tool.permission)) {
          output = { error: 'permission_denied', message: `This requires the ${tool.permission} permission, which the current user does not have.` };
        } else {
          try {
            output = await withTimeout(Promise.resolve(tool.handler(ctx, parsed.data, artifacts)), TOOL_TIMEOUT_MS);
          } catch (err) {
            output = { error: err.code || 'tool_failed', message: err.expose ? err.message : 'The lookup failed. Try again or offer human support.' };
            if (!err.expose) logger.warn({ tool: call.name, err: err.message }, 'AI tool failed');
          }
        }
      }
      trace.push({ name: call.name, ok: !output?.error, ms: Date.now() - started, ...(output?.error ? { error: output.error } : {}) });
      parts.push({ functionResponse: { id: call.id, name: call.name, response: { output: fitOutput(output) } } });
    }
    conv.push({ role: 'user', parts });
  }
  const final = await generate({ ...base, contents: conv, tools: declarations, toolMode: 'NONE' });
  return { text: (final.text || '').trim(), trace, artifacts };
}

async function createProposal({ scope, requestedFor, conversation, session, tool, args, title, preview, requiredPermission, ttlMinutes = 30 }) {
  return AIProposal.create({ scope, requestedFor, conversation, session, tool, args, title, preview, requiredPermission, expiresAt: new Date(Date.now() + ttlMinutes * 60000) });
}

/**
 * Executes a proposal exactly once: the pending→executing claim is atomic, and the executor gets
 * the proposal id as its idempotency key.
 */
async function executeProposal(proposal, executor, executedBy) {
  const claimed = await AIProposal.findOneAndUpdate(
    { _id: proposal._id, status: 'pending', expiresAt: { $gt: new Date() } },
    { $set: { status: 'executing', executedBy } },
    { new: true },
  );
  if (!claimed) {
    const current = await AIProposal.findById(proposal._id).lean();
    if (current?.status === 'executed') return { status: 'executed', result: current.result, duplicate: true };
    if (current && current.status === 'pending' && current.expiresAt <= new Date()) {
      await AIProposal.updateOne({ _id: proposal._id, status: 'pending' }, { $set: { status: 'expired' } });
      return { status: 'expired' };
    }
    return { status: current?.status || 'missing' };
  }
  try {
    const result = await executor(claimed);
    await AIProposal.updateOne({ _id: claimed._id }, { $set: { status: 'executed', result, executedAt: new Date() } });
    return { status: 'executed', result };
  } catch (err) {
    await AIProposal.updateOne({ _id: claimed._id }, { $set: { status: 'failed', error: err.message } });
    return { status: 'failed', error: { code: err.code || 'FAILED', message: err.expose ? err.message : 'The action could not be completed' } };
  }
}

module.exports = { runAgent, createProposal, executeProposal, toDeclaration, fitOutput };
