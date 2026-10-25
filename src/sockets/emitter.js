'use strict';

const env = require('../config/env');

/**
 * Lets services push events to rooms without depending on the Socket.IO server.
 * In the API process this is the live server; in a standalone worker it is a Redis emitter
 * that reaches clients connected to any API instance.
 */
let target = null;

function attachServer(io) {
  target = io;
}

function getTarget() {
  if (target) return target;
  if (env.features.redis) {
    const { Emitter } = require('@socket.io/redis-emitter');
    const { createDuplicate } = require('../config/redis');
    target = new Emitter(createDuplicate());
  }
  return target;
}

const rooms = {
  user: (id) => `user:${id}`,
  conversation: (id) => `conversation:${id}`,
  staff: (permission) => `staff:${permission}`,
};

function emitToUser(userId, event, data) {
  getTarget()?.to(rooms.user(userId)).emit(event, data);
}

function emitToConversation(conversationId, event, data) {
  getTarget()?.to(rooms.conversation(conversationId)).emit(event, data);
}

function emitToStaff(permission, event, data) {
  getTarget()?.to(rooms.staff(permission)).emit(event, data);
}

module.exports = { attachServer, getTarget, emitToUser, emitToConversation, emitToStaff, rooms };
