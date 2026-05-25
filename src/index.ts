import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import AdmZip from "adm-zip";
import * as fs from "fs";
import * as path from "path";
import { downloadFile, getInput, hashDir, hashFile, saveCacheSafe, sh, sha256 } from "./tools";

interface BuildIosOptions {
  iosCertP12: string;
  iosCertPassword: string;
  iosProfile: string;
  iosProfileUuid: string;
  iosTeamId: string;
  xcodeProject: string;
  xcodeScheme: string;
}

async function run() {
  try {
    const cocosUrl = getInput("cocos-url");

    let platform = getInput("platform");
    platform = platform.toLowerCase();

    const iosCertP12 = getInput("ios-cert-p12");
    const iosCertPassword = getInput("ios-cert-password");
    const iosProfile = getInput("ios-profile");
    const iosProfileUuid = getInput("ios-profile-uuid");
    const iosTeamId = getInput("ios-team-id");

    const xcodeProject = getInput("xcode-project");
    const xcodeScheme = getInput("xcode-scheme");

    await prepareCocos(cocosUrl);

    switch (platform) {
      case "ios":
        await buildIos({
          iosCertP12,
          iosCertPassword,
          iosProfile,
          iosProfileUuid,
          iosTeamId,
          xcodeProject,
          xcodeScheme,
        });
        break;

      default:
        throw new Error(`unsupported platform: ${platform}`);
    }
  } catch (err: any) {
    core.setFailed(err.message);
  }
}

run();

async function prepareCocos(cocosUrl: string) {
  const cocosKey = "cocos-" + sha256(cocosUrl);

  const hit = await cache.restoreCache(
    ["cocos-editor"],
    cocosKey
  );

  if (hit) {
    console.log("cocos cache hit");
    return;
  }

  fs.rmSync("cocos-editor", {
    recursive: true,
    force: true,
  });

  fs.rmSync("cocos.zip", {
    force: true,
  });

  console.log("downloading cocos creator...");

  await downloadFile(cocosUrl, "cocos.zip");

  console.log("extract cocos creator...");

  const zip = new AdmZip("cocos.zip");

  zip.extractAllTo("cocos-editor", true);

  console.log(process.platform)
  sh(`
    ls -la /Users/runner/work/zombies-coming/zombies-coming/cocos-editor/CocosCreator.app/Contents/MacOS/CocosCreator
    file /Users/runner/work/zombies-coming/zombies-coming/cocos-editor/CocosCreator.app/Contents/MacOS/CocosCreator
    `)

  await saveCacheSafe(
    ["cocos-editor"],
    cocosKey
  );
}

function findCocosCreatorBinary(): string {
  const result: string[] = [];

  function walk(dir: string) {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      const full = path.join(dir, file);

      if (!fs.existsSync(full)) continue;

      const stat = fs.statSync(full);

      if (stat.isDirectory()) {
        walk(full);
      } else {
        const normalized = full.replace(/\\/g, "/");

        if (
          normalized.includes("CocosCreator.app/Contents/MacOS/CocosCreator")
        ) {
          result.push(full);
        }
      }
    }
  }

  walk("cocos-editor");

  if (result.length === 0) {
    throw new Error("CocosCreator binary not found after extraction");
  }

  return result[0];
}

async function buildIos(options: BuildIosOptions) {
  const {
    iosCertP12,
    iosCertPassword,
    iosProfile,
    iosProfileUuid,
    iosTeamId,
    xcodeProject,
    xcodeScheme,
  } = options;

  const home = process.env.HOME!;

  /*
   |--------------------------------------------------------------------------
   | npm cache
   |--------------------------------------------------------------------------
   */

  const lockHash = fs.existsSync("package-lock.json")
    ? hashFile("package-lock.json")
    : "no-lock";

  const npmCacheKey = `npm-${lockHash}`;

  const npmHit = await cache.restoreCache(
    [`${home}/.npm`],
    npmCacheKey
  );

  if (npmHit) {
    console.log("npm cache hit");
  } else {
    console.log("npm cache miss");
  }

  await exec.exec("npm", ["ci"]);

  if (!npmHit) {
    await saveCacheSafe(
      [`${home}/.npm`],
      npmCacheKey
    );
  }

  /*
   |--------------------------------------------------------------------------
   | cocos build cache
   |--------------------------------------------------------------------------
   */

  const assetsHash = fs.existsSync("assets")
    ? hashDir("assets")
    : "no-assets";

  const buildConfigHash = fs.existsSync(
    "./build-config/buildConfig_ios.json"
  )
    ? hashFile("./build-config/buildConfig_ios.json")
    : "no-build-config";

  const cocosBuildKey = sha256(
    lockHash + assetsHash + buildConfigHash
  );

  await cache.restoreCache(
    ["library", "temp", "build"],
    `cocos-build-${cocosBuildKey}`
  );

  /*
   |--------------------------------------------------------------------------
   | xcode derived data cache
   |--------------------------------------------------------------------------
   */

  const derivedData = `${home}/Library/Developer/Xcode/DerivedData`;

  const moduleCache =
    `${home}/Library/Developer/Xcode/DerivedData/ModuleCache.noindex`;

  await cache.restoreCache(
    [derivedData, moduleCache],
    `xcode-${process.platform}`
  );

  /*
   |--------------------------------------------------------------------------
   | cocos build
   |--------------------------------------------------------------------------
   */

  const cocosCreator = findCocosCreatorBinary();

  await exec.exec(cocosCreator, [
    "--project",
    ".",
    "--build",
    "platform=ios;configPath=./build-config/buildConfig_ios.json",
  ]);

  if (!fs.existsSync("./build/ios/proj")) {
    throw new Error("cocos build failed");
  }

  await saveCacheSafe(
    ["library", "temp", "build"],
    `cocos-build-${cocosBuildKey}`
  );

  /*
   |--------------------------------------------------------------------------
   | certificate
   |--------------------------------------------------------------------------
   */

  const certBuffer = Buffer.from(
    iosCertP12,
    "base64"
  );

  fs.writeFileSync("cert.p12", certBuffer);

  await sh(`
    security create-keychain -p "" build.keychain

    security list-keychains -d user -s build.keychain

    security default-keychain -s build.keychain

    security unlock-keychain -p "" build.keychain

    security import cert.p12 \
      -k build.keychain \
      -P "${iosCertPassword}" \
      -T /usr/bin/codesign

    security set-key-partition-list \
      -S apple-tool:,apple: \
      -s \
      -k "" \
      build.keychain
  `);

  /*
   |--------------------------------------------------------------------------
   | provisioning profile
   |--------------------------------------------------------------------------
   */

  const profileBuffer = Buffer.from(
    iosProfile,
    "base64"
  );

  fs.writeFileSync(
    "profile.mobileprovision",
    profileBuffer
  );

  const profileDir =
    `${home}/Library/MobileDevice/Provisioning Profiles`;

  fs.mkdirSync(profileDir, {
    recursive: true,
  });

  fs.copyFileSync(
    "profile.mobileprovision",
    `${profileDir}/${iosProfileUuid}.mobileprovision`
  );

  /*
   |--------------------------------------------------------------------------
   | xcode archive
   |--------------------------------------------------------------------------
   */

  await exec.exec("xcodebuild", [
    "-project",
    xcodeProject,
    "-scheme",
    xcodeScheme,
    "-configuration",
    "Release",
    "-archivePath",
    "build/app.xcarchive",
    "archive",
    "CODE_SIGN_STYLE=Manual",
    `DEVELOPMENT_TEAM=${iosTeamId}`,
    "CODE_SIGN_IDENTITY=Apple Distribution",
  ]);


  const exportOptionsPath = "native/engine/os/ExportOptions.plist"
  if (!fs.existsSync(exportOptionsPath)) {
    console.error(`ExportOptions.plist not found, path [${exportOptionsPath}]`)
    return
  }


  /*
   |--------------------------------------------------------------------------
   | export ipa
   |--------------------------------------------------------------------------
   */

  await exec.exec("xcodebuild", [
    "-exportArchive",
    "-archivePath",
    "build/app.xcarchive",
    "-exportPath",
    "build/ipa",
    "-exportOptionsPlist",
    "native/engine/os/ExportOptions.plist",
  ]);

  /*
   |--------------------------------------------------------------------------
   | save xcode cache
   |--------------------------------------------------------------------------
   */

  await saveCacheSafe(
    [derivedData, moduleCache],
    `xcode-${process.platform}`
  );

  /*
   |--------------------------------------------------------------------------
   | outputs
   |--------------------------------------------------------------------------
   */

  core.setOutput("ipa-path", "build/ipa");
}