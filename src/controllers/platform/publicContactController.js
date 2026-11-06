"use strict";
const { z } = require("zod");
const { sendMail } = require("../../utils/mailer");

const clean = (value) => String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
const contactSchema = z.object({
  name: z.string().trim().min(2).max(120),
  school: z.string().trim().max(200).optional().default(""),
  email: z.email().max(200),
  phone: z.string().trim().min(6).max(60),
  topic: z.string().trim().max(160).optional().default("General enquiry"),
  message: z.string().trim().min(10).max(4000),
  website: z.string().max(200).optional().default(""),
  source: z.enum(["home", "about", "contact", "benefits", "admissions", "plan"]).optional().default("home"),
}).strict();

async function publicContact(req, res) {
  res.set("Cache-Control", "no-store");
  // Prevent browser-origin cross-site submissions. Server-to-server callers
  // still face the distributed rate limiter and the strict data validation.
  const browserSite = String(req.get("sec-fetch-site") || "").toLowerCase();
  if (browserSite && !["same-origin", "none"].includes(browserSite)) {
    return res.status(403).json({ ok: false, message: "This request is not allowed." });
  }
  const origin = req.get("origin");
  if (origin) {
    const allowed = process.env.PUBLIC_SITE_URL || process.env.PLATFORM_SITE_URL || "";
    try {
      if (!allowed || new URL(origin).origin !== new URL(allowed).origin) {
        return res.status(403).json({ ok: false, message: "This request is not allowed." });
      }
    } catch (_) {
      return res.status(403).json({ ok: false, message: "This request is not allowed." });
    }
  }

  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, message: "Please check your name, email, phone and message." });
  }
  const data = parsed.data;
  // Honeypot: acknowledge quietly and send nothing; never leak a spam signal.
  if (data.website) return res.status(200).json({ ok: true, message: "Thank you for contacting us." });

  const subjectTopic = clean(data.topic).replace(/[\r\n]+/g, " ").slice(0, 100);
  const content = [
    "New Classic Academy public enquiry",
    "Source: " + data.source,
    "Name: " + clean(data.name),
    "School: " + clean(data.school),
    "Email: " + clean(data.email),
    "Phone: " + clean(data.phone),
    "Topic: " + subjectTopic,
    "",
    clean(data.message),
  ].join("\n");

  try {
    const result = await sendMail({
      to: process.env.CLASSIC_ACADEMY_CONTACT_TO || "info@classictechgroup.com",
      subject: "Classic Academy enquiry: " + subjectTopic,
      replyTo: data.email,
      text: content,
    });
    // SMTP accepting the message is not the same as verified inbox delivery.
    if (!result?.accepted?.length) throw new Error("SMTP rejected all recipients");
    return res.status(200).json({ ok: true, message: "Your message has been sent to our team." });
  } catch (error) {
    console.error("Classic Academy contact mail send failed:", error?.code || "MAIL_FAILURE");
    return res.status(503).json({
      ok: false,
      message: "We could not send your message. Please email info@classictechgroup.com or try again.",
    });
  }
}

module.exports = { publicContact, contactSchema };
