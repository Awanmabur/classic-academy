const test = require("node:test");
const assert = require("node:assert/strict");

const {
  migrateParents,
} = require("../scripts/lib/migrateParents");

function query(result) {
  return {
    sort() {
      return this;
    },

    select() {
      return this;
    },

    lean() {
      return Promise.resolve(result);
    },

    toArray() {
      return Promise.resolve(result);
    },
  };
}

test(
  "parent migration does not touch User when child links and lifecycle are already canonical",
  async () => {
    const userId = "64a000000000000000000001";
    const parentId = "64a000000000000000000002";
    const childId = "64a000000000000000000003";

    const parent = {
      _id: parentId,
      userId,
      email: "parent@example.com",
      firstName: "Parent",
      lastName: "User",
      phone: "",
      status: "active",
      isDeleted: false,

      addressLine1: "",
      addressLine2: "",
      city: "",
      country: "",
      occupation: "",
      notes: "",

      childrenStudentIds: [childId],
    };

    const user = {
      _id: userId,
      roles: ["parent"],
      status: "active",
      tokenVersion: 0,
      childrenStudentIds: [childId],
      parentAccessSuspended: false,
      parentAccessPreviousStatus: null,
    };

    let userUpdates = 0;

    const Parent = {
      collection: {
        async indexes() {
          return [];
        },

        find() {
          return query([parent]);
        },

        async updateOne() {
          return {
            matchedCount: 1,
            modifiedCount: 0,
          };
        },
      },

      find() {
        return query([parent]);
      },

      async updateOne() {
        return {
          matchedCount: 1,
          modifiedCount: 0,
        };
      },

      findOne() {
        return query(null);
      },

      async create() {
        throw new Error(
          "canonical parent migration must not create a new parent",
        );
      },
    };

    const User = {
      findOne() {
        return query(user);
      },

      find() {
        return query([]);
      },

      async updateOne() {
        userUpdates += 1;

        return {
          matchedCount: 1,
          modifiedCount: 1,
        };
      },
    };

    const result = await migrateParents({
      Parent,
      User,
    });

    assert.equal(result.normalized, 0);
    assert.equal(result.userLinksBackfilled, 0);
    assert.equal(result.profilesCreated, 0);

    assert.equal(
      userUpdates,
      0,
      "canonical User must not receive a no-op timestamp-changing update",
    );
  },
);
