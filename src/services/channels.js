'use strict';

const env = require('../config/env');
const logger = require('../config/logger');

/**
 * Outbound message channels. Each returns { delivered: boolean, provider, reason? }.
 * Nothing pretends to deliver when a provider is not configured.
 */

let transporter = null;
function getTransport() {
  if (!env.features.smtp) return null;
  if (!transporter) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

async function sendEmail({ to, subject, text, html }) {
  const t = getTransport();
  if (!t) {
    if (!env.isProd) logger.info({ to, subject, text }, '[dev email] SMTP not configured; message logged instead');
    return { delivered: false, provider: 'none', reason: 'smtp_not_configured' };
  }
  const info = await t.sendMail({ from: env.EMAIL_FROM, to, subject, text, html });
  return { delivered: true, provider: 'smtp', providerMessageId: info.messageId };
}

async function sendSms({ to, text }) {
  if (env.SMS_PROVIDER === 'console' && !env.isProd) {
    logger.info({ to, text }, '[dev sms] console provider');
    return { delivered: true, provider: 'console' };
  }
  return { delivered: false, provider: 'none', reason: 'sms_not_configured' };
}

async function sendWhatsApp({ to, text }) {
  if (env.WHATSAPP_PROVIDER === 'console' && !env.isProd) {
    logger.info({ to, text }, '[dev whatsapp] console provider');
    return { delivered: true, provider: 'console' };
  }
  return { delivered: false, provider: 'none', reason: 'whatsapp_not_configured' };
}

const configured = () => ({
  email: env.features.smtp,
  sms: env.SMS_PROVIDER !== 'none' && !env.isProd,
  whatsapp: env.WHATSAPP_PROVIDER !== 'none' && !env.isProd,
});

module.exports = { sendEmail, sendSms, sendWhatsApp, configured };
