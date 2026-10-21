const api = globalThis.browser ?? globalThis.chrome;
const status = document.querySelector("#status");
const statusTitle = document.querySelector("#status-title");
const lockButton = document.querySelector("#lock");
const hint = document.querySelector("#hint");
const shortcutChip = document.querySelector("#shortcut-chip");

async function currentTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function loadShortcut() {
  const commands = await api.commands.getAll();
  const lockCommand = commands.find((command) => command.name === "lock-current-whatsapp-tab");
  document.querySelector("#shortcut").textContent = lockCommand?.shortcut
    ? `Atalho: ${lockCommand.shortcut.replaceAll("+", " + ")}`
    : "Atalho não definido";
  shortcutChip.hidden = false;
}

async function initialize() {
  const [tab, extensionState] = await Promise.all([
    currentTab(),
    api.runtime.sendMessage({ type: "get-state" })
  ]);
  if (!tab?.url?.startsWith("https://web.whatsapp.com/")) {
    statusTitle.textContent = "Proteção pronta";
    status.textContent = "Abra o WhatsApp Web para ativar a proteção nesta aba.";
    hint.hidden = false;
    return;
  }
  if (!extensionState?.hasPassword) {
    statusTitle.textContent = "Proteção não configurada";
    status.textContent = "Crie uma senha na tela do WhatsApp Web para ativar a proteção.";
    return;
  }
  status.textContent = "O bloqueio está disponível para esta sessão.";
  lockButton.disabled = false;
  lockButton.addEventListener("click", async () => {
    lockButton.disabled = true;
    await api.tabs.sendMessage(tab.id, { type: "force-lock" });
    window.close();
  });
}

document.querySelector("#settings").addEventListener("click", () => api.runtime.openOptionsPage());

Promise.all([initialize(), loadShortcut()]).catch(() => {
  statusTitle.textContent = "Não foi possível verificar";
  status.textContent = "Tente fechar e abrir a extensão novamente.";
});
