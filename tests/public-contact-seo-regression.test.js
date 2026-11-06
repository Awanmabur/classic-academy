"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { contactSchema, publicContact } = require("../src/controllers/platform/publicContactController");

const root = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

test("public contact validation rejects abuse and malformed payloads", () => {
  const valid = {
    name: "Test User", school: "Test School", email: "test@example.org",
    phone: "+256700000000", topic: "Admissions", message: "I would like to discuss admissions.",
    source: "home", website: "",
  };
  assert.equal(contactSchema.safeParse(valid).success, true);
  assert.equal(contactSchema.safeParse({ ...valid, email: "not an email" }).success, false);
  assert.equal(contactSchema.safeParse({ ...valid, message: "short" }).success, false);
  assert.equal(contactSchema.safeParse({ ...valid, extra: "unexpected" }).success, false);
  assert.equal(contactSchema.safeParse({ ...valid, source: "private-dashboard" }).success, false);
});

function request(body, headers = {}) {
  return { body, get: (name) => headers[name.toLowerCase()] || "" };
}
function response() {
  const r = { statusCode: 200, payload: null, headers: {} };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.status = (code) => { r.statusCode = code; return r; };
  r.json = (payload) => { r.payload = payload; return r; };
  return r;
}

test("public contact rejects cross-site and invalid requests before touching SMTP", async () => {
  const cross = response();
  await publicContact(request({}, { "sec-fetch-site": "cross-site" }), cross);
  assert.equal(cross.statusCode, 403);
  const invalid = response();
  await publicContact(request({}), invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.headers["Cache-Control"], "no-store");
});

test("every advertised general enquiry form uses one live handler, not a fake success", () => {
  for (const view of ["index", "about", "contact", "benefits", "admissions"]) {
    const html = read("views/platform/public/" + view + ".ejs");
    assert.match(html, /src="\/js\/public-contact\.js"/);
    assert.match(html, /id="contactSendBtn"/);
    assert.ok(!html.includes("info@simonmabur.com"), view + " has obsolete email");
  }
  const client = read("public/js/public-contact.js");
  assert.match(client, /fetch\("\/api\/public-contact"/);
  assert.match(client, /response\.ok/);
  for (const filename of ["public/js/public.js", "public/pages/about.js", "public/pages/contact.js", "public/pages/benefits.js", "public/pages/admissions.js"]) {
    assert.ok(!read(filename).includes("Message captured. (Connect this to your backend/email endpoint.)"), filename);
  }
  assert.match(read("src/routes/platform/pages.js"), /router\.post\("\/api\/public-contact", publicInquiryLimiter, publicContact\)/);
});

test("approved hero image markup is preserved and optional optimized asset is available", () => {
  const html = read("views/platform/public/index.ejs");
  assert.match(html, /<img src="\.\/img\/hero\.png" alt="School Building">/);
  assert.match(html, /preload" as="image" href="\/img\/hero\.png"/);
  assert.ok(!html.includes("<picture>"), "The approved image DOM contract must stay unchanged.");
  const optimized = fs.readFileSync(path.join(root, "public/img/hero.webp"));
  assert.equal(optimized.toString("ascii", 0, 4), "RIFF");
  assert.equal(optimized.toString("ascii", 8, 12), "WEBP");
  assert.ok(optimized.length < 200_000, "Optimized future asset should be smaller than 200 kB.");
});
