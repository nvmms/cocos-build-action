import * as core from "@actions/core";
import * as cache from "@actions/cache";
import * as exec from "@actions/exec";
import * as crypto from "crypto";
import * as fs from "fs";
import * as https from "https";
import * as path from "path";

export function getInput(name: string): string {
    // 1. CLI 参数：--name=value
    const cliValue = getFromCLI(name);
    if (cliValue !== undefined) return cliValue;

    // 2. 环境变量：NAME
    const envKey = name.replace(/-/g, "_").toUpperCase();
    if (process.env[envKey]) {
        return process.env[envKey] as string;
    }

    // 3. GitHub Actions
    if (core && typeof core.getInput === "function") {
        return core.getInput(name);
    }

    return "";
}

function getFromCLI(name: string): string | undefined {
    const prefix = `--${name}=`;

    for (const arg of process.argv.slice(2)) {
        if (arg.startsWith(prefix)) {
            return arg.slice(prefix.length);
        }
    }

    return undefined;
}

export async function sh(script: string) {
    await exec.exec("bash", ["-eo", "pipefail", "-c", script]);
}

export function sha256(content: Buffer | string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
}

export function hashFile(file: string): string {
    return sha256(fs.readFileSync(file));
}

export function hashDir(dir: string): string {
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

export async function saveCacheSafe(paths: string[], key: string) {
    try {
        await cache.saveCache(paths, key);
        console.log(`cache saved: ${key}`);
    } catch (err: any) {
        console.log(`cache save skipped: ${err.message}`);
    }
}

export async function downloadFile(url: string, output: string) {
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
