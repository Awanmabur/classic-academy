"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ensureCollectionIndex,
} = require("../scripts/lib/indexReconciler");
const {
  isDatabaseConnectivityError,
} = require("../scripts/lib/isDatabaseConnectivityError");

function collectionWith(index) {
  const changes = [];
  const indexes = [
    { name: "_id_", key: { _id: 1 } },
    index,
  ];
  return {
    changes,
    indexes: async () => indexes,
    aggregate: () => ({ toArray: async () => [] }),
    createIndex: async () => {
      changes.push("create");
      throw new Error("UNSAFE_DUPLICATE_INDEX_BUILD");
    },
    dropIndex: async () => {
      changes.push("drop");
      throw new Error("UNSAFE_INDEX_DROP");
    },
  };
}

test("PlatformConfig reuses a unique B-tree index with an equivalent legacy name", async () => {
  const collection = collectionWith({
    name: "singletonKey_1",
    key: { singletonKey: 1 },
    unique: true,
  });
  const result = await ensureCollectionIndex(
    collection,
    { singletonKey: 1 },
    { name: "uniq_platform_config_singleton", unique: true }
  );
  assert.equal(result.status, "existing");
  assert.equal(result.name, "singletonKey_1");
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(collection.changes, []);
});

test("PlatformConfig schema defines singleton uniqueness only once", () => {
  const mongoose = require("mongoose");
  const connection = mongoose.createConnection();
  const model = require("../src/models/platform/PlatformConfig")(connection);
  const indexes = model.schema.indexes().filter(([key]) =>
    JSON.stringify(key) === JSON.stringify({ singletonKey: 1 })
  );
  assert.equal(indexes.length, 1);
  assert.equal(indexes[0][1].name, "uniq_platform_config_singleton");
  assert.equal(indexes[0][1].unique, true);
});

test("alias with different uniqueness is rejected without dropping either index", async () => {
  const collection = collectionWith({
    name: "singletonKey_1",
    key: { singletonKey: 1 },
    unique: false,
  });
  await assert.rejects(
    ensureCollectionIndex(collection, { singletonKey: 1 }, {
      name: "uniq_platform_config_singleton",
      unique: true,
    }),
    /UNSAFE_DUPLICATE_INDEX_BUILD/
  );
  assert.deepEqual(collection.changes, ["create"]);
});

test("alias with different partial unique constraint is not accepted", async () => {
  const collection = collectionWith({
    name: "singletonKey_1",
    key: { singletonKey: 1 },
    unique: true,
    partialFilterExpression: { isDeleted: false },
  });
  await assert.rejects(
    ensureCollectionIndex(collection, { singletonKey: 1 }, {
      name: "uniq_platform_config_singleton",
      unique: true,
    }),
    /UNSAFE_DUPLICATE_INDEX_BUILD/
  );
  assert.deepEqual(collection.changes, ["create"]);
});

test("TTL and collation indexes are not treated as equivalent by ordinary alias shortcut", async () => {
  for (const extra of [
    { expireAfterSeconds: 1800 },
    { collation: { locale: "en", strength: 2 } },
  ]) {
    const collection = collectionWith({
      name: "singletonKey_1",
      key: { singletonKey: 1 },
      unique: true,
      ...extra,
    });
    await assert.rejects(
      ensureCollectionIndex(collection, { singletonKey: 1 }, {
        name: "uniq_platform_config_singleton", unique: true,
      }),
      /UNSAFE_DUPLICATE_INDEX_BUILD/
    );
    assert.deepEqual(collection.changes, ["create"]);
  }
});

test("network, DNS and server-selection errors trigger fail-fast classification", () => {
  for (const code of ["EAI_AGAIN", "ENOTFOUND", "ECONNRESET", "ETIMEDOUT"]) {
    assert.equal(isDatabaseConnectivityError(
      Object.assign(new Error("DNS failure"), { code })
    ), true);
  }
  assert.equal(isDatabaseConnectivityError(
    Object.assign(new Error("Server unavailable"), { name: "MongoServerSelectionError" })
  ), true);
  assert.equal(isDatabaseConnectivityError(
    new Error("getaddrinfo EAI_AGAIN academy-mongo-rehearsal-test")
  ), true);
  assert.equal(isDatabaseConnectivityError(
    Object.assign(new Error("wrapper"), {
      cause: Object.assign(new Error("DNS"), { code: "EAI_AGAIN" }),
    })
  ), true);
  assert.equal(isDatabaseConnectivityError(new Error("E11000 duplicate key error")), false);
  assert.equal(isDatabaseConnectivityError(new Error("Index already exists with a different name")), false);
});
