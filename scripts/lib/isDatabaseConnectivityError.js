"use strict";

// Stop the maintenance command after infrastructure connectivity is lost.
// Continuing through hundreds of indexes would only hide the root failure.
const NETWORK_ERROR_NAMES = new Set([
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoServerSelectionError",
  "MongoTopologyClosedError",
  "MongoNotConnectedError",
]);

const NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

function isDatabaseConnectivityError(error) {
  const visited = new Set();
  let cursor = error;
  while (cursor && typeof cursor === "object" && !visited.has(cursor)) {
    visited.add(cursor);
    if (
      NETWORK_ERROR_NAMES.has(String(cursor.name || "")) ||
      NETWORK_ERROR_CODES.has(String(cursor.code || ""))
    ) return true;

    // Driver server-selection failures sometimes wrap an underlying
    // DNS/network cause; inspect only bounded, known error fields.
    const message = String(cursor.message || "");
    if (/\b(EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b/.test(message)) return true;
    cursor = cursor.cause;
  }
  return false;
}

module.exports = { isDatabaseConnectivityError };
