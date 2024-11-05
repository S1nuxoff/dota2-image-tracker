/**
 * Модифицированный скрипт для поэтапной загрузки VPK-файлов и декомпиляции.
 */

const SteamUser = require("steam-user");
const fs = require("fs");
const vpk = require("vpk");
const path = require("path");

const appId = 570; // Или другой appId, если требуется
const depotIds = [381451, 381452, 381453, 381454, 381455, 373301];
const dir = `./static`;
const temp = "./temp";
const manifestIdFile = "manifestId.txt";
const downloadedVpkFile = `${dir}/downloadedVpk.txt`;

const vpkFolders = ["panorama/images/econ/items"];

async function getManifests(user) {
  console.log(`Получение информации о продукте для appId ${appId}`);
  const productInfo = await user.getProductInfo([appId], [], true);
  const cs = productInfo.apps[appId].appinfo;

  let manifests = {};

  for (const depotId of depotIds) {
    const depot = cs.depots[depotId];
    if (!depot) {
      console.error(`Депо ${depotId} не найдено в списке депо приложения`);
      continue;
    }
    const latestManifestId = depot.manifests.public.gid;

    console.log(
      `Получение манифеста для депо ${depotId}, ID манифеста ${latestManifestId}`
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

  if (!dirFile) {
    console.error("Файл pak01_dir.vpk не найден в манифесте");
    process.exit(1);
  }

  console.log(`Загрузка pak01_dir.vpk из депо 373301`);

  await user.downloadFile(appId, 373301, dirFile, `${temp}/pak01_dir.vpk`);

  const vpkDir = new vpk(`${temp}/pak01_dir.vpk`);
  vpkDir.load();

  return vpkDir;
}

function getRequiredVPKFiles(vpkDir) {
  const requiredIndices = [];

  for (const fileName of vpkDir.files) {
    for (const f of vpkFolders) {
      if (fileName.startsWith(f)) {
        const archiveIndex = vpkDir.tree[fileName].archiveIndex;

        if (!requiredIndices.includes(archiveIndex)) {
          requiredIndices.push(archiveIndex);
        }

        break;
      }
    }
  }

  return requiredIndices.sort((a, b) => a - b);
}

function getRemainingVPKIndices(requiredIndices) {
  let downloadedVPKs = [];
  if (fs.existsSync(downloadedVpkFile)) {
    const data = fs.readFileSync(downloadedVpkFile, "utf8");
    if (data.trim() !== "") {
      downloadedVPKs = data.split(",").map(Number);
    }
  }

  const remainingIndices = requiredIndices.filter(
    (index) => !downloadedVPKs.includes(index)
  );

  return remainingIndices;
}

async function downloadVPKArchives(user, manifests, requiredIndices) {
  const remainingIndices = getRemainingVPKIndices(requiredIndices);

  if (remainingIndices.length === 0) {
    console.log("Все VPK-файлы уже загружены.");
    return true; // Все файлы загружены
  }

  const indicesToDownload = remainingIndices.slice(0, 10); // Загружаем по 10 файлов за раз
  console.log(`Загружаем VPK-файлы: ${indicesToDownload.join(",")}`);

  let fileIndex = 1;
  const totalFiles = indicesToDownload.length;

  for (const index of indicesToDownload) {
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

        console.log(`${status} Загрузка ${fileName} из депо ${depotId}`);

        await user.downloadFile(appId, depotId, file, filePath);
        fileFound = true;
        break;
      }
    }

    if (!fileFound) {
      console.error(`Файл ${fileName} не найден ни в одном депо.`);
    }

    fileIndex++;
  }

  // Обновляем downloadedVpk.txt
  let downloadedVPKs = [];
  if (fs.existsSync(downloadedVpkFile)) {
    const data = fs.readFileSync(downloadedVpkFile, "utf8");
    if (data.trim() !== "") {
      downloadedVPKs = data.split(",").map(Number);
    }
  }

  downloadedVPKs = downloadedVPKs.concat(indicesToDownload);
  fs.writeFileSync(downloadedVpkFile, downloadedVPKs.join(","));

  return false; // Есть еще файлы для загрузки
}

if (process.argv.length != 4) {
  console.error(
    `Недостаточно аргументов, ожидается 4, получено ${process.argv.length}`
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

console.log("Вход в Steam...");

user.logOn({
  accountName: process.argv[2],
  password: process.argv[3],
  rememberPassword: true,
  logonID: 2121,
});

user.once("loggedOn", async () => {
  const manifests = await getManifests(user);

  if (!manifests[373301]) {
    console.error(`Манифест для депо 373301 не получен.`);
    process.exit(1);
  }

  const latestManifestId = manifests[373301].manifestId;

  console.log(
    `Получен последний ID манифеста для депо 373301: ${latestManifestId}`
  );

  let existingManifestId = "";

  try {
    existingManifestId = fs.readFileSync(`${dir}/${manifestIdFile}`, "utf8");
  } catch (err) {
    if (err.code != "ENOENT") {
      throw err;
    }
  }

  if (
    existingManifestId == latestManifestId &&
    !fs.existsSync(downloadedVpkFile)
  ) {
    console.log("Последний ID манифеста совпадает с существующим, выход.");
    process.exit(0);
  }

  console.log("Загружаем основные файлы игры...");

  const vpkDir = await downloadVPKDir(user, manifests[373301]);

  const requiredIndices = getRequiredVPKFiles(vpkDir);

  const allFilesDownloaded = await downloadVPKArchives(
    user,
    manifests,
    requiredIndices
  );

  if (allFilesDownloaded) {
    console.log("Все необходимые VPK-файлы загружены.");

    // Обновляем manifestId.txt
    fs.writeFileSync(`${dir}/${manifestIdFile}`, latestManifestId);

    // Удаляем downloadedVpk.txt
    if (fs.existsSync(downloadedVpkFile)) {
      fs.unlinkSync(downloadedVpkFile);
    }
  } else {
    console.log(
      "Не все VPK-файлы загружены, потребуется дополнительный запуск."
    );
  }

  process.exit(0);
});
