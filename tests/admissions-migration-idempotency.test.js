const test = require("node:test");
const assert = require("node:assert/strict");

const {
  migrateAdmissions,
} = require("../scripts/lib/migrateAdmissions");

const {
  normalizeChecklist,
} = require("../src/services/tenant/admissionsService");

function query(rows) {
  return {
    sort() {
      return this;
    },
    async lean() {
      return rows.map((row) => ({
        ...row,
        reviewChecklist: row.reviewChecklist
          ? { ...row.reviewChecklist }
          : row.reviewChecklist,
        tags: Array.isArray(row.tags)
          ? [...row.tags]
          : row.tags,
      }));
    },
  };
}

test(
  "converted applicant with cleared conversion lease is not rewritten",
  async () => {
    const applicant = {
      _id: "applicant-1",
      applicationId: "APP-2026-00000001",
      isDeleted: false,

      status: "converted",

      reviewChecklist: normalizeChecklist({}),
      tags: [],
      interviewMode: "",

      conversionLockToken: "",
      conversionLockAt: null,
      conversionLockBy: null,

      passportPhoto: null,
      idDocument: null,
      transcript: null,
      otherDocs: [],
    };

    let applicantUpdates = 0;

    const Applicant = {
      find() {
        return query([applicant]);
      },

      async updateOne() {
        applicantUpdates += 1;
        return {
          matchedCount: 1,
          modifiedCount: 1,
        };
      },
    };

    const OfferLetter = {
      find() {
        return query([]);
      },

      async updateOne() {
        throw new Error(
          "OfferLetter must not be modified in this test",
        );
      },
    };

    const result = await migrateAdmissions({
      Applicant,
      OfferLetter,
    });

    assert.equal(result.applicantsScanned, 1);
    assert.equal(result.normalizedApplicants, 0);
    assert.equal(result.repairedApplicationIds, 0);
    assert.equal(result.repairedLetterNumbers, 0);
    assert.equal(applicantUpdates, 0);
  },
);
