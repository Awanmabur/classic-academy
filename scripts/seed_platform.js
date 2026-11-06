#!/usr/bin/env node
"use strict";

// This script is intentionally manual. Never invoke it at web startup,
// during migrations, or automatically during deployment.
require("dotenv").config({ quiet: true });

const bcrypt = require("bcrypt");
const { validatePasswordStrength } = require("../src/utils/passwordPolicy");

const email = String(process.env.PLATFORM_SEED_ADMIN_EMAIL || "").trim().toLowerCase();
const firstName = String(process.env.PLATFORM_SEED_ADMIN_FIRST_NAME || "").trim();
const lastName = String(process.env.PLATFORM_SEED_ADMIN_LAST_NAME || "").trim();
const adminPassword = String(process.env.PLATFORM_SEED_ADMIN_PASSWORD || "");
const PASSWORD_MIN_LENGTH = 16;

function validateBootstrapInputs() {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 180) {
    throw new Error("PLATFORM_SEED_ADMIN_EMAIL must be a valid email address.");
  }
  if (!firstName || !lastName || firstName.length > 80 || lastName.length > 80) {
    throw new Error("Both platform administrator names are required (maximum 80 characters each).");
  }
  if (adminPassword.length < PASSWORD_MIN_LENGTH) {
    throw new Error("PLATFORM_SEED_ADMIN_PASSWORD must contain at least 16 characters.");
  }
  const policyError = validatePasswordStrength(adminPassword, { minLength: PASSWORD_MIN_LENGTH });
  if (policyError) throw new Error("PLATFORM_SEED_ADMIN_PASSWORD fails the platform password policy.");
}

async function main() {
  // Do not open a database connection until required credentials are checked.
  validateBootstrapInputs();
  const { platformConnection, waitForPlatform } = require("../src/config/db");
  const PlatformUser = require("../src/models/platform/PlatformUser")(platformConnection);

  try {
    await waitForPlatform();
    // Refuse to create a second administrator or revive an old deployment.
    if (await PlatformUser.exists({})) {
      throw new Error("Platform users already exist. Bootstrap is disabled; use authorized platform administration.");
    }

    // MongoDB's unique _id makes concurrent first-admin bootstrap attempts fail closed.
    // A failed attempt leaves a claim for investigation instead of silently retrying
    // or granting privileges to another account.
    const bootstrapClaims = platformConnection.db.collection("_bootstrap_state");
    await bootstrapClaims.insertOne({
      _id: "platform-initial-superadmin",
      status: "claimed",
      createdAt: new Date(),
    });

    const passwordHash = await bcrypt.hash(adminPassword, 12);
    await PlatformUser.create({
      firstName,
      lastName,
      email,
      passwordHash,
      role: "SuperAdmin",
      isActive: true,
      isDeleted: false,
      tokenVersion: 0,
      revision: 1,
      passwordChangedAt: new Date(),
    });

    await bootstrapClaims.updateOne(
      { _id: "platform-initial-superadmin", status: "claimed" },
      { $set: { status: "completed", completedAt: new Date() } }
    );
    console.log("Platform SuperAdmin bootstrap completed. No credentials were printed.");
  } finally {
    await platformConnection.close().catch(() => {});
  }
}

main().catch((error) => {
  // Never echo environment variables, database connection URLs or passwords.
  console.error("Platform SuperAdmin bootstrap stopped:", error?.code === 11000
    ? "A bootstrap has already been claimed."
    : error?.message?.startsWith("PLATFORM_SEED_ADMIN_") || error?.message?.startsWith("Both platform") || error?.message?.startsWith("Platform users")
      ? error.message
      : "Please inspect the database and bootstrap claim before retrying.");
  process.exitCode = 1;
});
