// Publishes releases\VayaView-win32-x64.zip (and releases\VayaView-TV.apk, if built) as a GitHub release for the version in package.json.
// Uses the GitHub sign-in git already has saved on this PC (git credential fill). The token is held
// in memory for these requests only: never printed, never written to a file.
// Run with: node scripts/publish-release.mjs "What changed in this version"
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = "CaptainSamus/VayaView";
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const tag = `v${version}`;
const zip = path.resolve("releases", "VayaView-win32-x64.zip");
const notes = process.argv[2] ?? `VayaView ${version}`;
if (!fs.existsSync(zip)) throw new Error("Build the zip first: npm run release");

const credential = execFileSync("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
const token = /^password=(.+)$/m.exec(credential)?.[1]?.trim();
if (!token) throw new Error("git has no saved GitHub sign-in on this PC.");
const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "VayaView-release" };

async function api(method, url, body) {
  const response = await fetch(url, { method, headers: { ...headers, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url.replace(/\?.*/, "")} → ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// Reuse the release if this version was already started, otherwise create it.
let release;
try {
  release = await api("GET", `https://api.github.com/repos/${REPO}/releases/tags/${tag}`);
} catch {
  release = await api("POST", `https://api.github.com/repos/${REPO}/releases`, { tag_name: tag, target_commitish: "main", name: `VayaView ${version}`, body: notes, draft: false, prerelease: false });
}
// The Windows zip, plus the Fire TV app when it has been built (node scripts/build-tv-apk.mjs).
// A file already uploaded with the same size is left alone, so a running update is never cut off.
const files = [zip, path.resolve("releases", "VayaView-TV.apk")].filter((file) => fs.existsSync(file));
console.log(`Release ${tag}: ${release.html_url}`);
for (const file of files) {
  const name = path.basename(file);
  const data = fs.readFileSync(file);
  const old = (release.assets ?? []).find((asset) => asset.name === name);
  if (old && old.size === data.length) {
    console.log(`Already there: ${name}`);
    continue;
  }
  if (old) await api("DELETE", old.url);
  const type = name.endsWith(".apk") ? "application/vnd.android.package-archive" : "application/zip";
  const upload = release.upload_url.replace(/{.*}$/, "") + `?name=${encodeURIComponent(name)}`;
  const response = await fetch(upload, { method: "POST", headers: { ...headers, "Content-Type": type, "Content-Length": String(data.length) }, body: data });
  if (!response.ok) throw new Error(`Upload of ${name} failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  const asset = await response.json();
  console.log(`Uploaded: ${asset.name} (${(asset.size / 1e6).toFixed(1)} MB) ${asset.browser_download_url}`);
}
