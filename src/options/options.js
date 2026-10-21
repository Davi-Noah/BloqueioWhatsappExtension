const api = globalThis.browser ?? globalThis.chrome;
const settingsForm = document.querySelector("#settings-form");
const passwordForm = document.querySelector("#password-form");
const settingsMessage = document.querySelector("#settings-message");
const passwordMessage = document.querySelector("#password-message");
const shortcutMessage = document.querySelector("#shortcut-message");

function showMessage(element, message, error = false) {
  element.textContent = message;
  element.classList.toggle("error", error);
}

async function load() {
  const response = await api.runtime.sendMessage({ type: "get-state" });
  const settings = response.settings;
  document.querySelector("#minutes").value = settings.inactivityMinutes;
  document.querySelector("#blur").checked = settings.lockOnWindowBlur;
  if (!response.hasPassword) {
    passwordForm.querySelector("button").disabled = true;
    showMessage(passwordMessage, "Crie a primeira senha ao abrir o WhatsApp Web.");
  }
  const commands = await api.commands.getAll();
  const lockCommand = commands.find((command) => command.name === "lock-current-whatsapp-tab");
  document.querySelector("#shortcut-current").textContent = lockCommand?.shortcut || "Não definido";
}

document.querySelector("#shortcut-settings").addEventListener("click", async () => {
  if (typeof api.commands.openShortcutSettings === "function") {
    await api.commands.openShortcutSettings();
    showMessage(shortcutMessage, "A tela de atalhos do navegador foi aberta.");
    return;
  }
  try {
    await api.tabs.create({ url: "chrome://extensions/shortcuts" });
    showMessage(shortcutMessage, "A tela de atalhos do Chrome foi aberta.");
  } catch {
    showMessage(shortcutMessage, "Não foi possível abrir a tela de atalhos.", true);
  }
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const response = await api.runtime.sendMessage({ type: "save-settings", settings: {
    inactivityMinutes: document.querySelector("#minutes").value,
    lockOnWindowBlur: document.querySelector("#blur").checked
  }});
  showMessage(settingsMessage, response.ok ? "Configurações salvas." : response.error, !response.ok);
});

passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const currentPassword = document.querySelector("#current-password").value;
  const newPassword = document.querySelector("#new-password").value;
  const confirmation = document.querySelector("#confirm-password").value;
  if (newPassword !== confirmation) return showMessage(passwordMessage, "As novas senhas não conferem.", true);
  const response = await api.runtime.sendMessage({ type: "change-password", currentPassword, newPassword });
  if (response.ok) {
    passwordForm.reset();
    showMessage(passwordMessage, "Senha alterada. As abas serão bloqueadas em instantes.");
  } else showMessage(passwordMessage, response.error ?? "Não foi possível trocar a senha.", true);
});

load().catch(() => showMessage(settingsMessage, "Não foi possível carregar as configurações.", true));
