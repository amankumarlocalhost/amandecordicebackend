'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const { getGeminiClient } = require('../../config/gemini');
const { AIUsageRecord } = require('./ai.models');

class AIUnavailableError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.reason = reason; // disabled | timeout | rate_limited | busy | error
  }
}

/** Process-wide concurrency limiter so traffic spikes queue briefly instead of overwhelming the API. */
class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.waiters = [];
  }
  async acquire(timeoutMs) {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== entry);
        reject(new AIUnavailableError('busy', 'AI assistant is busy'));
      }, timeoutMs);
      const entry = () => {
        clearTimeout(t);
        this.active++;
        resolve();
      };
      this.waiters.push(entry);
    });
  }
  release() {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

const limiter = new Semaphore(env.GEMINI_MAX_CONCURRENCY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function classify(err) {
  const status = err?.status || err?.code;
  if (err?.name === 'AbortError' || /aborted|timeout/i.test(err?.message || '')) return 'timeout';
  if (status === 429 || /RESOURCE_EXHAUSTED|rate/i.test(err?.message || '')) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'client';
}

/**
 * One generateContent call with timeout, bounded retries (exponential backoff + full jitter) for
 * transient failures only, and a usage record. Never retries a 4xx other than 429.
 */
async function generate(opts) {
  try {
    return await generateWithModel(opts);
  } catch (err) {
    const fallback = env.GEMINI_FALLBACK_MODEL;
    if (!(err instanceof AIUnavailableError) || ['disabled', 'busy'].includes(err.reason) || !fallback || fallback === opts.model) throw err;
    logger.warn({ scope: opts.scope, model: opts.model, fallback, reason: err.reason }, 'Gemini primary model failed, trying fallback model');
    return generateWithModel({ ...opts, model: fallback });
  }
}

async function generateWithModel({ scope, userId, conversationId, model, systemInstruction, contents, tools, toolMode = 'AUTO', temperature = 0.3, maxOutputTokens = 1024 }) {
  const ai = getGeminiClient();
  if (!ai) throw new AIUnavailableError('disabled', 'Gemini is not configured');
  const started = Date.now();
  await limiter.acquire(10000);
  let lastErr;
  try {
    for (let attempt = 0; attempt <= env.GEMINI_MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), env.GEMINI_TIMEOUT_MS);
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction,
            temperature,
            maxOutputTokens,
            abortSignal: controller.signal,
            ...(tools?.length ? { tools: [{ functionDeclarations: tools }], toolConfig: { functionCallingConfig: { mode: toolMode } } } : {}),
          },
        });
        clearTimeout(timer);
        const usage = response.usageMetadata || {};
        AIUsageRecord.create({ scope, user: userId, conversation: conversationId, model, status: 'ok', inputTokens: usage.promptTokenCount || 0, outputTokens: usage.candidatesTokenCount || 0, durationMs: Date.now() - started, toolCalls: (response.functionCalls || []).map((f) => f.name) }).catch(() => {});
        return response;
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        const kind = classify(err);
        if (kind === 'client' || attempt === env.GEMINI_MAX_RETRIES) break;
        const backoff = Math.random() * Math.min(8000, 500 * 2 ** attempt);
        logger.warn({ scope, attempt, kind, backoffMs: Math.round(backoff) }, 'Gemini transient failure, retrying');
        await sleep(backoff);
      }
    }
  } finally {
    limiter.release();
  }
  const kind = classify(lastErr);
  const reason = kind === 'server' || kind === 'client' ? 'error' : kind;
  AIUsageRecord.create({ scope, user: userId, conversation: conversationId, model, status: reason, durationMs: Date.now() - started, error: String(lastErr?.message || '').slice(0, 300) }).catch(() => {});
  logger.error({ scope, reason, err: lastErr?.message }, 'Gemini request failed');
  throw new AIUnavailableError(reason, lastErr?.message);
}

module.exports = { generate, AIUnavailableError, Semaphore };
