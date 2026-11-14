"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const cases = [
  ["Assignments", "scripts/lib/migrateAssignments.js", "async function migrateAssignments", "await ensureSubmissionIndex(AssignmentSubmission)", "await dropConflictingSubmissionIndexes(AssignmentSubmission)"],
  ["Attendance", "scripts/lib/migrateAttendance.js", "async function migrateAttendance", "await ensureIndex(Attendance)", "await dropConflictingIndexes(Attendance)"],
  ["Exams", "scripts/lib/migrateExams.js", "async function migrateExams", "await ensureExamIndex(Exam)", "await dropConflictingExamIndexes(Exam)"],
  ["Results", "scripts/lib/migrateResults.js", "async function migrateResults", "await ensureResultIndex(Result)", "await dropConflictingResultIndexes(Result)"],
  ["Transcripts", "scripts/lib/migrateTranscripts.js", "async function migrateTranscripts", "await ensureTranscriptIndex(Transcript)", "await dropConflictingTranscriptIndexes(Transcript)"],
];

for (const [moduleName, filename, migrationMarker, createMarker, retireMarker] of cases) {
  test(`${moduleName} completes data migration and builds index before retiring legacy constraints`, () => {
    const source = fs.readFileSync(path.join(root, filename), "utf8");
    const migrationStart = source.indexOf(migrationMarker);
    assert.ok(migrationStart >= 0, `${filename}: migration entry missing`);
    const body = source.slice(migrationStart);
    const createdAt = body.indexOf(createMarker);
    const retiredAt = body.indexOf(retireMarker);
    assert.ok(createdAt >= 0, `${filename}: index build missing`);
    assert.ok(retiredAt > createdAt, `${filename}: legacy index retired before replacement built`);
    const dropFunction = source.slice(0, migrationStart);
    assert.match(dropFunction, /replacementName:/);
    assert.match(dropFunction, /replacementFields:/);
    assert.match(dropFunction, /replacementOptions:/);
  });
}

test("all legacy index drops are guarded and fail closed without verified replacement", () => {
  const src = fs.readFileSync(path.join(root, "scripts/lib/indexReconciler.js"), "utf8");
  assert.match(src, /INDEX_MAINTENANCE_REQUIRED/);
  assert.match(src, /INDEX_REPLACEMENT_UNVERIFIED/);
  assert.match(src, /replacementName && replacementName !== name/);
  assert.match(src, /await collection\.createIndex\(\s*fields,\s*options\s*\)/);
});
