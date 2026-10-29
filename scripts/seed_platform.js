require("dotenv").config({ quiet: true });

const bcrypt = require("bcrypt");
const { platformConnection, waitForPlatform } = require("../src/config/db");
const PlatformUser = require("../src/models/platform/PlatformUser")(platformConnection);

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main() {
  const adminEmail = requiredEnv("PLATFORM_SEED_ADMIN_EMAIL").toLowerCase();
  const adminPassword = String(process.env.PLATFORM_SEED_ADMIN_PASSWORD || "");
  const firstName = String(process.env.PLATFORM_SEED_ADMIN_FIRST_NAME || "Platform").trim() || "Platform";
  const lastName = String(process.env.PLATFORM_SEED_ADMIN_LAST_NAME || "Administrator").trim() || "Administrator";

  if (adminPassword.length < 12) {
    throw new Error("PLATFORM_SEED_ADMIN_PASSWORD must be at least 12 characters.");
  }

  await waitForPlatform();

  const existing = await PlatformUser.findOne({
    email: adminEmail,
    isDeleted: { $ne: true },
  }).lean();

  if (existing) {
    console.log(`SuperAdmin already exists: ${adminEmail}`);
    return;
  }

  const passwordHash = await bcrypt.hash(adminPassword, 12);
  const created = await PlatformUser.create({
    firstName,
    lastName,
    email: adminEmail,
    passwordHash,
    role: "SuperAdmin",
    isActive: true,
    revision: 1,
  });

  console.log(`SuperAdmin created: ${created.email}`);
}

main()
  .catch((error) => {
    console.error("Platform SuperAdmin seed failed:", error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await platformConnection.close().catch(() => {});
  });
