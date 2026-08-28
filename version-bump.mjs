import fs from "fs";
const targetVersion = process.env.npm_package_version;
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(fs.readFileSync("versions.json", "utf8"));
manifest.version = targetVersion;
versions[targetVersion] = manifest.minAppVersion;
fs.writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
fs.writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
