'use strict';

const env = require('./env');

/**
 * Google Gemini is the only generative-AI provider. The API key stays server-side; nothing about
 * it is ever sent to browsers, sockets or API responses. Tests inject a fake client.
 */
let client = null;
let injected = false;

function getGeminiClient() {
  if (injected) return client;
  if (!env.GEMINI_API_KEY) return null;
  if (!client) {
    const { GoogleGenAI } = require('@google/genai');
    client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  }
  return client;
}

function setGeminiClient(fake) {
  client = fake;
  injected = fake !== null;
}

module.exports = { getGeminiClient, setGeminiClient };
