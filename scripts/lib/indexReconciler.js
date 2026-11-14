function indexName(fields, options = {}) {
  return (
    options.name ||
    Object.entries(fields)
      .map(([field, direction]) => `${field}_${direction}`)
      .join("_")
  );
}

function sameKey(a = {}, b = {}) {
  const aa = Object.entries(a);
  const bb = Object.entries(b);

  return (
    aa.length === bb.length &&
    aa.every(
      ([key, value], i) =>
        bb[i]?.[0] === key &&
        bb[i]?.[1] === value
    )
  );
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);

  if (
    !value ||
    typeof value !== "object" ||
    value instanceof Date
  ) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])])
  );
}


function isTextIndexFields(fields = {}) {
  return Object.values(fields).some(
    (value) => value === "text"
  );
}

/*
 * MongoDB does not return the original text-index fields in
 * index.key. Instead, a text index is represented internally as:
 *
 *   { _fts: "text", _ftsx: 1 }
 *
 * with the original indexed fields stored in index.weights.
 *
 * For compound text indexes, non-text key fields remain around
 * that internal text marker. Reconstruct the internal key shape
 * so key-order semantics remain comparable.
 */
function internalTextKey(fields = {}) {
  const entries = [];
  let markerAdded = false;

  for (const [field, direction] of Object.entries(fields)) {
    if (direction === "text") {
      if (!markerAdded) {
        entries.push(
          ["_fts", "text"],
          ["_ftsx", 1]
        );

        markerAdded = true;
      }

      continue;
    }

    entries.push([field, direction]);
  }

  return Object.fromEntries(entries);
}

function expectedTextWeights(fields = {}, options = {}) {
  const configuredWeights =
    options.weights &&
    typeof options.weights === "object"
      ? options.weights
      : {};

  const weights = {};

  for (const [field, direction] of Object.entries(fields)) {
    if (direction !== "text") continue;

    const configured =
      configuredWeights[field];

    weights[field] =
      configured === undefined
        ? 1
        : Number(configured);
  }

  return weights;
}

function sameTextIndex(existing, fields, options = {}) {
  if (!isTextIndexFields(fields)) {
    return false;
  }

  if (
    !sameKey(
      existing?.key,
      internalTextKey(fields)
    )
  ) {
    return false;
  }

  const actualWeights =
    stable(existing?.weights || {});

  const desiredWeights =
    stable(
      expectedTextWeights(
        fields,
        options
      )
    );

  if (
    JSON.stringify(actualWeights) !==
    JSON.stringify(desiredWeights)
  ) {
    return false;
  }

  /*
   * These are MongoDB's defaults when the schema does not
   * explicitly override them. Comparing defaults means a future
   * schema change to either option will be detected instead of
   * silently accepting an incompatible text index.
   */
  const actualDefaultLanguage =
    existing?.default_language || "english";

  const desiredDefaultLanguage =
    options.default_language || "english";

  if (
    actualDefaultLanguage !==
    desiredDefaultLanguage
  ) {
    return false;
  }

  const actualLanguageOverride =
    existing?.language_override || "language";

  const desiredLanguageOverride =
    options.language_override || "language";

  if (
    actualLanguageOverride !==
    desiredLanguageOverride
  ) {
    return false;
  }

  if (
    options.textIndexVersion !== undefined &&
    Number(existing?.textIndexVersion) !==
      Number(options.textIndexVersion)
  ) {
    return false;
  }

  return true;
}

function sameIndexKey(existing, fields, options = {}) {
  if (isTextIndexFields(fields)) {
    return sameTextIndex(
      existing,
      fields,
      options
    );
  }

  return sameKey(
    existing?.key,
    fields
  );
}

function sameIndex(existing, fields, options = {}) {
  if (!sameIndexKey(existing, fields, options)) return false;

  if (
    Boolean(existing.unique) !==
    Boolean(options.unique)
  ) {
    return false;
  }

  if (
    Boolean(existing.sparse) !==
    Boolean(options.sparse)
  ) {
    return false;
  }

  if (
    JSON.stringify(
      stable(existing.partialFilterExpression || null)
    ) !==
    JSON.stringify(
      stable(options.partialFilterExpression || null)
    )
  ) {
    return false;
  }

  if (
    options.name &&
    existing.name !== options.name
  ) {
    return false;
  }

  return true;
}

function duplicateMatch(fields, options = {}) {
  if (options.partialFilterExpression) {
    return options.partialFilterExpression;
  }

  if (options.sparse) {
    const keys = Object.keys(fields);

    return keys.length === 1
      ? {
          [keys[0]]: {
            $exists: true,
          },
        }
      : {
          $or: keys.map((key) => ({
            [key]: {
              $exists: true,
            },
          })),
        };
  }

  return {};
}

async function findDuplicate(
  collection,
  fields,
  options = {}
) {
  if (!options.unique) return null;

  const groupId = Object.fromEntries(
    Object.keys(fields).map((field) => [
      field.replaceAll(".", "__"),
      `$${field}`,
    ])
  );

  const rows = await collection
    .aggregate([
      {
        $match: duplicateMatch(fields, options),
      },
      {
        $group: {
          _id: groupId,
          count: {
            $sum: 1,
          },
        },
      },
      {
        $match: {
          count: {
            $gt: 1,
          },
        },
      },
      {
        $limit: 1,
      },
    ])
    .toArray();

  return rows[0] || null;
}

function isIndexNotFound(err) {
  return (
    err?.code === 27 ||
    err?.codeName === "IndexNotFound" ||
    /index not found/i.test(
      String(err?.message || "")
    )
  );
}

async function dropIndexIfPresent(
  collection,
  name
) {
  try {
    await collection.dropIndex(name);
    return true;
  } catch (err) {
    /*
     * Another reconciliation path may already have
     * removed the conflicting index after indexes()
     * was read. That means the desired end state is
     * still achievable and this is not a failure.
     */
    if (isIndexNotFound(err)) {
      return false;
    }

    throw err;
  }
}


function isNamespaceNotFound(err) {
  return (
    err?.code === 26 ||
    err?.codeName === "NamespaceNotFound"
  );
}

async function listIndexesIfCollectionExists(collection) {
  if (!collection) return [];

  try {
    if (typeof collection.indexes === "function") {
      return await collection.indexes();
    }

    if (typeof collection.listIndexes === "function") {
      return await collection.listIndexes().toArray();
    }

    return [];
  } catch (err) {
    /*
     * A not-yet-created collection legitimately has no
     * indexes. All other errors must remain visible.
     */
    if (isNamespaceNotFound(err)) {
      return [];
    }

    throw err;
  }
}

async function ensureCollectionIndex(
  collection,
  fields,
  options = {}
) {
  const desiredName = indexName(
    fields,
    options
  );

  /*
   * First read: fast-path when the exact desired
   * definition already exists.
   */
  let indexes = await collection.indexes();

  let exact = indexes.find((item) =>
    sameIndex(item, fields, options)
  );

  if (exact) {
    return {
      status: "existing",
      name: exact.name,
      dropped: [],
    };
  }

  /*
   * Validate unique-index safety before replacing
   * any existing index.
   */
  const duplicate = await findDuplicate(
    collection,
    fields,
    options
  );

  if (duplicate) {
    const err = new Error(
      `Cannot create unique index ${desiredName}: ` +
      `duplicate key group exists ` +
      `(${JSON.stringify(duplicate._id)}).`
    );

    err.code = "INDEX_DUPLICATES_PRESENT";

    throw err;
  }

  /*
   * Refresh immediately before destructive work.
   * This avoids relying on a stale index list.
   */
  indexes = await collection.indexes();

  exact = indexes.find((item) =>
    sameIndex(item, fields, options)
  );

  if (exact) {
    return {
      status: "existing",
      name: exact.name,
      dropped: [],
    };
  }

  const conflicts = indexes.filter(
    (item) =>
      item.name !== "_id_" &&
      (
        item.name === desiredName ||
        sameIndexKey(item, fields, options)
      )
  );

  const dropped = [];

  for (const item of conflicts) {
    const removed =
      await dropIndexIfPresent(
        collection,
        item.name
      );

    if (removed) {
      dropped.push(item.name);
    }
  }

  /*
   * A parallel path may have created the desired
   * index while conflicts were being removed.
   */
  indexes = await collection.indexes();

  exact = indexes.find((item) =>
    sameIndex(item, fields, options)
  );

  if (exact) {
    return {
      status: dropped.length
        ? "replaced"
        : "existing",
      name: exact.name,
      dropped,
    };
  }

  const createdName =
    await collection.createIndex(
      fields,
      options
    );

  return {
    status: dropped.length
      ? "replaced"
      : "created",

    name:
      createdName ||
      desiredName,

    dropped,
  };
}

module.exports = {
  indexName,
  sameKey,
  isTextIndexFields,
  internalTextKey,
  expectedTextWeights,
  sameTextIndex,
  sameIndexKey,
  sameIndex,
  duplicateMatch,
  findDuplicate,
  isIndexNotFound,
  isNamespaceNotFound,
  listIndexesIfCollectionExists,
  dropIndexIfPresent,
  ensureCollectionIndex,
};
