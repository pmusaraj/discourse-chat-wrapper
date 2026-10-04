(async () => {
  if (location.protocol !== "https:" || window !== window.top || !window.tiny || tiny.win.id !== "main") return;
  // Installed synchronously at document start, before any remote UI can paint.
  const gate = document.createElement("style");
  gate.textContent = "html { background:#f7f5f1 !important; } body { visibility:hidden !important; } @media (prefers-color-scheme:dark) { html { background:#1b1a18 !important; } }";
  function installGate() { if (document.documentElement && !gate.isConnected) document.documentElement.append(gate); }
  installGate();
  if (!document.documentElement) {
    const observer = new MutationObserver(() => { installGate(); if (gate.isConnected) observer.disconnect(); });
    observer.observe(document, { childList: true, subtree: true });
  }
  try { await tiny.api.call("siteContext", {}); } catch { return; }
  let expired = false;
  function sessionExpired() {
    if (expired) return;
    expired = true;
    installGate();
    tiny.api.call("sessionExpired", {}).catch(() => {});
  }
  const authPath = /^\/(?:login|login-required|password-reset|logout|session|auth|signup|user-api-key|u\/password-reset|u\/activate-account|u\/account-created)(?:\/|$)/;
  if (authPath.test(location.pathname)) { sessionExpired(); return; }

  function browserDestination(value) {
    const url = new URL(value, location.href);
    if (!["http:", "https:"].includes(url.protocol)) return;
    if (url.origin === location.origin &&
        /^\/chat(?:\/|$)/.test(url.pathname)) return;
    return url.href;
  }

  function openBrowser(url) {
    const target = new URL(url);
    if (target.origin === location.origin && authPath.test(target.pathname)) { sessionExpired(); return; }
    tiny.api.call("openBrowser", { url }).catch(() => {
      console.warn("Discourse Chat App could not open the link in your browser.");
    });
  }

  function interceptLink(event) {
    if (!window.tiny || tiny.win.id !== "main" || event.button > 1 || !/^\/chat(?:\/|$)/.test(location.pathname)) return;
    const anchor = event.composedPath().find((node) => node.matches?.("a[href]"));
    if (!anchor || anchor.hasAttribute("download")) return;
    const destination = browserDestination(anchor.href);
    if (!destination) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openBrowser(destination);
  }
  window.addEventListener("click", interceptLink, true);
  window.addEventListener("auxclick", interceptLink, true);

  let linkedRouter;
  function connectRouter(container) {
    const router = container?.lookup("service:router");
    if (!router || linkedRouter === router) return;
    router.on("routeWillChange", (transition) => {
      if (!/^\/chat(?:\/|$)/.test(location.pathname) || !transition.to) return;
      let destination;
      try {
        const chain = [];
        for (let route = transition.to; route; route = route.parent) chain.unshift(route);
        const models = chain.flatMap((route) => Object.values(route.params ?? {}));
        destination = browserDestination(router.urlFor(transition.to.name, ...models,
          { queryParams: transition.to.queryParams ?? {} }));
      } catch {
        // Unresolved transitions may be intermediate/loading routes.
        return;
      }
      if (destination) {
        transition.abort();
        openBrowser(destination);
      }
    });
    linkedRouter = router;
  }

  // The local startup screen covers the network request. Once the remote
  // document commits, keep feedback visible while Discourse boots its JS app.
  function showLoading() {
    const host = document.createElement("div");
    host.id = "dev-chat-loading";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { color-scheme:light dark; --background:#f7f5f1; --text:#17212f; --muted:#626873; --accent:#2475ed; opacity:1; transition:opacity 180ms ease; }
        section { box-sizing:border-box; min-height:100%; display:grid; place-content:center; justify-items:center; text-align:center; padding:32px 24px;
          background:color-mix(in srgb, var(--background) 58%, transparent); backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px); color:var(--text); font:16px -apple-system,system-ui,sans-serif; }
        h1 { font-size:24px; font-weight:600; letter-spacing:-.4px; margin:24px 0 12px; }
        p { color:var(--muted); max-width:400px; line-height:1.55; margin:12px 0; }
        button { font:inherit; padding:10px 16px; margin:4px; border:1px solid #8885; border-radius:10px; background:var(--background); color:var(--text); cursor:pointer; }
        .pulse { width:24px; height:24px; border-radius:50%; background:var(--accent); animation:waiting-pulse 1.6s ease-in-out infinite; }
        @keyframes waiting-pulse { 0%,100% { transform:scale(.85); opacity:.65; box-shadow:0 0 0 0 color-mix(in srgb, var(--accent) 22%, transparent); } 50% { transform:scale(1); opacity:1; box-shadow:0 0 0 14px transparent; } }
        [hidden] { display:none !important; }
        @media (prefers-color-scheme:dark) { :host { --background:#1b1a18; --text:#f2f1ee; --muted:#b8b6b2; --accent:#307df0; } }
        @media (prefers-reduced-motion:reduce) { :host { transition:none; } .pulse { animation:none; } }
      </style>
      <section role="status" aria-live="polite"><span class="pulse" aria-hidden="true"></span><h1>Waiting for chat</h1>
        <p></p>
        <div hidden><button id="retry">Retry</button><button id="home">Home</button></div>
      </section>`;
    document.documentElement.append(host);
    const slow = setTimeout(() => {
      root.querySelector("p").textContent = "This is taking longer than usual. You can keep waiting or retry.";
      root.querySelector("div").hidden = false;
    }, 12000);
    let dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      clearTimeout(slow);
      host.style.opacity = "0";
      setTimeout(() => host.remove(), 180);
    }
    root.querySelector("#retry").onclick = () => location.reload();
    root.querySelector("#home").onclick = () => tiny.api.call("returnHome", {}).catch(() => {});
    window.__devChatLoadFailed = () => {
      clearTimeout(slow);
      root.querySelector("h1").textContent = "Couldn’t open chat";
      root.querySelector(".pulse").hidden = true;
      root.querySelector("p").textContent = "Couldn’t load chat. Check your connection and try again.";
      root.querySelector("div").hidden = false;
    };
    return dismiss;
  }

  let dismissLoading;
  function beginLoading() {
    if (document.documentElement) dismissLoading = showLoading();
  }
  beginLoading();

  // Only simplify an actual chat view. Login, password reset, account settings,
  // and identity-provider pages retain their normal interface.
  const css = `
    #dev-chat-titlebar {
      position: fixed; inset: 0 0 auto; height: 40px; z-index: 10000;
      display: flex; align-items: center; justify-content: center;
      padding: 0 90px; box-sizing: border-box; user-select: none;
      font: 500 12px -apple-system, system-ui, sans-serif;
      background: var(--secondary, Canvas); color: var(--primary-medium, CanvasText);
      border-bottom: 1px solid var(--primary-low, #8883);
    }
    body { padding-top: 40px !important; }
    html[data-dev-chat-poc] {
      --header-offset: 0px;
      --dev-chat-sidebar-width: 280px;
      --dev-chat-toolbar-height: 48px;
      --dev-chat-divider: color-mix(in srgb, var(--primary) 12%, transparent);
    }
    html[data-dev-chat-poc] body {
      padding-top: 0 !important;
      background: var(--secondary, Canvas) !important;
    }
    html[data-dev-chat-poc] #dev-chat-titlebar {
      right: auto;
      width: var(--dev-chat-sidebar-width);
      height: var(--dev-chat-toolbar-height);
      background: transparent;
      border-bottom: 0;
      border-right: 1px solid var(--dev-chat-divider);
      color: transparent;
      pointer-events: auto;
    }
    html[data-dev-chat-poc] .sidebar-wrapper {
      padding-top: var(--dev-chat-toolbar-height) !important;
      box-sizing: border-box;
      height: 100dvh;
      max-height: 100dvh;
      top: 0;
      background: var(--secondary, Canvas) !important;
      border-right: 1px solid var(--dev-chat-divider);
    }
    html[data-dev-chat-poc] .sidebar-footer-container::before {
      display: none !important;
    }
    html[data-dev-chat-poc] .c-navbar-container {
      min-height: var(--dev-chat-toolbar-height);
      box-sizing: border-box;
      user-select: none;
    }
    html[data-dev-chat-poc]:not([data-dev-chat-sidebar]) .c-navbar-container {
      padding-left: 88px;
    }
    html[data-dev-chat-poc]:not([data-dev-chat-sidebar]) #dev-chat-titlebar {
      width: 84px;
      background: transparent;
      border: 0;
    }
    html[data-dev-chat-poc] .d-header,
    html[data-dev-chat-poc] .profiler-results {
      display: none !important;
    }
    html[data-dev-chat-poc] #main-outlet-wrapper {
      --main-grid-gap: 0px;
      gap: 0 !important;
      padding: 0 !important;
      max-width: none !important;
    }
    html[data-dev-chat-poc] #main-outlet {
      margin: 0 !important;
      padding: 0 !important;
      max-width: 100% !important;
    }
    html[data-dev-chat-poc] .main-chat-outlet {
      border-radius: 0 !important;
      height: 100dvh;
      display: flex;
      flex-direction: column;
    }
    html[data-dev-chat-poc] .sidebar-section[data-section-name="topics"],
    html[data-dev-chat-poc] .sidebar-section[data-section-name="categories"],
    html[data-dev-chat-poc] .sidebar-section[data-section-name="tags"],
    html[data-dev-chat-poc] .sidebar-section[data-section-name="messages"],
    html[data-dev-chat-poc] .sidebar-section[data-section-name="community"],
    html[data-dev-chat-poc] .sidebar-custom-sections,
    html[data-dev-chat-poc] .sidebar__panel-switch-button {
      display: none !important;
    }
  `;

  function start() {
    if (!dismissLoading) dismissLoading = showLoading();
    const style = document.createElement("style");
    style.id = "dev-chat-poc-styles";
    style.textContent = css;
    document.head.append(style);
    const titlebar = document.createElement("div");
    titlebar.id = "dev-chat-titlebar";
    titlebar.setAttribute("data-tiny-drag", "");
    titlebar.textContent = "Discourse Chat App";
    document.body.prepend(titlebar);

    let observedSidebar;
    const measureSidebar = () => {
      const width = observedSidebar?.getBoundingClientRect().width ?? 0;
      document.documentElement.toggleAttribute("data-dev-chat-sidebar", width > 0);
      if (width > 0) document.documentElement.style.setProperty("--dev-chat-sidebar-width", `${width}px`);
    };
    const sidebarObserver = new ResizeObserver(measureSidebar);

    function updateLayout() {
      if (document.querySelector(".login-modal, .login-fullpage, #login-form") || authPath.test(location.pathname)) {
        sessionExpired();
        return;
      }
      const currentUser = window.Discourse?.__container__?.lookup("service:current-user");
      if (currentUser?.id && document.querySelector(".main-chat-outlet, #main-chat-outlet")) {
        gate.remove();
        dismissLoading();
      }
      const chatRoute = /^\/chat(?:\/|$)/.test(location.pathname);
      const chatVisible = document.documentElement.classList.contains("has-full-page-chat") ||
        !!document.querySelector(".main-chat-outlet, #main-chat-outlet");
      const active = chatRoute && chatVisible;
      if (document.documentElement.hasAttribute("data-dev-chat-poc") !== active) {
        document.documentElement.toggleAttribute("data-dev-chat-poc", active);
        window.dispatchEvent(new Event("resize"));
      }
      const sidebar = active ? document.querySelector(".sidebar-wrapper") : null;
      if (sidebar !== observedSidebar) {
        sidebarObserver.disconnect();
        observedSidebar = sidebar;
        if (sidebar) sidebarObserver.observe(sidebar);
        measureSidebar();
      }
      for (const navbar of document.querySelectorAll(".c-navbar-container")) {
        navbar.toggleAttribute("data-tiny-drag", active);
      }
    }

    // Discourse transitions without reloading the page. Watch rendered route
    // changes without depending on private Ember services or router internals.
    let scheduled = false;
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      // Animation frames can stop while the app is inactive/occluded. Layout
      // must still catch up when Discourse renders after the initial page load.
      setTimeout(() => {
        scheduled = false;
        updateLayout();
      }, 16);
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", updateLayout);
    updateLayout();
    connectChatAlerts();
  }

  function connectChatAlerts() {
    if (!window.tiny || tiny.win.id !== "main") return;
    let subscription;
    let stopped = false;
    let timer;
    const report = (ready) => tiny.api.call("chatListenerReady", { ready }).catch(() => {});
    const plainText = (value) => {
      // Discourse excerpts may contain HTML/entities; notification text must
      // never render markup or copy an entire message into native storage.
      const parsed = new DOMParser().parseFromString(String(value ?? ""), "text/html");
      return parsed.body.textContent.trim();
    };
    function disconnect() {
      if (!subscription) return;
      subscription.bus.unsubscribe(subscription.channel, subscription.handler);
      subscription = undefined;
      report(false);
    }
    function check() {
      if (stopped) return;
      try {
        const container = window.Discourse?.__container__;
        connectRouter(container);
        const user = container?.lookup("service:current-user");
        const bus = container?.lookup("service:message-bus");
        if (!user?.id || !bus) {
          if (container && user !== undefined) sessionExpired();
          disconnect();
        } else if (subscription?.user !== user || subscription.bus !== bus) {
          disconnect();
          const channel = `/chat/notification-alert/${user.id}`;
          const handler = (data) => {
            if (user.isInDoNotDisturb?.()) return;
            tiny.api.call("chatAlert", {
              messageId: Number(data.chat_message_id),
              title: plainText(data.translated_title || `${data.username || "Someone"} sent a chat message`),
              body: plainText(data.excerpt), url: data.post_url,
            }).catch(() => console.warn("Discourse Chat App could not deliver a desktop notification."));
          };
          // Subscribe alongside Discourse, rather than relying on its browser
          // Notification API or visibility-based active-channel suppression.
          bus.subscribe(channel, handler);
          subscription = { user, bus, channel, handler };
          report(true);
        }
      } catch {
        // Ember's container/services are not necessarily ready at DOMContentLoaded.
      }
      timer = setTimeout(check, 2000);
    }
    window.addEventListener("pagehide", () => {
      stopped = true;
      clearTimeout(timer);
      disconnect();
    });
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) { stopped = false; check(); }
    });
    check();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
