/**
 * This code is from csfloat repo. I made small changes to get the images.
 * https://github.com/csfloat/cs-files/blob/5ff0f212ff0dc2b6f6380fc6d1a93121c2b9c2cd/index.js
 */
const SteamUser = require("steam-user");
const fs = require("fs");
const vpk = require("vpk");

const appId = 570;
const depotIds = [381451, 381452, 381453, 381454, 381455, 373301];
const dir = `./static`;
const temp = "./temp";
const manifestIdFile = "manifestId.txt";

const vpkFiles = [
  "panorama/images/econ/challenges",
  "panorama/images/econ/announcer",
  "panorama/images/econ/artifacts",
  "panorama/images/econ/bundles",
  "panorama/images/econ/casters",
  "panorama/images/econ/courier",
  "panorama/images/econ/crafting",
  "panorama/images/econ/creeps",
  "panorama/images/econ/cursor_pack",
  "panorama/images/econ/custom_games_pass",
  "panorama/images/econ/development",
  "panorama/images/econ/heroes",
  "panorama/images/econ/huds",
  "panorama/images/econ/items",
  "panorama/images/econ/leagues",
  "panorama/images/econ/loading_screens",
  "panorama/images/econ/music",
  "panorama/images/econ/pennant",
  "panorama/images/econ/pets",
  "panorama/images/econ/pins",
  "panorama/images/econ/props_gameplay",
  "panorama/images/econ/sets",
  "panorama/images/econ/sockets",
  "panorama/images/econ/taunts",
  "panorama/images/econ/terrain",
  "panorama/images/econ/tools",
  "panorama/images/econ/ui/treasure",
  "panorama/images/econ/voicepack",
  "panorama/images/econ/stickers",
  "panorama/images/econ/talentcontent",
  "panorama/images/econ/teamfancontent",
];

async function getManifests(user) {
  console.log(`Fetching product info for appId ${appId}`);
  const productInfo = await user.getProductInfo([appId], [], true);
  const cs = productInfo.apps[appId].appinfo;

  let manifests = {};

  for (const depotId of depotIds) {
    const depot = cs.depots[depotId];
    if (!depot) {
      console.error(`Depot ${depotId} not found in app's depots`);
      continue;
    }
    const latestManifestId = depot.manifests.public.gid;

    console.log(
      `Fetching manifest for depot ${depotId}, manifest ID ${latestManifestId}`
    );

    const manifest = await user.getManifest(
      appId,
      depotId,
      latestManifestId,
      "public"
    );

    manifests[depotId] = {
      manifestId: latestManifestId,
      files: manifest.manifest.files,
    };
  }

  return manifests;
}

async function downloadVPKDir(user, manifest) {
  const dirFile = manifest.files.find((file) =>
    file.filename.endsWith("dota\\pak01_dir.vpk")
  );

  console.log(`Downloading pak01_dir.vpk from depot 373301`);

  await user.downloadFile(appId, 373301, dirFile, `${temp}/pak01_dir.vpk`);

  const vpkDir = new vpk(`${temp}/pak01_dir.vpk`);
  vpkDir.load();

  return vpkDir;
}

function getRequiredVPKFiles(vpkDir) {
  const requiredIndices = new Set();

  for (const fileName of vpkDir.files) {
    for (const f of vpkFiles) {
      if (fileName.startsWith(f)) {
        console.log(`Found VPK entry for ${f}: ${fileName}`);

        const archiveIndex = vpkDir.tree[fileName].archiveIndex;
        requiredIndices.add(archiveIndex);
        break;
      }
    }
  }

  return Array.from(requiredIndices).sort((a, b) => a - b);
}

async function downloadVPKArchives(user, manifests, requiredIndices) {
  console.log(`Required VPK files: ${requiredIndices}`);

  let fileIndex = 1;
  const totalFiles = requiredIndices.length;

  for (const index of requiredIndices) {
    const paddedIndex = index.toString().padStart(3, "0");
    const fileName = `pak01_${paddedIndex}.vpk`;

    let fileFound = false;

    for (const depotId of depotIds) {
      const manifest = manifests[depotId];

      if (!manifest) {
        continue;
      }

      const file = manifest.files.find((f) => f.filename.endsWith(fileName));

      if (file) {
        const filePath = `${temp}/${fileName}`;
        const status = `[${fileIndex}/${totalFiles}]`;

        console.log(`${status} Downloading ${fileName} from depot ${depotId}`);

        await user.downloadFile(appId, depotId, file, filePath);
        fileFound = true;
        break;
      }
    }

    if (!fileFound) {
      console.error(`File ${fileName} not found in any depot.`);
    }

    fileIndex++;
  }
}

if (process.argv.length != 4) {
  console.error(
    `Missing input arguments, expected 4 got ${process.argv.length}`
  );
  process.exit(1);
}

if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir);
}

if (!fs.existsSync(temp)) {
  fs.mkdirSync(temp);
}

const user = new SteamUser();

console.log("Logging into Steam....");

user.logOn({
  accountName: process.argv[2],
  password: process.argv[3],
  rememberPassword: true,
  logonID: 2121,
});

user.once("loggedOn", async () => {
  const manifests = await getManifests(user);

  if (!manifests[373301]) {
    console.error(`Manifest for depot 373301 could not be retrieved.`);
    process.exit(1);
  }

  const latestManifestId = manifests[373301].manifestId;

  console.log(`Obtained latest manifest ID: ${latestManifestId}`);

  let existingManifestId = "";

  try {
    existingManifestId = fs.readFileSync(`${dir}/${manifestIdFile}`, "utf8");
  } catch (err) {
    if (err.code != "ENOENT") {
      throw err;
    }
  }

  if (existingManifestId == latestManifestId) {
    console.log("Latest manifest ID matches existing manifest ID, exiting");
    process.exit(0);
  }

  console.log(
    "Latest manifest ID does not match existing manifest ID, downloading game files"
  );

  const vpkDir = await downloadVPKDir(user, manifests[373301]);

  const requiredIndices = getRequiredVPKFiles(vpkDir);

  await downloadVPKArchives(user, manifests, requiredIndices);

  try {
    fs.writeFileSync(`${dir}/${manifestIdFile}`, latestManifestId);
  } catch (error) {
    throw err;
  }

  process.exit(0);
});
