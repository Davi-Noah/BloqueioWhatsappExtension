const api = globalThis.browser ?? globalThis.chrome;

const PASSWORD_KEY = "passwordRecord";
const SETTINGS_KEY = "settings";
const DEFAULT_SETTINGS = Object.freeze({
  inactivityMinutes: 10,
  lockOnWindowBlur: false,
  passwordProtectionEnabled: false,
  sidebarCollapseMode: "avatars"
});

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function derivePassword(password, salt, iterations) {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations
    },
    baseKey,
    256
  );
  return new Uint8Array(bits);
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function getPasswordRecord() {
  const stored = await api.storage.local.get(PASSWORD_KEY);
  return stored[PASSWORD_KEY] ?? null;
}

async function createPasswordRecord(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 310000;
  const hash = await derivePassword(password, salt, iterations);
  return {
    algorithm: "PBKDF2-SHA-256",
    iterations,
    salt: bytesToBase64(salt),
    hash: bytesToBase64(hash),
    createdAt: new Date().toISOString()
  };
}

async function passwordMatches(password, record) {
  const salt = base64ToBytes(record.salt);
  const expectedHash = base64ToBytes(record.hash);
  const computedHash = await derivePassword(password, salt, record.iterations);
  return equalBytes(computedHash, expectedHash);
}

async function getSettings(hasPassword) {
  const stored = await api.storage.local.get(SETTINGS_KEY);
  const saved = stored[SETTINGS_KEY] ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    // Mantém a proteção ligada para quem já usava a extensão antes desta opção.
    passwordProtectionEnabled: typeof saved.passwordProtectionEnabled === "boolean"
      ? saved.passwordProtectionEnabled
      : Boolean(hasPassword)
  };
}

function sanitizeSettings(value) {
  const minutes = Number(value.inactivityMinutes);
  return {
    inactivityMinutes: Number.isFinite(minutes)
      ? (minutes === 0 ? 0 : Math.max(1, Math.min(120, Math.round(minutes))))
      : DEFAULT_SETTINGS.inactivityMinutes,
    lockOnWindowBlur: Boolean(value.lockOnWindowBlur),
    passwordProtectionEnabled: Boolean(value.passwordProtectionEnabled),
    sidebarCollapseMode: value.sidebarCollapseMode === "hidden" ? "hidden" : "avatars"
  };
}

async function stateFor() {
  const record = await getPasswordRecord();
  return {
    hasPassword: Boolean(record),
    settings: await getSettings(Boolean(record))
  };
}

async function handleMessage(message) {
  switch (message?.type) {
    case "get-state":
      return stateFor();

    case "setup-password": {
      if (typeof message.password !== "string" || message.password.length < 6) {
        return { ok: false, error: "A senha deve ter pelo menos 6 caracteres." };
      }
      if (await getPasswordRecord()) {
        return { ok: false, error: "Uma senha já foi configurada." };
      }
      await api.storage.local.set({ [PASSWORD_KEY]: await createPasswordRecord(message.password) });
      return { ok: true };
    }

    case "verify-password": {
      const record = await getPasswordRecord();
      if (!record) return { ok: false, error: "Configure uma senha primeiro." };
      if (typeof message.password !== "string") {
        return { ok: false, error: "Solicitação inválida." };
      }
      const valid = await passwordMatches(message.password, record);
      return valid ? { ok: true } : { ok: false, error: "Senha incorreta." };
    }

    case "lock-tab":
      return { ok: true };

    case "save-settings": {
      const settings = sanitizeSettings(message.settings ?? {});
      await api.storage.local.set({ [SETTINGS_KEY]: settings });
      return { ok: true, settings };
    }

    case "change-password": {
      const record = await getPasswordRecord();
      if (!record || !(await passwordMatches(message.currentPassword ?? "", record))) {
        return { ok: false, error: "A senha atual está incorreta." };
      }
      if (typeof message.newPassword !== "string" || message.newPassword.length < 6) {
        return { ok: false, error: "A nova senha deve ter pelo menos 6 caracteres." };
      }
      await api.storage.local.set({ [PASSWORD_KEY]: await createPasswordRecord(message.newPassword) });
      return { ok: true };
    }

    default:
      return { ok: false, error: "Ação desconhecida." };
  }
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, error: "Não foi possível concluir a ação." }));
  return true;
});

api.commands?.onCommand.addListener(async (command) => {
  if (command !== "lock-current-whatsapp-tab" && command !== "toggle-conversation-sidebar") return;
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    const type = command === "lock-current-whatsapp-tab"
      ? "force-lock"
      : "toggle-conversation-sidebar";
    await api.tabs.sendMessage(tab.id, { type });
  } catch {
    // A aba atual não é o WhatsApp Web ou ainda não terminou de carregar.
  }
});
