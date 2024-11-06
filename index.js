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

// ... ваш существующий код (vpkFolders, getManifests, downloadVPKDir, getRequiredVPKFiles, downloadVPKArchives)

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

async function processVPKFilesInBatches(
  user,
  manifests,
  requiredIndices,
  batchSize = 10
) {
  for (let i = 0; i < requiredIndices.length; i += batchSize) {
    const batchIndices = requiredIndices.slice(i, i + batchSize);
    console.log(
      `Обработка пакета ${i / batchSize + 1}: индексы ${batchIndices}`
    );

    // Скачивание текущего пакета VPK-файлов
    await downloadVPKArchives(user, manifests, batchIndices);

    // Запуск Decompiler
    try {
      await runDecompiler();
      console.log(`Decompiler успешно обработал пакет ${i / batchSize + 1}`);
    } catch (err) {
      console.error(`Ошибка при обработке пакета ${i / batchSize + 1}:`, err);
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
    const batchSize = 10;
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
