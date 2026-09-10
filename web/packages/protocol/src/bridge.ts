/** v2 adds explicit negotiation; v1 remains wire-compatible for installed clients. */
export const BRIDGE_PROTOCOL_VERSION = 2;
export const SUPPORTED_BRIDGE_PROTOCOLS: readonly number[] = [2, 1];
