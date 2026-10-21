(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  let host;
  let shadow;
  let locked = true;
  let settings = {
    inactivityMinutes: 10,
    lockOnWindowBlur: false,
    passwordProtectionEnabled: false
  };
  let lastActivity = Date.now();
  let checking = false;
  let bodyLockState;
  let screenMode;

  const styles = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .screen { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at 50% 47%, #13201e 0, #0b0f10 58%); color: #e0e3e5; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .card { width: min(100%, 450px); padding: 30px; border: 1px solid #3c4a42; border-radius: 20px; background: rgba(25, 28, 30, .96); box-shadow: 0 24px 70px rgba(0,0,0,.48), 0 0 48px rgba(78,222,163,.05); }
    .mark { display: grid; width: 80px; height: 80px; place-items: center; margin: 0 auto 24px; border: 1px solid #27654f; border-radius: 50%; background: #15352b; box-shadow: 0 0 0 4px rgba(78,222,163,.05); color: #4edea3; }
    .mark svg { width: 34px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
    h1 { margin: 0; text-align: center; font-size: 25px; font-weight: 650; letter-spacing: -.025em; line-height: 32px; } p { margin: 9px 0 26px; color: #bbcabf; text-align: center; font-size: 15px; line-height: 23px; }
    .field { position: relative; } .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
    input { width: 100%; border: 1px solid #3c4a42; border-radius: 12px; padding: 16px 52px 16px 16px; background: #323537; color: #e0e3e5; font: 400 16px/22px inherit; outline: none; } input::placeholder { color: #aeb7b1; } input:focus { border-color: #4edea3; box-shadow: 0 0 0 3px rgba(78,222,163,.18); }
    .eye { position: absolute; top: 50%; right: 8px; display: grid; width: 38px; height: 38px; place-items: center; transform: translateY(-50%); border: 0; border-radius: 10px; background: transparent; color: #bbcabf; cursor: pointer; }.eye:hover { background: rgba(255,255,255,.07); color: #e0e3e5; }.eye svg { width: 22px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
    .confirmation { margin-top: 12px; }.primary { width: 100%; margin-top: 22px; border: 0; border-radius: 12px; padding: 15px; cursor: pointer; font: 700 15px/22px inherit; color: #003824; background: #4edea3; box-shadow: 0 4px 12px rgba(0,0,0,.35); }.primary:hover:not(:disabled) { background: #6ffbbe; }.primary:disabled { opacity: .65; cursor: wait; }.primary:focus-visible, .eye:focus-visible { outline: 2px solid #4edea3; outline-offset: 3px; }
    .error { min-height: 20px; margin: 12px 0 -8px; color: #ffb4ab; font-size: 13px; line-height: 20px; } .small { margin: 20px 0 0; color: #86948a; font-size: 12px; line-height: 18px; }
    @media (max-width: 520px) { .card { padding: 24px 20px; } h1 { font-size: 22px; } }
  `;

  function element(tag, { className, text, attributes } = {}) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    for (const [name, value] of Object.entries(attributes ?? {})) node.setAttribute(name, value);
    return node;
  }

  function svgElement(tag, attributes) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  }

  function createLockIcon() {
    const icon = svgElement("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
    icon.append(
      svgElement("rect", { x: "5", y: "10", width: "14", height: "10", rx: "2" }),
      svgElement("path", { d: "M8 10V7a4 4 0 0 1 8 0v3M12 14v2" })
    );
    return icon;
  }

  function createEyeIcon() {
    const icon = svgElement("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
    icon.append(
      svgElement("path", { d: "M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" }),
      svgElement("circle", { cx: "12", cy: "12", r: "2.5" })
    );
    return icon;
  }

  function ensureMounted() {
    if (host?.isConnected) return;
    if (!document.documentElement) {
      new MutationObserver((_, observer) => {
        if (document.documentElement) { observer.disconnect(); ensureMounted(); }
      }).observe(document, { childList: true });
      return;
    }
    host = document.createElement("div");
    host.setAttribute("aria-live", "assertive");
    shadow = host.attachShadow({ mode: "closed" });
    shadow.addEventListener("keydown", trapFocus);
    document.documentElement.append(host);
  }

  function setUnderlyingPageBlocked(shouldBlock) {
    const body = document.body;
    if (shouldBlock) {
      if (!body || bodyLockState?.body === body) return;
      bodyLockState = {
        body,
        hadInert: body.hasAttribute("inert"),
        inert: body.inert,
        hadAriaHidden: body.hasAttribute("aria-hidden"),
        ariaHidden: body.getAttribute("aria-hidden")
      };
      body.inert = true;
      body.setAttribute("aria-hidden", "true");
      return;
    }
    if (!bodyLockState) return;
    const previous = bodyLockState;
    bodyLockState = undefined;
    previous.body.inert = previous.inert;
    if (previous.hadInert) previous.body.setAttribute("inert", "");
    else previous.body.removeAttribute("inert");
    if (previous.hadAriaHidden) previous.body.setAttribute("aria-hidden", previous.ariaHidden);
    else previous.body.removeAttribute("aria-hidden");
  }

  function trapFocus(event) {
    if (event.key !== "Tab") return;
    const focusable = [...shadow.querySelectorAll("button:not([disabled]), input:not([disabled])")];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && shadow.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && shadow.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function render(mode, error = "") {
    ensureMounted();
    if (!shadow) return;
    screenMode = mode;
    setUnderlyingPageBlocked(true);
    const isSetup = mode === "setup";
    const style = element("style", { text: styles });
    const main = element("main", { className: "screen" });
    const card = element("section", { className: "card", attributes: { role: "dialog", "aria-modal": "true", "aria-labelledby": "title" } });
    const mark = element("div", { className: "mark" });
    mark.append(createLockIcon());
    const title = element("h1", { text: isSetup ? "Proteja seu WhatsApp" : "WhatsApp Web bloqueado", attributes: { id: "title" } });
    const description = element("p", { text: isSetup ? "Crie uma senha local para proteger suas conversas." : "Digite sua senha para continuar." });
    const form = element("form", { attributes: { id: "password-form" } });
    const field = element("div", { className: "field" });
    const passwordLabel = element("label", { className: "sr-only", text: "Senha", attributes: { for: "password" } });
    const passwordInput = element("input", { attributes: { id: "password", type: "password", placeholder: "Sua senha", autocomplete: isSetup ? "new-password" : "current-password" } });
    passwordInput.required = true;
    passwordInput.autofocus = true;
    const passwordToggle = element("button", { className: "eye", attributes: { id: "password-toggle", type: "button", "aria-label": "Mostrar senha" } });
    passwordToggle.append(createEyeIcon());
    field.append(passwordLabel, passwordInput, passwordToggle);
    form.append(field);
    if (isSetup) {
      const confirmation = element("div", { className: "confirmation" });
      const confirmationLabel = element("label", { className: "sr-only", text: "Confirme a senha", attributes: { for: "confirmation" } });
      const confirmationInput = element("input", { attributes: { id: "confirmation", type: "password", placeholder: "Confirme sua senha", autocomplete: "new-password" } });
      confirmationInput.required = true;
      confirmation.append(confirmationLabel, confirmationInput);
      form.append(confirmation);
    }
    const errorMessage = element("div", { className: "error", text: error, attributes: { role: "alert" } });
    const submitButton = element("button", { className: "primary", text: isSetup ? "Criar senha e desbloquear" : "Desbloquear", attributes: { type: "submit" } });
    form.append(errorMessage, submitButton);
    const privacyNote = element("p", { className: "small", text: "A senha fica apenas neste navegador." });
    card.append(mark, title, description, form, privacyNote);
    main.append(card);
    shadow.replaceChildren(style, main);
    passwordToggle.addEventListener("click", () => {
      const willShow = passwordInput.type === "password";
      passwordInput.type = willShow ? "text" : "password";
      passwordToggle.setAttribute("aria-label", willShow ? "Ocultar senha" : "Mostrar senha");
      passwordInput.focus();
    });
    passwordInput.focus();
    form.addEventListener("submit", (event) => submitPassword(event, mode));
  }

  async function send(message) {
    return api.runtime.sendMessage(message);
  }

  async function submitPassword(event, mode) {
    event.preventDefault();
    const password = shadow.querySelector("#password").value;
    const confirmation = shadow.querySelector("#confirmation")?.value;
    if (mode === "setup" && password !== confirmation) return render("setup", "As senhas não conferem.");
    const button = shadow.querySelector("button");
    button.disabled = true;
    const response = await send(mode === "setup"
      ? { type: "setup-password", password }
      : { type: "verify-password", password });
    if (!response?.ok) return render(mode, response?.error ?? "Não foi possível desbloquear.");
    unlock();
  }

  function unlock() {
    locked = false;
    screenMode = undefined;
    lastActivity = Date.now();
    setUnderlyingPageBlocked(false);
    host?.remove();
  }

  async function lock(mode = "unlock") {
    if (!settings.passwordProtectionEnabled) return false;
    if (locked && screenMode === mode) return true;
    locked = true;
    await send({ type: "lock-tab" });
    render(mode);
    return true;
  }

  function applyState(state) {
    settings = state.settings ?? settings;
  }

  async function initialize() {
    ensureMounted();
    render("unlock");
    const state = await send({ type: "get-state" });
    applyState(state ?? {});
    if (!settings.passwordProtectionEnabled) return unlock();
    if (!state?.hasPassword) return render("setup");
    render("unlock");
  }

  ["keydown", "mousedown", "pointerdown", "touchstart", "scroll"].forEach((eventName) => {
    document.addEventListener(eventName, () => { if (!locked) lastActivity = Date.now(); }, true);
  });
  window.addEventListener("blur", () => {
    if (!locked && settings.passwordProtectionEnabled && settings.lockOnWindowBlur) lock();
  });

  window.setInterval(() => {
    if (!locked
      && settings.passwordProtectionEnabled
      && settings.inactivityMinutes > 0
      && Date.now() - lastActivity >= settings.inactivityMinutes * 60_000) lock();
  }, 1_000);

  window.setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const state = await send({ type: "get-state" });
      const wasEnabled = settings.passwordProtectionEnabled;
      applyState(state ?? {});
      if (!settings.passwordProtectionEnabled) {
        if (locked) unlock();
      } else if (!state?.hasPassword) {
        await lock("setup");
      } else if (!wasEnabled && !locked) {
        await lock("unlock");
      }
    } finally {
      checking = false;
    }
  }, 10_000);

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "force-lock") {
      send({ type: "get-state" })
        .then((state) => {
          applyState(state ?? {});
          return lock(state?.hasPassword ? "unlock" : "setup");
        })
        .then((ok) => sendResponse({ ok }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
  });

  // Uma troca de senha deve encerrar a sessão de todas as abas abertas.
  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.settings?.newValue) {
      settings = { ...settings, ...changes.settings.newValue };
      if (!settings.passwordProtectionEnabled && locked) unlock();
    }
    if (areaName === "local"
      && changes.passwordRecord
      && !locked
      && settings.passwordProtectionEnabled) lock();
  });

  document.addEventListener("focusin", (event) => {
    if (!locked || !host?.isConnected || event.composedPath().includes(host)) return;
    shadow.querySelector("#password")?.focus();
  }, true);

  const rootObserver = new MutationObserver(() => {
    if (!locked) return;
    ensureMounted();
    setUnderlyingPageBlocked(true);
  });
  rootObserver.observe(document.documentElement ?? document, { childList: true });
  initialize().catch(() => render("unlock", "Não foi possível iniciar o bloqueio."));
})();
