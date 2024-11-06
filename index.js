const SteamUser = require("steam-user");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const vpk = require("vpk");

const appId = 570;
const depotIds = [381451, 381452, 381453, 381454, 381455, 373301];
const dir = `./static`;
const temp = "./temp";
const manifestIdFile = "manifestId.txt";

const vpkFolders = [
  "panorama/images/econ/items",
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

// Функция для получения манифестов
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

// Функция для скачивания pak01_dir.vpk
async function downloadVPKDir(user, manifest) {
  const dirFile = manifest.files.find((file) =>
    file.filename.endsWith("dota\\pak01_dir.vpk")
  );

  if (!dirFile) {
    throw new Error("pak01_dir.vpk not found in manifest files.");
  }

  console.log(`Downloading pak01_dir.vpk from depot 373301`);

  await user.downloadFile(
    appId,
    373301,
    dirFile,
    path.join(temp, "pak01_dir.vpk")
  );

  const vpkDir = new vpk(path.join(temp, "pak01_dir.vpk"));
  vpkDir.load();

  return vpkDir;
}

// Функция для получения необходимых индексов VPK-файлов
function getRequiredVPKFiles(vpkDir) {
  const requiredIndices = [];

  for (const fileName of vpkDir.files) {
    for (const f of vpkFolders) {
      if (fileName.startsWith(f)) {
        // console.log(`Found vpk for ${f}: ${fileName}`);

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

// Функция для скачивания VPK-архивов по индексам
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
        const filePath = path.join(temp, fileName);
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

// Функция для запуска Decompiler
async function runDecompiler() {
  return new Promise((resolve, reject) => {
    console.log("Запуск Decompiler...");

    const decompilerPath = path.join(__dirname, "Decompiler");
    const inputPath = path.join(temp, "pak01_dir.vpk");
    const outputPath = path.join(dir);
    const econPath = "panorama/images/econ";

    const command = `${decompilerPath} -i "${inputPath}" -o "${outputPath}" -e "vtex_c" -d -f "${econPath}"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Ошибка при запуске Decompiler: ${error.message}`);
        return reject(error);
      }
      if (stderr) {
        console.error(`Decompiler stderr: ${stderr}`);
      }
      console.log(`Decompiler stdout: ${stdout}`);
      resolve();
    });
  });
}

// Функция для обработки VPK-файлов пакетами
async function processVPKFilesInBatches(
  user,
  manifests,
  requiredIndices,
  batchSize = 2
) {
  for (let i = 0; i < requiredIndices.length; i += batchSize) {
    const batchIndices = requiredIndices.slice(i, i + batchSize);
    console.log(
      `Обработка пакета ${
        Math.floor(i / batchSize) + 1
      }: индексы ${batchIndices}`
    );

    // Скачивание текущего пакета VPK-файлов
    await downloadVPKArchives(user, manifests, batchIndices);

    // Запуск Decompiler
    try {
      await runDecompiler();
      console.log(
        `Decompiler успешно обработал пакет ${Math.floor(i / batchSize) + 1}`
      );
    } catch (err) {
      console.error(
        `Ошибка при обработке пакета ${Math.floor(i / batchSize) + 1}:`,
        err
      );
      process.exit(1);
    }

    // Удаление обработанных VPK-файлов
    for (const index of batchIndices) {
      const paddedIndex = index.toString().padStart(3, "0");
      const fileName = `pak01_${paddedIndex}.vpk`;
      const filePath = path.join(temp, fileName);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Удалён файл: ${fileName}`);
      }
    }
  }
}

// Проверка аргументов командной строки
if (process.argv.length !== 4) {
  console.error(
    `Неверное количество аргументов, ожидается 4, получено ${process.argv.length}`
  );
  process.exit(1);
}

// Создание необходимых директорий, если они не существуют
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

if (!fs.existsSync(temp)) {
  fs.mkdirSync(temp, { recursive: true });
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
  try {
    const manifests = await getManifests(user);

    if (!manifests[373301]) {
      console.error(`Manifest для депо 373301 не удалось получить.`);
      process.exit(1);
    }

    const latestManifestId = manifests[373301].manifestId;

    console.log(
      `Получен последний manifest ID для депо 373301: ${latestManifestId}`
    );

    let existingManifestId = "";

    try {
      existingManifestId = fs.readFileSync(
        path.join(dir, manifestIdFile),
        "utf8"
      );
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }

    if (existingManifestId.trim() === latestManifestId) {
      console.log("Последний manifest ID совпадает с существующим. Выход.");
      process.exit(0);
    }

    console.log(
      "Последний manifest ID не совпадает с существующим. Начинается загрузка игровых файлов."
    );

    const vpkDir = await downloadVPKDir(user, manifests[373301]);

    const requiredIndices = getRequiredVPKFiles(vpkDir);

    // Разделение на пакеты по 10
    const batchSize = 2;
    const totalBatches = Math.ceil(requiredIndices.length / batchSize);
    console.log(`Всего пакетов для обработки: ${totalBatches}`);

    // Обработка VPK-файлов пакетами
    await processVPKFilesInBatches(user, manifests, requiredIndices, batchSize);

    // Сохранение нового manifest ID
    fs.writeFileSync(path.join(dir, manifestIdFile), latestManifestId, "utf8");
    console.log("Обновлён manifestId.txt");

    process.exit(0);
  } catch (error) {
    console.error("Произошла ошибка:", error);
    process.exit(1);
  }
});
