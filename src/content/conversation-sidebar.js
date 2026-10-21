(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const STORAGE_KEY = "conversationSidebarCollapsed";
  const SETTINGS_KEY = "settings";
  const COMPACT_WIDTH = 80;
  const SIDEBAR_ATTRIBUTE = "data-bw-conversation-sidebar";
  const MAIN_ATTRIBUTE = "data-bw-conversation-main";
  const CONTAINER_ATTRIBUTE = "data-bw-conversation-container";
  const CHAT_LIST_ATTRIBUTE = "data-bw-conversation-list";
  const CHROME_ATTRIBUTE = "data-bw-sidebar-chrome";
  const DIVIDER_ATTRIBUTE = "data-bw-stale-divider";
  const TOGGLE_HEADER_ATTRIBUTE = "data-bw-toggle-header";
  const STYLE_ID = "bw-conversation-sidebar-styles";
  const HOST_ID = "bw-conversation-sidebar-toggle";

  const sidebarSelectors = [
    "#side",
    "#pane-side",
    '[data-testid="chat-list"]',
    '[aria-label="Chat list"]',
    '[aria-label="Lista de conversas"]',
    '[aria-label*="conversas" i][role="grid"]',
    '[aria-label*="conversations" i][role="grid"]'
  ];
  const chatListSelectors = sidebarSelectors.slice(1);

  let collapsed = false;
  let collapseMode = "avatars";
  let sidebar;
  let chatList;
  let mainPane;
  let sidebarContainer;
  let navigationControl;
  let toggleHost;
  let toggleButton;
  let toggleHeader;
  let expandedBounds;
  let containerBaseWidth = 0;
  let updateTimer;
  let refreshChromeScheduled = false;

  function rectangleFor(element) {
    if (!(element instanceof HTMLElement)) return null;
    const rectangle = element.getBoundingClientRect();
    if (rectangle.width < 1 || rectangle.height < 1) return null;
    return rectangle;
  }

  function normalizedLabel(element) {
    return (element.getAttribute("aria-label") ?? element.getAttribute("title") ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  }

  function isLikelySidebar(rectangle) {
    return rectangle.width >= 240
      && rectangle.width <= window.innerWidth * 0.62
      && rectangle.height >= window.innerHeight * 0.45
      && rectangle.left < window.innerWidth * 0.45;
  }

  function outerSidebarFor(candidate) {
    const initialBounds = rectangleFor(candidate);
    if (!initialBounds || !isLikelySidebar(initialBounds)) return null;

    let best = candidate;
    let bestBounds = initialBounds;
    let current = candidate.parentElement;

    for (let depth = 0; current && depth < 9; depth += 1, current = current.parentElement) {
      if (current === document.body || current === document.documentElement) break;
      const currentBounds = rectangleFor(current);
      if (!currentBounds) continue;

      const keepsLeftEdge = Math.abs(currentBounds.left - initialBounds.left) <= 16;
      const keepsWidth = Math.abs(currentBounds.width - initialBounds.width) <= 64;
      if (!keepsLeftEdge || !keepsWidth) break;

      if (isLikelySidebar(currentBounds) && currentBounds.height >= bestBounds.height) {
        best = current;
        bestBounds = currentBounds;
      }
    }

    return { element: best, bounds: bestBounds };
  }

  function findSidebar() {
    const candidates = document.querySelectorAll(sidebarSelectors.join(","));
    let match = null;

    for (const candidate of candidates) {
      const result = outerSidebarFor(candidate);
      if (!result) continue;
      const hasHeader = Boolean(result.element.querySelector("header"));
      const score = result.bounds.height + (hasHeader ? window.innerHeight : 0);
      if (!match || score > match.score) match = { ...result, score };
    }

    if (!match) return null;
    const list = match.element.matches(chatListSelectors.join(","))
      ? match.element
      : match.element.querySelector(chatListSelectors.join(","));
    return { element: match.element, bounds: match.bounds, list };
  }

  function findLayoutContext(sidebarElement, sidebarBounds) {
    let branch = sidebarElement;

    for (let depth = 0; branch.parentElement && depth < 5; depth += 1) {
      const parent = branch.parentElement;
      let match = null;
      let largestArea = 0;

      for (const child of parent.children) {
        if (child === branch || !(child instanceof HTMLElement)) continue;
        const bounds = rectangleFor(child);
        if (!bounds || bounds.height < window.innerHeight * 0.45) continue;
        if (bounds.right <= sidebarBounds.right || bounds.width < 240) continue;
        const area = bounds.width * bounds.height;
        if (area > largestArea) {
          match = child;
          largestArea = area;
        }
      }

      if (match) {
        if (branch === sidebarElement) return { main: match, container: null, baseWidth: 0 };
        const branchBounds = rectangleFor(branch);
        const baseWidth = Math.max(0, sidebarBounds.left - (branchBounds?.left ?? 0));
        return { main: match, container: branch, baseWidth };
      }
      branch = parent;
    }
    return { main: null, container: null, baseWidth: 0 };
  }

  function findNavigationControl() {
    if (navigationControl?.isConnected) return navigationControl;
    const controls = document.querySelectorAll(
      'button[aria-label], [role="button"][aria-label], [role="tab"][aria-label], [title]'
    );
    for (const labeledElement of controls) {
      const label = normalizedLabel(labeledElement);
      if (!(label === "conversas" || label === "chats" || label.startsWith("conversas ") || label.startsWith("chats "))) continue;
      const control = labeledElement.closest('button, [role="button"], [role="tab"]') ?? labeledElement;
      const bounds = rectangleFor(control);
      if (!bounds || bounds.width > 100 || bounds.height > 100) continue;
      if (expandedBounds && bounds.right > expandedBounds.left + 16) continue;
      navigationControl = control;
      return control;
    }
    navigationControl = undefined;
    return null;
  }

  function navigationInsertionPoint(control) {
    let item = control;
    for (let depth = 0; item.parentElement && depth < 6; depth += 1) {
      const parent = item.parentElement;
      const itemBounds = rectangleFor(item);
      const parentBounds = rectangleFor(parent);
      if (!itemBounds || !parentBounds) break;
      if (parentBounds.width <= 120 && parentBounds.height >= itemBounds.height * 2.2) {
        return { parent, after: item };
      }
      item = parent;
    }
    return null;
  }

  function ensurePageStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${SIDEBAR_ATTRIBUTE}="hidden"] { display: none !important; }
      [${SIDEBAR_ATTRIBUTE}="compact"] {
        width: ${COMPACT_WIDTH}px !important;
        min-width: ${COMPACT_WIDTH}px !important;
        max-width: ${COMPACT_WIDTH}px !important;
        flex: 0 0 ${COMPACT_WIDTH}px !important;
        overflow: hidden !important;
        border: 0 !important;
        box-shadow: inset 1px 0 rgba(134, 150, 160, .12), inset -1px 0 rgba(134, 150, 160, .12) !important;
      }
      [${SIDEBAR_ATTRIBUTE}="compact"] [${CHROME_ATTRIBUTE}] { display: none !important; }
      [${CONTAINER_ATTRIBUTE}="compact"] [${CHROME_ATTRIBUTE}] { display: none !important; }
      [${SIDEBAR_ATTRIBUTE}="compact"] header:not([${TOGGLE_HEADER_ATTRIBUTE}]) { display: none !important; }
      [${SIDEBAR_ATTRIBUTE}="compact"] header[${TOGGLE_HEADER_ATTRIBUTE}] > :not(#${HOST_ID}) { display: none !important; }
      [${SIDEBAR_ATTRIBUTE}="compact"] header[${TOGGLE_HEADER_ATTRIBUTE}] {
        width: ${COMPACT_WIDTH}px !important;
        min-width: ${COMPACT_WIDTH}px !important;
        padding: 0 !important;
        justify-content: center !important;
        overflow: hidden !important;
      }
      [${SIDEBAR_ATTRIBUTE}="compact"] [${CHAT_LIST_ATTRIBUTE}] {
        width: var(--bw-expanded-sidebar-width) !important;
        min-width: var(--bw-expanded-sidebar-width) !important;
        max-width: none !important;
        height: 100% !important;
        overflow-x: hidden !important;
      }
      [${SIDEBAR_ATTRIBUTE}="compact"] [${CHAT_LIST_ATTRIBUTE}] img {
        flex-shrink: 0 !important;
        object-fit: cover !important;
      }
      [${SIDEBAR_ATTRIBUTE}="compact"][${CHAT_LIST_ATTRIBUTE}] > * {
        width: var(--bw-expanded-sidebar-width) !important;
        min-width: var(--bw-expanded-sidebar-width) !important;
      }
      [${MAIN_ATTRIBUTE}="expanded"] {
        width: 100% !important;
        max-width: none !important;
        min-width: 0 !important;
        flex: 1 1 auto !important;
        border-left: 0 !important;
        box-shadow: none !important;
      }
      [${MAIN_ATTRIBUTE}="expanded"] > *,
      [${MAIN_ATTRIBUTE}="expanded"] > *::before,
      [${MAIN_ATTRIBUTE}="expanded"] > *::after {
        border-left-color: transparent !important;
        box-shadow: none !important;
      }
      [${DIVIDER_ATTRIBUTE}] {
        border-left: 0 !important;
        border-right: 0 !important;
        box-shadow: none !important;
      }
      [${DIVIDER_ATTRIBUTE}]::before,
      [${DIVIDER_ATTRIBUTE}]::after {
        border-left: 0 !important;
        border-right: 0 !important;
        box-shadow: none !important;
      }
      [${DIVIDER_ATTRIBUTE}="thin"],
      [${DIVIDER_ATTRIBUTE}="thin"]::before,
      [${DIVIDER_ATTRIBUTE}="thin"]::after { background: transparent !important; }
      [${CONTAINER_ATTRIBUTE}="compact"] {
        width: var(--bw-compact-width, 0px) !important;
        min-width: var(--bw-compact-width, 0px) !important;
        max-width: var(--bw-compact-width, 0px) !important;
        flex: 0 0 var(--bw-compact-width, 0px) !important;
        overflow: hidden !important;
        border: 0 !important;
        box-shadow: none !important;
      }
    `;
    (document.head ?? document.documentElement).append(style);
  }

  function createPanelIcon() {
    const namespace = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(namespace, "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    const panel = document.createElementNS(namespace, "path");
    panel.setAttribute("d", "M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13ZM9 4v16");
    const arrow = document.createElementNS(namespace, "path");
    arrow.classList.add("arrow");
    arrow.setAttribute("d", "m15 9-3 3 3 3");
    icon.append(panel, arrow);
    return icon;
  }

  function ensureToggle() {
    if (toggleHost) return;
    toggleHost = document.createElement("div");
    toggleHost.id = HOST_ID;
    const shadow = toggleHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        display: flex;
        width: 44px;
        height: 44px;
        flex: 0 0 44px;
        align-items: center;
        justify-content: center;
        align-self: center;
        position: relative;
        z-index: 10;
      }
      :host([data-location="navigation"]) { width: 100%; margin: 2px 0; }
      :host([data-location="header"]) { margin: 0 4px; }
      :host([data-location="floating"]) {
        position: fixed;
        top: 8px;
        left: var(--bw-toggle-left, 8px);
        z-index: 2147483000;
      }
      *, *::before, *::after { box-sizing: border-box; }
      button {
        display: grid;
        width: 40px;
        height: 40px;
        place-items: center;
        margin: 0;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: #aebac1;
        cursor: pointer;
        transition: background 120ms ease, color 120ms ease;
      }
      button:hover { background: #374248; color: #e9edef; }
      button:focus-visible { outline: 2px solid #00a884; outline-offset: 1px; }
      svg {
        width: 24px;
        height: 24px;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.8;
      }
      button[data-collapsed="true"] .arrow { transform: rotate(180deg); transform-origin: center; }
      @media (prefers-reduced-motion: reduce) { button { transition: none; } }
    `;
    toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.append(createPanelIcon());
    toggleButton.addEventListener("click", () => setCollapsed(!collapsed, true));
    shadow.append(style, toggleButton);
  }

  function mountToggle() {
    ensureToggle();
    const control = findNavigationControl();
    const insertionPoint = control && navigationInsertionPoint(control);

    if (insertionPoint) {
      toggleHeader?.removeAttribute(TOGGLE_HEADER_ATTRIBUTE);
      toggleHeader = undefined;
      toggleHost.dataset.location = "navigation";
      insertionPoint.parent.insertBefore(toggleHost, insertionPoint.after.nextSibling);
      return;
    }

    const header = sidebar?.querySelector("header");
    if (header) {
      toggleHeader?.removeAttribute(TOGGLE_HEADER_ATTRIBUTE);
      toggleHeader = header;
      toggleHeader.setAttribute(TOGGLE_HEADER_ATTRIBUTE, "");
      toggleHost.dataset.location = "header";
      header.append(toggleHost);
      return;
    }

    toggleHeader?.removeAttribute(TOGGLE_HEADER_ATTRIBUTE);
    toggleHeader = undefined;
    toggleHost.dataset.location = "floating";
    const left = Math.max(4, (expandedBounds?.left ?? 48) + 8);
    toggleHost.style.setProperty("--bw-toggle-left", `${left}px`);
    document.documentElement.append(toggleHost);
  }

  function updateToggle() {
    if (!toggleButton) return;
    const collapsedValue = String(collapsed);
    const label = collapsed ? "Mostrar lista de conversas" : "Recolher lista de conversas";
    if (toggleButton.dataset.collapsed !== collapsedValue) {
      toggleButton.dataset.collapsed = collapsedValue;
    }
    if (toggleButton.getAttribute("aria-label") !== label) {
      toggleButton.setAttribute("aria-label", label);
    }
    if (toggleButton.title !== label) toggleButton.title = label;
  }

  function clearChromeMarkers() {
    document.querySelectorAll(`[${CHROME_ATTRIBUTE}]`).forEach((element) => {
      element.removeAttribute(CHROME_ATTRIBUTE);
    });
    chatList?.removeAttribute(CHAT_LIST_ATTRIBUTE);
  }

  function compactRowFor(element) {
    const boundary = sidebarContainer ?? sidebar;
    let current = element;
    let match = null;
    while (current && current !== chatList && current !== boundary) {
      const bounds = rectangleFor(current);
      if (!bounds || bounds.height > 110) break;
      if (expandedBounds && bounds.width >= expandedBounds.width * 0.65) match = current;
      current = current.parentElement;
    }
    return match;
  }

  function markArchivedRow() {
    if (!chatList) return;
    const candidates = chatList.querySelectorAll("[aria-label], [title], span, div");
    for (const candidate of candidates) {
      const label = normalizedLabel(candidate);
      const text = (candidate.textContent ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase();
      if (!["arquivadas", "arquivados", "archived"].includes(label)
        && !["arquivadas", "arquivados", "archived"].includes(text)) continue;
      compactRowFor(candidate)?.setAttribute(CHROME_ATTRIBUTE, "");
      break;
    }
  }

  function markNamedChrome(listBounds) {
    const root = sidebarContainer ?? sidebar;
    if (!root) return;
    const candidates = root.querySelectorAll(
      'button, [role="button"], [role="search"], [role="textbox"], [aria-label], [title]'
    );
    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement) || candidate.contains(toggleHost)) continue;
      const bounds = rectangleFor(candidate);
      if (!bounds || bounds.top >= listBounds.top + 4) continue;
      if (expandedBounds
        && (bounds.right <= expandedBounds.left + 8 || bounds.left >= expandedBounds.right)) continue;
      const label = normalizedLabel(candidate);
      const text = (candidate.textContent ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase();
      const isSearch = label.includes("pesquisar") || label.includes("search");
      const isAllFilter = text === "tudo" || text === "all";
      const isMenu = label === "menu" || label.includes("mais opcoes") || label.includes("more options");
      if (!isSearch && !isAllFilter && !isMenu) continue;
      (compactRowFor(candidate) ?? candidate).setAttribute(CHROME_ATTRIBUTE, "");
    }
  }

  function markSidebarChrome() {
    clearChromeMarkers();
    if (!sidebar || !chatList) return;
    chatList.setAttribute(CHAT_LIST_ATTRIBUTE, "");
    const listBounds = rectangleFor(chatList);
    if (!listBounds) return;

    const markerRoot = sidebarContainer ?? sidebar;
    let branch = chatList;
    while (branch.parentElement && branch !== markerRoot) {
      const parent = branch.parentElement;
      for (const sibling of parent.children) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
        const bounds = rectangleFor(sibling);
        if (!bounds || bounds.top >= listBounds.top || bounds.height > 260) continue;
        if (expandedBounds
          && (bounds.right <= expandedBounds.left + 8 || bounds.left >= expandedBounds.right)) continue;
        if (sibling.contains(toggleHost)) continue;
        sibling.setAttribute(CHROME_ATTRIBUTE, "");
      }
      branch = parent;
    }
    markNamedChrome(listBounds);
    markArchivedRow();
  }

  function clearDividerMarkers() {
    document.querySelectorAll(`[${DIVIDER_ATTRIBUTE}]`).forEach((element) => {
      element.removeAttribute(DIVIDER_ATTRIBUTE);
    });
  }

  function markStaleDivider() {
    clearDividerMarkers();
    if (!collapsed || !expandedBounds || typeof document.elementsFromPoint !== "function") return;
    const x = Math.min(window.innerWidth - 1, Math.max(0, expandedBounds.right));
    const samples = [64, window.innerHeight / 2, window.innerHeight - 64];
    for (const y of samples) {
      for (const element of document.elementsFromPoint(x, y)) {
        if (!(element instanceof HTMLElement) || element === document.body || element === document.documentElement) continue;
        const bounds = rectangleFor(element);
        if (!bounds || bounds.height < window.innerHeight * 0.4) continue;
        const touchesOldEdge = Math.abs(bounds.left - x) <= 3 || Math.abs(bounds.right - x) <= 3;
        if (!touchesOldEdge) continue;
        element.setAttribute(DIVIDER_ATTRIBUTE, bounds.width <= 4 ? "thin" : "edge");
      }
    }
  }

  function applyLayoutContext(layout) {
    mainPane = layout.main;
    sidebarContainer = layout.container;
    containerBaseWidth = layout.baseWidth;
  }

  function clearCurrentElements() {
    sidebar?.removeAttribute(SIDEBAR_ATTRIBUTE);
    sidebar?.style.removeProperty("--bw-expanded-sidebar-width");
    mainPane?.removeAttribute(MAIN_ATTRIBUTE);
    sidebarContainer?.removeAttribute(CONTAINER_ATTRIBUTE);
    sidebarContainer?.style.removeProperty("--bw-compact-width");
    toggleHeader?.removeAttribute(TOGGLE_HEADER_ATTRIBUTE);
    clearChromeMarkers();
    clearDividerMarkers();
    sidebar = undefined;
    chatList = undefined;
    mainPane = undefined;
    sidebarContainer = undefined;
    toggleHeader = undefined;
    navigationControl = undefined;
  }

  function connectToSidebar() {
    if (sidebar?.isConnected) {
      if (!chatList?.isConnected) {
        chatList = sidebar.matches(chatListSelectors.join(","))
          ? sidebar
          : sidebar.querySelector(chatListSelectors.join(","));
        if (chatList) markSidebarChrome();
      }
      const layoutIsCurrent = mainPane?.isConnected
        && (!sidebarContainer || sidebarContainer.isConnected);
      if (!layoutIsCurrent) applyLayoutContext(findLayoutContext(sidebar, expandedBounds));
      if (!toggleHost?.isConnected) mountToggle();
      return true;
    }

    clearCurrentElements();
    const match = findSidebar();
    if (!match) return false;
    sidebar = match.element;
    chatList = match.list;
    expandedBounds = match.bounds;
    sidebar.style.setProperty("--bw-expanded-sidebar-width", `${match.bounds.width}px`);
    applyLayoutContext(findLayoutContext(sidebar, match.bounds));
    ensurePageStyles();
    mountToggle();
    markSidebarChrome();
    return true;
  }

  function applyState(refreshChrome = false) {
    if (!connectToSidebar()) return;
    if (refreshChrome) markSidebarChrome();
    const sidebarState = collapsed
      ? (collapseMode === "hidden" ? "hidden" : "compact")
      : "expanded";
    const stateChanged = sidebar.getAttribute(SIDEBAR_ATTRIBUTE) !== sidebarState;
    if (stateChanged) sidebar.setAttribute(SIDEBAR_ATTRIBUTE, sidebarState);

    if (mainPane) {
      if (collapsed && mainPane.getAttribute(MAIN_ATTRIBUTE) !== "expanded") {
        mainPane.setAttribute(MAIN_ATTRIBUTE, "expanded");
      } else if (!collapsed && mainPane.hasAttribute(MAIN_ATTRIBUTE)) {
        mainPane.removeAttribute(MAIN_ATTRIBUTE);
      }
    }
    if (sidebarContainer) {
      const compactWidth = containerBaseWidth + (sidebarState === "compact" ? COMPACT_WIDTH : 0);
      const compactWidthValue = `${compactWidth}px`;
      if (sidebarContainer.style.getPropertyValue("--bw-compact-width") !== compactWidthValue) {
        sidebarContainer.style.setProperty("--bw-compact-width", compactWidthValue);
      }
      if (collapsed && sidebarContainer.getAttribute(CONTAINER_ATTRIBUTE) !== "compact") {
        sidebarContainer.setAttribute(CONTAINER_ATTRIBUTE, "compact");
      } else if (!collapsed && sidebarContainer.hasAttribute(CONTAINER_ATTRIBUTE)) {
        sidebarContainer.removeAttribute(CONTAINER_ATTRIBUTE);
      }
    }
    updateToggle();

    if (stateChanged) requestAnimationFrame(markStaleDivider);

    if (!collapsed) {
      requestAnimationFrame(() => {
        const currentBounds = rectangleFor(sidebar);
        if (currentBounds) {
          expandedBounds = currentBounds;
          sidebar.style.setProperty("--bw-expanded-sidebar-width", `${currentBounds.width}px`);
        }
      });
    }
  }

  async function setCollapsed(nextValue, persist = false) {
    collapsed = Boolean(nextValue);
    applyState(collapsed);
    if (!persist) return;
    try {
      await api.storage.local.set({ [STORAGE_KEY]: collapsed });
    } catch {
      // Mantém o estado atual da aba caso o armazenamento não esteja disponível.
    }
  }

  function scheduleUpdate(refreshChrome = false) {
    refreshChromeScheduled ||= refreshChrome;
    if (updateTimer !== undefined) return;
    updateTimer = window.setTimeout(() => {
      updateTimer = undefined;
      const shouldRefreshChrome = refreshChromeScheduled;
      refreshChromeScheduled = false;
      applyState(shouldRefreshChrome);
    }, 120);
  }

  function trackedLayoutNeedsReconnect() {
    return !sidebar?.isConnected
      || Boolean(chatList && !chatList.isConnected)
      || !toggleHost?.isConnected
      || Boolean(mainPane && !mainPane.isConnected)
      || Boolean(sidebarContainer && !sidebarContainer.isConnected);
  }

  function handleRootMutation() {
    if (trackedLayoutNeedsReconnect()) scheduleUpdate(true);
  }

  function isChatsNavigationClick(event) {
    const control = findNavigationControl();
    return Boolean(control && event.composedPath().includes(control));
  }

  async function initialize() {
    try {
      const stored = await api.storage.local.get([STORAGE_KEY, SETTINGS_KEY]);
      collapsed = Boolean(stored[STORAGE_KEY]);
      collapseMode = stored[SETTINGS_KEY]?.sidebarCollapseMode === "hidden" ? "hidden" : "avatars";
    } catch {
      collapsed = false;
      collapseMode = "avatars";
    }
    applyState();

    // Observa apenas a raiz. A lista do WhatsApp muda sem parar durante mensagens
    // e rolagem; observar toda a subárvore fazia a extensão recalcular o layout
    // em praticamente cada frame.
    new MutationObserver(handleRootMutation).observe(document.documentElement, {
      childList: true
    });
    window.setInterval(() => {
      if (trackedLayoutNeedsReconnect()) scheduleUpdate(true);
    }, 1_000);
    window.addEventListener("resize", () => scheduleUpdate(), { passive: true });
    document.addEventListener("click", (event) => {
      if (!sidebar?.isConnected || !isChatsNavigationClick(event)) return;
      window.setTimeout(() => {
        if (sidebar?.isConnected) setCollapsed(!collapsed, true);
      }, 0);
    }, true);

    api.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (changes[STORAGE_KEY]) collapsed = Boolean(changes[STORAGE_KEY].newValue);
      if (changes[SETTINGS_KEY]) {
        collapseMode = changes[SETTINGS_KEY].newValue?.sidebarCollapseMode === "hidden"
          ? "hidden"
          : "avatars";
      }
      applyState(collapsed);
    });
    api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "toggle-conversation-sidebar") return undefined;
      setCollapsed(!collapsed, true)
        .then(() => sendResponse({ ok: true, collapsed }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    });
  }

  initialize();
})();
