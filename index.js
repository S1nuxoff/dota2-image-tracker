const SteamUser = require("steam-user");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawn } = require("child_process");
const { PNG } = require("pngjs");
const vpk = require("vpk");

const appId = 570;
const depotIds = [373301, 381451, 381452, 381453, 381454, 381455];
const dir = "./static";
const temp = "./temp";
const vtexDir = `${temp}/vtex`;
const convertedDir = `${temp}/converted`;
const manifestIdFile = `${dir}/manifestId.txt`;
// CRC of every image in the VPK as of the last successful run
const CRC_FILE = "crcs.json";
const IMAGES_PREFIX = "panorama/images/econ/";
const DECOMPILER = "./vrf/Source2Viewer-CLI";

const DOWNLOAD_WORKERS = 16;
const CHUNK_RETRIES = 5;
const DIR_ARCHIVE = 0x7fff;
// Different converter versions decode the same texture with tiny differences
const PIXEL_TOLERANCE = 3;

const force = process.argv.includes("--force");
const [username, password] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

if (!username || !password) {
  console.error("Usage: node index.js <USERNAME> <PASSWORD> [--force]");
  process.exit(1);
}

const user = new SteamUser();

console.log("Logging into Steam...");

user.logOn({
  accountName: username,
  password: password,
  rememberPassword: true,
  logonID: 2121,
});

user.once("loggedOn", () => {
  run().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    }
  );
});

async function run() {
  const manifests = await getManifests();
  const manifestId = manifests[373301].manifestId;

  if (!force && readText(manifestIdFile) === manifestId) {
    console.log(`Manifest ${manifestId} is already processed, exiting.`);
    return;
  }
  console.log(`New manifest ${manifestId}`);

  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });

  const dirPath = `${temp}/pak01_dir.vpk`;
  console.log("Downloading pak01_dir.vpk");
  await user.downloadFile(appId, 373301, findArchive(manifests, "dir").file, dirPath);

  const vpkDir = new vpk(dirPath);
  vpkDir.load();

  const oldCrcs = force ? {} : loadJSON(CRC_FILE, {});
  const crcs = {};
  const changed = [];

  for (const file of vpkDir.files) {
    if (!file.startsWith(IMAGES_PREFIX) || !file.endsWith(".vtex_c")) {
      continue;
    }
    const entry = vpkDir.tree[file];
    crcs[file] = entry.crc;
    if (oldCrcs[file] !== entry.crc) {
      changed.push(file);
    }
  }

  console.log(`${Object.keys(crcs).length} images in the game, ${changed.length} new or changed.`);

  if (changed.length > 0) {
    await extractImages(vpkDir, dirPath, changed, manifests);
    await runDecompiler();
    const converted = copyChangedImages();

    // Retry the ones the converter failed on next time
    const failed = changed.filter((file) => !converted.has(file.replace(/\.vtex_c$/, "")));
    for (const file of failed) {
      delete crcs[file];
    }
    if (failed.length > 0) {
      console.log(`${failed.length} images could not be converted, e.g. ${failed.slice(0, 5).join(", ")}`);
    }
  }

  fs.writeFileSync(CRC_FILE, JSON.stringify(crcs, null, 1));
  fs.writeFileSync(manifestIdFile, manifestId);
  fs.rmSync(temp, { recursive: true, force: true });
}

async function getManifests() {
  console.log(`Fetching product info for appId ${appId}`);
  const productInfo = await user.getProductInfo([appId], [], true);
  const depots = productInfo.apps[appId].appinfo.depots;
  const manifests = {};

  for (const depotId of depotIds) {
    const gid = depots[depotId]?.manifests?.public?.gid;
    if (!gid) {
      console.error(`Depot ${depotId} not found in app's depots`);
      continue;
    }

    console.log(`Fetching manifest for depot ${depotId}, manifest ID ${gid}`);
    const { manifest } = await user.getManifest(appId, depotId, gid, "public");
    manifests[depotId] = { manifestId: gid, files: manifest.files };
  }

  if (!manifests[373301]) {
    throw new Error("Manifest for depot 373301 could not be retrieved.");
  }
  return manifests;
}

// "dir" or an archive index
function findArchive(manifests, index) {
  const name = index === "dir" ? "pak01_dir.vpk" : `pak01_${String(index).padStart(3, "0")}.vpk`;
  const matches = (filename) => {
    const normalized = filename.replace(/\\/g, "/").toLowerCase();
    return normalized === `dota/${name}` || normalized.endsWith(`/dota/${name}`);
  };

  for (const depotId of depotIds) {
    const file = manifests[depotId]?.files.find((f) => matches(f.filename));
    if (file) {
      return { depotId, file };
    }
  }
  throw new Error(`${name} not found in any depot.`);
}

// Only the chunks that hold the changed images are downloaded, not whole archives
async function extractImages(vpkDir, dirPath, files, manifests) {
  const dirFd = fs.openSync(dirPath, "r");
  const byArchive = new Map();

  for (const file of files) {
    const { archiveIndex } = vpkDir.tree[file];
    if (!byArchive.has(archiveIndex)) {
      byArchive.set(archiveIndex, []);
    }
    byArchive.get(archiveIndex).push(file);
  }

  let done = 0;
  let downloadedBytes = 0;

  for (const [archiveIndex, archiveFiles] of byArchive) {
    if (archiveIndex === DIR_ARCHIVE) {
      for (const file of archiveFiles) {
        writeVtex(file, vpkDir.getFile(file));
      }
      done += archiveFiles.length;
      continue;
    }

    const { depotId, file: archive } = findArchive(manifests, archiveIndex);
    const chunks = archive.chunks
      .map((chunk) => ({ sha: chunk.sha, offset: Number(chunk.offset), size: chunk.cb_original }))
      .sort((a, b) => a.offset - b.offset);

    const needed = new Map();
    for (const file of archiveFiles) {
      for (const chunk of chunksFor(vpkDir.tree[file], chunks)) {
        needed.set(chunk.sha, chunk);
      }
    }

    const data = await downloadChunks(depotId, [...needed.values()]);
    for (const chunk of needed.values()) {
      downloadedBytes += chunk.size;
    }

    for (const file of archiveFiles) {
      const entry = vpkDir.tree[file];
      const buffer = Buffer.alloc(entry.preloadBytes + entry.entryLength);
      if (entry.preloadBytes > 0) {
        fs.readSync(dirFd, buffer, 0, entry.preloadBytes, entry.preloadOffset);
      }

      const start = entry.entryOffset;
      const end = start + entry.entryLength;
      for (const chunk of chunksFor(entry, chunks)) {
        const from = Math.max(start, chunk.offset);
        const to = Math.min(end, chunk.offset + chunk.size);
        data.get(chunk.sha).copy(buffer, entry.preloadBytes + from - start, from - chunk.offset, to - chunk.offset);
      }

      if (zlib.crc32(buffer) !== entry.crc) {
        throw new Error(`CRC does not match for ${file}`);
      }
      writeVtex(file, buffer);
    }

    done += archiveFiles.length;
    console.log(
      `pak01_${String(archiveIndex).padStart(3, "0")}.vpk: ${archiveFiles.length} images ` +
        `[${done}/${files.length}, ${(downloadedBytes / 1e6).toFixed(0)} MB downloaded]`
    );
  }

  fs.closeSync(dirFd);
}

function chunksFor(entry, chunks) {
  const start = entry.entryOffset;
  const end = start + entry.entryLength;
  return chunks.filter((chunk) => chunk.offset < end && chunk.offset + chunk.size > start);
}

async function downloadChunks(depotId, chunks) {
  const data = new Map();
  const queue = [...chunks];

  const worker = async () => {
    while (queue.length > 0) {
      const chunk = queue.shift();
      for (let attempt = 1; ; attempt++) {
        try {
          data.set(chunk.sha, (await user.downloadChunk(appId, depotId, chunk.sha)).chunk);
          break;
        } catch (error) {
          if (attempt >= CHUNK_RETRIES) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
      }
    }
  };

  await Promise.all(Array.from({ length: DOWNLOAD_WORKERS }, worker));
  return data;
}

function writeVtex(file, buffer) {
  const filePath = path.join(vtexDir, file);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
}

function runDecompiler() {
  console.log("Converting textures...");
  const args = ["-i", vtexDir, "--recursive", "-o", convertedDir, "-d", "--threads", "4"];

  return new Promise((resolve, reject) => {
    const decompiler = spawn(DECOMPILER, args, { stdio: ["ignore", "ignore", "inherit"] });
    decompiler.on("error", reject);
    decompiler.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Decompiler exited with code ${code}`))
    );
  });
}

// Images that only differ in how the PNG was encoded are left as they are.
// Returns the converted paths without extension, as they are named in the VPK.
function copyChangedImages() {
  const converted = new Set();
  let added = 0;
  let updated = 0;
  let same = 0;

  for (const file of walk(convertedDir)) {
    const relative = path.relative(convertedDir, file).split(path.sep).join("/");
    const target = path.join(dir, relative);
    converted.add(relative.replace(/\.[^./]+$/, ""));

    if (!fs.existsSync(target)) {
      added++;
    } else if (looksTheSame(file, target)) {
      same++;
      continue;
    } else {
      updated++;
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  }

  console.log(`Images: ${added} added, ${updated} updated, ${same} unchanged.`);
  return converted;
}

function looksTheSame(a, b) {
  const bufferA = fs.readFileSync(a);
  const bufferB = fs.readFileSync(b);
  if (bufferA.equals(bufferB)) {
    return true;
  }
  if (!a.endsWith(".png")) {
    return false;
  }

  let imageA, imageB;
  try {
    imageA = PNG.sync.read(bufferA);
    imageB = PNG.sync.read(bufferB);
  } catch {
    return false;
  }
  if (imageA.width !== imageB.width || imageA.height !== imageB.height) {
    return false;
  }

  for (let i = 0; i < imageA.data.length; i++) {
    if (Math.abs(imageA.data[i] - imageB.data[i]) > PIXEL_TOLERANCE) {
      return false;
    }
  }
  return true;
}

function* walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else {
      yield fullPath;
    }
  }
}

function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
}

function loadJSON(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}
