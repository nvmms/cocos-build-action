import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as cache from "@actions/cache";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as https from "https";
import AdmZip from "adm-zip";

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
    const cocosUrl = core.getInput("cocos-url");

    let platform = core.getInput("platform");
    platform = platform.toLowerCase();

    const iosCertP12 = core.getInput("ios-cert-p12");
    const iosCertPassword = core.getInput("ios-cert-password");
    const iosProfile = core.getInput("ios-profile");
    const iosProfileUuid = core.getInput("ios-profile-uuid");
    const iosTeamId = core.getInput("ios-team-id");

    const xcodeProject = core.getInput("xcode-project");
    const xcodeScheme = core.getInput("xcode-scheme");

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

async function sh(script: string) {
  await exec.exec("bash", ["-eo", "pipefail", "-c", script]);
}

function sha256(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function hashFile(file: string): string {
  return sha256(fs.readFileSync(file));
}

function hashDir(dir: string): string {
  const hash = crypto.createHash("sha256");

  function walk(current: string) {
    const files = fs.readdirSync(current).sort();

    for (const file of files) {
      const full = path.join(current, file);
      const stat = fs.statSync(full);

      if (stat.isDirectory()) {
        walk(full);
      } else {
        hash.update(full);
        hash.update(fs.readFileSync(full));
      }
    }
  }

  walk(dir);

  return hash.digest("hex");
}

async function saveCacheSafe(paths: string[], key: string) {
  try {
    await cache.saveCache(paths, key);
    console.log(`cache saved: ${key}`);
  } catch (err: any) {
    console.log(`cache save skipped: ${err.message}`);
  }
}

async function downloadFile(url: string, output: string) {
  return new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(output);

    https
      .get(url, (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          file.close();

          fs.rmSync(output, {
            force: true,
          });

          downloadFile(response.headers.location, output)
            .then(resolve)
            .catch(reject);

          return;
        }

        if (response.statusCode !== 200) {
          reject(
            new Error(`download failed: ${response.statusCode}`)
          );

          return;
        }

        response.pipe(file);

        file.on("finish", () => {
          file.close();
          resolve();
        });
      })
      .on("error", (err) => {
        file.close();

        fs.rmSync(output, {
          force: true,
        });

        reject(err);
      });
  });
}

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

  await saveCacheSafe(
    ["cocos-editor"],
    cocosKey
  );
}

function findCocosCreatorBinary(): string {
  const candidates: string[] = [];

  function walk(dir: string) {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      const full = path.join(dir, file);
      const stat = fs.statSync(full);

      if (stat.isDirectory()) {
        walk(full);
      } else {
        if (
          full.endsWith("/Contents/MacOS/CocosCreator") ||
          full.endsWith("\\Contents\\MacOS\\CocosCreator")
        ) {
          candidates.push(full);
        }
      }
    }
  }

  walk("cocos-editor");

  if (candidates.length === 0) {
    throw new Error("cannot find CocosCreator binary");
  }

  return candidates[0];
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