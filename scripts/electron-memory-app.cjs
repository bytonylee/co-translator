const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");

const apiKeyPageUrl = "https://platform.openai.com/settings/organization/api-keys";

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    title: "Co Translator",
    backgroundColor: "#060606",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url === apiKeyPageUrl) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  await window.loadFile(path.join(__dirname, "../dist/renderer/index.html"));
});

app.on("window-all-closed", () => {
  app.quit();
});
