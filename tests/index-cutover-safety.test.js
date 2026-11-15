"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ensureCollectionIndex,
  dropIndexIfPresent,
} = require("../scripts/lib/indexReconciler");

function fixture({ oldName = "code_1", unique = false } = {}) {
  const events = [];
  let indexes = [
    { name: "_id_", key: { _id: 1 } },
    { name: oldName, key: { code: 1 }, unique },
  ];
  const collection = {
    indexes: async () => indexes.map((x) => ({ ...x })),
    aggregate: () => ({ toArray: async () => [] }),
    dropIndex: async (name) => {
      events.push(["drop", name]);
      indexes = indexes.filter((index) => index.name !== name);
    },
    createIndex: async (fields, options) => {
      events.push(["create", options.name]);
      indexes.push({
        name: options.name,
        key: fields,
        unique: options.unique,
        sparse: options.sparse,
        partialFilterExpression: options.partialFilterExpression,
      });
      return options.name;
    },
  };
  return { collection, events, current: () => indexes };
}

test("injected createIndex failure preserves existing index and never calls dropIndex", async () => {
  const { collection, events, current } = fixture();
  collection.createIndex = async () => {
    events.push(["create", "rejected"]);
    throw new Error("INJECTED_INDEX_BUILD_FAILURE");
  };
  await assert.rejects(
    ensureCollectionIndex(collection, { code: 1 }, { name: "uniq_code", unique: true }),
    /INJECTED_INDEX_BUILD_FAILURE/
  );
  assert.deepEqual(events, [["create", "rejected"]]);
  assert.ok(current().some((index) => index.name === "code_1"));
});

test("incompatible index with the desired name fails closed, without any mutations", async () => {
  const { collection, events, current } = fixture({ oldName: "uniq_code" });
  await assert.rejects(
    ensureCollectionIndex(collection, { code: 1 }, { name: "uniq_code", unique: true }),
    (error) => error.code === "INDEX_MAINTENANCE_REQUIRED"
  );
  assert.deepEqual(events, []);
  assert.ok(current().some((index) => index.name === "uniq_code"));
});

test("driver claiming success without a verifiable index never removes the old index", async () => {
  const { collection, events, current } = fixture();
  collection.createIndex = async () => {
    events.push(["create", "unverified"]);
    return "uniq_code";
  };
  await assert.rejects(
    ensureCollectionIndex(collection, { code: 1 }, { name: "uniq_code", unique: true }),
    (error) => error.code === "INDEX_REPLACEMENT_UNVERIFIED"
  );
  assert.equal(events.filter(([event]) => event === "drop").length, 0);
  assert.ok(current().some((index) => index.name === "code_1"));
});

test("direct legacy migration drop requires a verified compatible replacement", async () => {
  const { collection, events, current } = fixture();
  await assert.rejects(
    dropIndexIfPresent(collection, "code_1"),
    (error) => error.code === "INDEX_MAINTENANCE_REQUIRED"
  );
  await assert.rejects(
    dropIndexIfPresent(collection, "code_1", {
      replacementName: "nonexistent",
      replacementFields: { code: 1 },
      replacementOptions: { unique: true, name: "nonexistent" },
    }),
    (error) => error.code === "INDEX_MAINTENANCE_REQUIRED"
  );
  assert.deepEqual(events, []);
  assert.ok(current().some((index) => index.name === "code_1"));
});

test("verified replacement allows idempotent safe retirement of old index", async () => {
  const { collection, events, current } = fixture({ unique: true });
  await collection.createIndex({ code: 1 }, {
    name: "uniq_active_code",
    unique: true,
    partialFilterExpression: { isDeleted: false },
  });
  assert.equal(await dropIndexIfPresent(collection, "code_1", {
    replacementName: "uniq_active_code",
    replacementFields: { code: 1 },
    replacementOptions: {
      name: "uniq_active_code",
      unique: true,
      partialFilterExpression: { isDeleted: false },
    },
  }), true);
  assert.equal(events[0][0], "create");
  assert.deepEqual(events[1], ["drop", "code_1"]);
  assert.ok(current().some((index) => index.name === "uniq_active_code"));
  assert.equal(await dropIndexIfPresent(collection, "code_1"), false);
});

test("exact existing index remains idempotent and never rebuilds or drops", async () => {
  const { collection, events } = fixture();
  await collection.createIndex({ code: 1 }, { name: "uniq_code", unique: true });
  events.length = 0;
  const result = await ensureCollectionIndex(collection, { code: 1 }, {
    name: "uniq_code",
    unique: true,
  });
  assert.equal(result.status, "existing");
  assert.deepEqual(events, []);
});
