"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { contactSchema, publicContact, createPublicContact } = require("../src/controllers/platform/publicContactController");

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

test("valid enquiries reach SMTP with reply-to and a sanitized subject", async () => {
  const messages = [];
  const handler = createPublicContact(async (mail) => {
    messages.push(mail);
    return { accepted: ["info@classictechgroup.com"] };
  });
  const body = {
    name: "Prospective Headteacher",
    school: "Example School",
    email: "teacher@example.org",
    phone: "+256700000000",
    topic: "Admissions\r\nBcc: attacker@example.org",
    message: "Please arrange a demonstration for our school.",
    source: "contact",
    website: "",
  };
  const res = response();
  await handler(request(body), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].replyTo, body.email);
  assert.equal(messages[0].to, "info@classictechgroup.com");
  assert.ok(!/[\r\n]/.test(messages[0].subject), "SMTP subject must not contain newlines");
  assert.match(messages[0].text, /Example School/);
});

test("contact failures stay visible and do not fake a successful delivery", async () => {
  let attempts = 0;
  const handler = createPublicContact(async () => {
    attempts++;
    throw Object.assign(new Error("Sensitive SMTP error details"), { code: "ECONNECTION" });
  });
  const body = {
    name: "Valid Person",
    school: "Example School",
    email: "person@example.org",
    phone: "+256700000000",
    topic: "Demo",
    message: "Please contact our school to discuss the platform.",
    source: "home",
    website: "",
  };
  const responseFailure = response();
  const log = console.error;
  console.error = () => {};
  try {
    await handler(request(body), responseFailure);
  } finally {
    console.error = log;
  }
  assert.equal(attempts, 1);
  assert.equal(responseFailure.statusCode, 503);
  assert.equal(responseFailure.payload.ok, false);
  assert.doesNotMatch(responseFailure.payload.message, /Sensitive SMTP error/);

  const emptyHoneypot = createPublicContact(async () => {
    throw new Error("Honeypot should not send");
  });
  const spam = response();
  await emptyHoneypot(request({ ...body, website: "spam.example" }), spam);
  assert.equal(spam.statusCode, 200);
});

test("Origin enforcement fails closed for a foreign website", async () => {
  const handler = createPublicContact(async () => { throw Error("should not send"); });
  const responseDenied = response();
  await handler(request({}, { origin: "https://attacker.example" }), responseDenied);
  assert.equal(responseDenied.statusCode, 403);
});
