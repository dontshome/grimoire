const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");

const installer = require("../src/installer");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("moveDir falls back to copy and remove on EXDEV", () => {
  const root = tempDir("grimoire-move-test-");
  const source = path.join(root, "source");
  const destination = path.join(root, "nested", "destination");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "file.txt"), "addon data");

  const realRename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error("cross device"), { code: "EXDEV" }); };
  try {
    installer.moveDir(source, destination);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(path.join(destination, "file.txt"), "utf8"), "addon data");
  } finally {
    fs.renameSync = realRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("uninstall rejects folder traversal without touching outside files", () => {
  const root = tempDir("grimoire-path-test-");
  const addonsDir = path.join(root, "AddOns");
  const userDataDir = path.join(root, "user-data");
  const outside = path.join(root, "outside");
  fs.mkdirSync(addonsDir);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "safe");

  try {
    assert.throws(
      () => installer.uninstall({ key: "bad", folders: ["../outside"] }, addonsDir, userDataDir),
      /Unsafe addon folder name/
    );
    assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "safe");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("install updates and backs up an addon when every rename reports EXDEV", async () => {
  const root = tempDir("grimoire-install-test-");
  const addonsDir = path.join(root, "AddOns");
  const userDataDir = path.join(root, "user-data");
  const installedDir = path.join(addonsDir, "ExampleAddon");
  fs.mkdirSync(installedDir, { recursive: true });
  fs.writeFileSync(path.join(installedDir, "old.txt"), "old");

  const zip = new AdmZip();
  zip.addFile("ExampleAddon/ExampleAddon.toc", Buffer.from("## Title: Example\n## Version: 2.0\n"));
  zip.addFile("ExampleAddon/new.txt", Buffer.from("new"));

  const realRename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error("cross device"), { code: "EXDEV" }); };
  try {
    const archive = zip.toBuffer();
    const result = await installer.install(
      {
        key: "ExampleAddon",
        downloadUrl: "https://example.invalid/addon.zip",
        folders: ["ExampleAddon"],
        provider: "curseforge",
        id: "123",
        version: "2.0",
      },
      addonsDir,
      userDataDir,
      { downloadFile: async (_url, destination) => fs.writeFileSync(destination, archive) }
    );

    assert.deepEqual(result.installedFolders, ["ExampleAddon"]);
    assert.equal(fs.readFileSync(path.join(installedDir, "new.txt"), "utf8"), "new");
    assert.equal(fs.readFileSync(path.join(result.backupDir, "ExampleAddon", "old.txt"), "utf8"), "old");
    const marker = JSON.parse(fs.readFileSync(path.join(installedDir, ".grimoire"), "utf8"));
    assert.deepEqual({ provider: marker.provider, id: marker.id, version: marker.version }, {
      provider: "curseforge",
      id: "123",
      version: "2.0",
    });
  } finally {
    fs.renameSync = realRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("install restores the old addon when a later folder move fails", async () => {
  const root = tempDir("grimoire-rollback-test-");
  const addonsDir = path.join(root, "AddOns");
  const userDataDir = path.join(root, "user-data");
  const oldDir = path.join(addonsDir, "AddonOne");
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, "version.txt"), "old");

  const zip = new AdmZip();
  zip.addFile("AddonOne/version.txt", Buffer.from("new"));
  zip.addFile("AddonTwo/version.txt", Buffer.from("new"));
  const archive = zip.toBuffer();

  const realRename = fs.renameSync;
  let renames = 0;
  fs.renameSync = (from, to) => {
    renames++;
    if (renames === 3) throw Object.assign(new Error("simulated disk error"), { code: "EIO" });
    return realRename(from, to);
  };
  try {
    await assert.rejects(
      installer.install(
        {
          key: "two-folder-addon",
          downloadUrl: "https://example.invalid/addon.zip",
          folders: ["AddonOne"],
        },
        addonsDir,
        userDataDir,
        { downloadFile: async (_url, destination) => fs.writeFileSync(destination, archive) }
      ),
      /simulated disk error/
    );
    assert.equal(fs.readFileSync(path.join(oldDir, "version.txt"), "utf8"), "old");
    assert.equal(fs.existsSync(path.join(addonsDir, "AddonTwo")), false);
  } finally {
    fs.renameSync = realRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
