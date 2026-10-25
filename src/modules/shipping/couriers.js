'use strict';

/**
 * Courier adapter interface. A real integration (Shiprocket, Delhivery, Blue Dart, …) implements
 * the same three methods using the provider's documented API and credentials, and is registered
 * below. Until then, `manual` lets staff enter AWB numbers from the courier's own portal.
 *
 * interface CourierAdapter {
 *   name: string
 *   createShipment({ order, shipment }): Promise<{ awb?: string, trackingUrl?: string }>
 *   track(awb): Promise<Array<{ status, at, location, note }>>   // may return [] if unsupported
 *   cancel(awb): Promise<{ cancelled: boolean }>
 * }
 */

const manual = {
  name: 'manual',
  supportsTracking: false,
  async createShipment({ shipment }) {
    return { awb: shipment.awb, trackingUrl: shipment.trackingUrl };
  },
  async track() {
    return [];
  },
  async cancel() {
    return { cancelled: true };
  },
};

const adapters = { manual };

function getCourier(name = 'manual') {
  return adapters[name] || manual;
}

module.exports = { getCourier, adapters };
