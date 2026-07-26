import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { packager } from "@electron/packager";
import {
  flipFuses,
  FuseV1Options,
  FuseVersion,
} from "@electron/fuses";

const execFileAsync = promisify(execFile);

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const stagingRoot = path.join(repositoryRoot, ".desktop-staging");
const releaseRoot = path.join(repositoryRoot, "release");
const applicationPackage = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
);
const electronPackage = JSON.parse(
  await readFile(
    path.join(repositoryRoot, "node_modules", "electron", "package.json"),
    "utf8",
  ),
);
const electronZipDir = process.env.ELECTRON_ZIP_DIR?.trim();
const productName = "Brace";
const legacyElectronProductName = "Base Agent";
const unusedPrivacyDescriptions = [
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
];

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });
await cp(
  path.join(repositoryRoot, "dist-desktop"),
  path.join(stagingRoot, "dist-desktop"),
  { recursive: true },
);
await cp(
  path.join(repositoryRoot, "LICENSE"),
  path.join(stagingRoot, "LICENSE"),
);
await writeFile(
  path.join(stagingRoot, "package.json"),
  `${JSON.stringify(
    {
      name: "base-agent",
      // Electron uses this internal name for existing userData and macOS
      // safeStorage entries. The operating-system product name is set below.
      productName: legacyElectronProductName,
      version: applicationPackage.version,
      main: "dist-desktop/main.cjs",
      license: applicationPackage.license,
      repository: applicationPackage.repository,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

try {
  const outputs = await packager({
    dir: stagingRoot,
    out: releaseRoot,
    name: productName,
    appVersion: applicationPackage.version,
    buildVersion: applicationPackage.version,
    appBundleId: "com.baseagent.desktop",
    appCategoryType: "public.app-category.developer-tools",
    electronVersion: electronPackage.version,
    ...(electronZipDir
      ? { electronZipDir: path.resolve(electronZipDir) }
      : {}),
    ...(process.platform === "darwin"
      ? {
          icon: path.join(
            repositoryRoot,
            "desktop",
            "assets",
            "base-agent.icns",
          ),
          extendInfo: {
            NSAppTransportSecurity: {
              NSAllowsLocalNetworking: true,
            },
          },
        }
      : {}),
    platform: process.platform,
    arch: process.arch,
    overwrite: true,
    asar: true,
    prune: false,
});
  for (const output of outputs) {
    await cp(
      path.join(repositoryRoot, "LICENSE"),
      path.join(output, "LICENSE"),
    );
    if (process.platform === "darwin") {
      const applicationPath = path.join(output, `${productName}.app`);
      const infoPlistPath = path.join(
        applicationPath,
        "Contents",
        "Info.plist",
      );
      await flipFuses(applicationPath, {
        version: FuseVersion.V1,
        strictlyRequireAllFuses: true,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
        [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
        [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
        [FuseV1Options.WasmTrapHandlers]: true,
      });
      for (const key of unusedPrivacyDescriptions) {
        try {
          await execFileAsync("/usr/bin/plutil", [
            "-extract",
            key,
            "raw",
            "-o",
            "-",
            infoPlistPath,
          ]);
        } catch {
          continue;
        }
        await execFileAsync("/usr/bin/plutil", [
          "-remove",
          key,
          infoPlistPath,
        ]);
      }
      await installMacApplicationIcon(applicationPath, infoPlistPath);
      await verifyMacApplicationIcon(applicationPath, infoPlistPath);
      await execFileAsync("/usr/bin/codesign", [
        "--force",
        "--deep",
        "--sign",
        "-",
        "--timestamp=none",
        applicationPath,
      ]);
      await execFileAsync("/usr/bin/codesign", [
        "--verify",
        "--deep",
        "--strict",
        applicationPath,
      ]);
    }
    process.stdout.write(`Packaged desktop application: ${output}\n`);
  }
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}

async function installMacApplicationIcon(applicationPath, infoPlistPath) {
  const { stdout } = await execFileAsync("/usr/bin/plutil", [
    "-extract",
    "CFBundleIconFile",
    "raw",
    "-o",
    "-",
    infoPlistPath,
  ]);
  const previousIconFile = stdout.trim();
  const previousIconName = path.extname(previousIconFile)
    ? previousIconFile
    : `${previousIconFile}.icns`;
  const brandedIconName = "base-agent.icns";
  const resourcesPath = path.join(applicationPath, "Contents", "Resources");
  await cp(
    path.join(repositoryRoot, "desktop", "assets", brandedIconName),
    path.join(resourcesPath, brandedIconName),
  );
  await execFileAsync("/usr/bin/plutil", [
    "-replace",
    "CFBundleIconFile",
    "-string",
    brandedIconName,
    infoPlistPath,
  ]);
  if (previousIconName && previousIconName !== brandedIconName) {
    await rm(path.join(resourcesPath, previousIconName), { force: true });
  }
}

async function verifyMacApplicationIcon(applicationPath, infoPlistPath) {
  const { stdout } = await execFileAsync("/usr/bin/plutil", [
    "-extract",
    "CFBundleIconFile",
    "raw",
    "-o",
    "-",
    infoPlistPath,
  ]);
  const iconFile = stdout.trim();
  if (!iconFile) {
    throw new Error("Packaged application has no CFBundleIconFile.");
  }
  const bundledIconPath = path.join(
    applicationPath,
    "Contents",
    "Resources",
    path.extname(iconFile) ? iconFile : `${iconFile}.icns`,
  );
  const sourceIconPath = path.join(
    repositoryRoot,
    "desktop",
    "assets",
    "base-agent.icns",
  );
  const [sourceIcon, bundledIcon] = await Promise.all([
    readFile(sourceIconPath),
    readFile(bundledIconPath),
  ]);
  if (!bundledIcon.equals(sourceIcon)) {
    throw new Error(
      `Packaged icon ${path.basename(bundledIconPath)} does not match the ${productName} icon.`,
    );
  }

  const electronFallbackPath = path.join(
    repositoryRoot,
    "node_modules",
    "electron",
    "dist",
    "Electron.app",
    "Contents",
    "Resources",
    "electron.icns",
  );
  const fallbackIcon = await readFile(electronFallbackPath).catch(() => null);
  if (fallbackIcon?.equals(bundledIcon)) {
    throw new Error("Packaged application still contains the Electron icon.");
  }
}
