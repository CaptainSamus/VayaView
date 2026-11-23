// Builds the Fire TV app (android/) into releases/VayaView-TV.apk, without Gradle:
// aapt2 (resources) → javac → d8 (dex) → zipalign → apksigner. The JDK and Android SDK live in tools/
// (gitignored; never AppData). The signing key is made once in android/keystore and must be kept:
// an update signed with a different key will not install over the old one.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tools = path.join(root, "tools");
const jdk = path.join(tools, fs.readdirSync(tools).find((name) => name.startsWith("jdk-")));
const sdk = path.join(tools, "sdk");
const bt = path.join(sdk, "build-tools", "34.0.0");
const androidJar = path.join(sdk, "platforms", "android-34", "android.jar");
const app = path.join(root, "android");
const out = path.join(app, "build");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const [major, minor, patch] = version.split(".").map(Number);

const env = { ...process.env, JAVA_HOME: jdk, PATH: `${path.join(jdk, "bin")};${process.env.PATH}` };
const run = (file, args) => execFileSync(file, args, { stdio: ["ignore", "inherit", "inherit"], env, shell: file.endsWith(".bat") });
const bin = (name) => path.join(jdk, "bin", `${name}.exe`);

fs.rmSync(out, { recursive: true, force: true });
for (const dir of ["res/mipmap", "classes", "dex"]) fs.mkdirSync(path.join(out, dir), { recursive: true });
fs.copyFileSync(path.join(root, "electron", "icon.png"), path.join(out, "res", "mipmap", "icon.png"));

// 1. Resources and manifest.
run(path.join(bt, "aapt2.exe"), ["compile", "--dir", path.join(out, "res"), "-o", path.join(out, "res.zip")]);
run(path.join(bt, "aapt2.exe"), [
  "link", "-I", androidJar, "--manifest", path.join(app, "AndroidManifest.xml"), "-A", path.join(app, "assets"),
  "--min-sdk-version", "22", "--target-sdk-version", "30",
  "--version-code", String(major * 10000 + minor * 100 + patch), "--version-name", version,
  "-o", path.join(out, "base.apk"), path.join(out, "res.zip"),
]);

// 2. Code.
const sources = [];
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".java") && sources.push(path.join(dir, e.name))));
walk(path.join(app, "src"));
run(bin("javac"), ["--release", "8", "-classpath", androidJar, "-d", path.join(out, "classes"), ...sources]);
const classes = [];
const walkClasses = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walkClasses(path.join(dir, e.name)) : classes.push(path.join(dir, e.name))));
walkClasses(path.join(out, "classes"));
run(path.join(bt, "d8.bat"), ["--lib", androidJar, "--min-api", "22", "--output", path.join(out, "dex"), ...classes]);

// 3. Put the code in, align, sign.
run(bin("jar"), ["uf", path.join(out, "base.apk"), "-C", path.join(out, "dex"), "classes.dex"]);
run(path.join(bt, "zipalign.exe"), ["-f", "-p", "4", path.join(out, "base.apk"), path.join(out, "aligned.apk")]);

const keyDir = path.join(app, "keystore");
const keystore = path.join(keyDir, "vayaview-tv.jks");
const passFile = path.join(keyDir, "password.txt");
if (!fs.existsSync(keystore)) {
  fs.mkdirSync(keyDir, { recursive: true });
  fs.writeFileSync(passFile, crypto.randomBytes(18).toString("hex"));
  const pass = fs.readFileSync(passFile, "utf8");
  run(bin("keytool"), ["-genkeypair", "-keystore", keystore, "-alias", "vayaview", "-keyalg", "RSA", "-keysize", "2048", "-validity", "36500", "-storepass", pass, "-keypass", pass, "-dname", "CN=VayaView"]);
}
const pass = fs.readFileSync(passFile, "utf8");
const target = path.join(root, "releases", "VayaView-TV.apk");
fs.mkdirSync(path.dirname(target), { recursive: true });
run(path.join(bt, "apksigner.bat"), ["sign", "--ks", keystore, "--ks-pass", `pass:${pass}`, "--out", target, path.join(out, "aligned.apk")]);
console.log(`Fire TV app: ${target}`);
