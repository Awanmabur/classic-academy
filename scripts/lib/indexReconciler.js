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

// An existing index may have a different name but identical enforcement and
// query behavior. Reuse it rather than dropping/rebuilding just to rename.
// Limit this optimization to ordinary B-tree index options we can compare
// completely; specialized indexes require an explicit maintenance review.
function equivalentIndexWithDifferentName(existing, fields, options = {}) {
  const allowedDesired = new Set([
    "name", "unique", "sparse", "partialFilterExpression",
  ]);
  const allowedExisting = new Set([
    "v", "ns", "name", "key", "unique", "sparse",
    "partialFilterExpression",
  ]);

  if (
    Object.keys(options).some((key) => !allowedDesired.has(key)) ||
    Object.keys(existing || {}).some((key) => !allowedExisting.has(key)) ||
    Object.values(fields).some((value) => value !== 1 && value !== -1)
  ) {
    return false;
  }

  const withoutName = { ...options };
  delete withoutName.name;
  return sameIndex(existing, fields, withoutName);
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
  name,
  { replacementName, replacementFields, replacementOptions = {} } = {}
) {
  if (!name || name === "_id_") {
    const error = new Error("Refusing to drop an unnamed or primary index.");
    error.code = "INDEX_MAINTENANCE_REQUIRED";
    throw error;
  }

  const indexes = await listIndexesIfCollectionExists(collection);
  if (!indexes.some((index) => index.name === name)) return false;

  // Legacy migrations must never remove a live index without first
  // building and verifying its replacement. An operator must handle
  // incompatible same-name definitions in a controlled maintenance window.
  const replacement = replacementName && replacementName !== name &&
    indexes.find((index) =>
      index.name === replacementName &&
      sameIndex(index, replacementFields, replacementOptions)
    );
  if (!replacement) {
    const error = new Error(
      `Refusing to drop ${name}: a compatible replacement must be built and verified first.`
    );
    error.code = "INDEX_MAINTENANCE_REQUIRED";
    throw error;
  }

  try {
    await collection.dropIndex(name);
    return true;
  } catch (error) {
    if (isIndexNotFound(error)) return false;
    throw error;
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

  // A compatible index may already exist under a legacy name.
  // Do not treat a naming difference alone as a reason to rebuild it.
  // Do not mask an incompatible index already using the desired name.
  if (!indexes.some((item) => item.name === desiredName)) {
    const equivalent = indexes.find((item) =>
      equivalentIndexWithDifferentName(item, fields, options)
    );
    if (equivalent) {
      return {
        status: "existing",
        name: equivalent.name,
        dropped: [],
      };
    }
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

  // A compatible index may already exist under a legacy name.
  // Do not treat a naming difference alone as a reason to rebuild it.
  // Do not mask an incompatible index already using the desired name.
  if (!indexes.some((item) => item.name === desiredName)) {
    const equivalent = indexes.find((item) =>
      equivalentIndexWithDifferentName(item, fields, options)
    );
    if (equivalent) {
      return {
        status: "existing",
        name: equivalent.name,
        dropped: [],
      };
    }
  }

  const conflicts = indexes.filter(
    (item) =>
      item.name !== "_id_" &&
      (
        item.name === desiredName ||
        sameIndexKey(item, fields, options)
      )
  );

  // Same-name option changes cannot be safely rebuilt in-place.
  // Never drop the existing index merely to make createIndex() succeed.
  if (conflicts.some((item) => item.name === desiredName)) {
    const error = new Error(
      `Index ${desiredName} has incompatible options under the same name. ` +
      "A planned maintenance cutover and verified backup are required."
    );
    error.code = "INDEX_MAINTENANCE_REQUIRED";
    throw error;
  }

  // Build first, without dropping the previous constraint or query index.
  // MongoDB permits some side-by-side index definitions, but rejects others.
  // If the server rejects the build, leave every old index untouched.
  const createdName = await collection.createIndex(fields, options);

  if (!conflicts.length) {
    return { status: "created", name: createdName || desiredName, dropped: [] };
  }

  // A successful driver return is not enough to authorize destructive work:
  // verify the exact definition on MongoDB before removing the old index.
  indexes = await collection.indexes();
  exact = indexes.find((item) =>
    item.name === (createdName || desiredName) &&
    sameIndex(item, fields, options)
  );
  if (!exact) {
    const error = new Error(
      `New index ${desiredName} could not be verified; old indexes were kept.`
    );
    error.code = "INDEX_REPLACEMENT_UNVERIFIED";
    throw error;
  }

  const dropped = [];
  for (const item of conflicts) {
    const removed = await dropIndexIfPresent(collection, item.name, {
      replacementName: exact.name,
      replacementFields: fields,
      replacementOptions: options,
    });
    if (removed) dropped.push(item.name);
  }

  return {
    status: dropped.length ? "replaced" : "existing",
    name: exact.name,
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
