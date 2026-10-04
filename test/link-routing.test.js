import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("injected links and Ember transitions open outside chat without navigating away", async () => {
  const listeners = {};
  const opened = [];
  const window = { addEventListener: (name, handler) => { listeners[name] = handler; } };
  window.top = window;
  window.tiny = { win: { id: "main" }, api: { call: async (name, payload) => { if (name !== "siteContext") opened.push({ name, ...payload }); } } };
  const context = vm.createContext({ window, tiny: window.tiny, URL, console, MutationObserver: class { observe() {} },
    location: { protocol: "https:", origin: "https://dev.discourse.org", href: "https://dev.discourse.org/chat/c/general/1", pathname: "/chat/c/general/1" },
    document: { createElement: () => ({}), readyState: "loading", addEventListener() {} },
  });
  const source = readFileSync(new URL("../src/inject.js", import.meta.url), "utf8");
  await vm.runInContext(source.replace(/\}\)\(\);\s*$/, "window.testConnectRouter = connectRouter; })();"), context);
  function click(href, button = 0) {
    let prevented = false;
    const anchor = { href, matches: () => true, hasAttribute: () => false };
    listeners[button ? "auxclick" : "click"]({ button, composedPath: () => [anchor],
      preventDefault: () => { prevented = true; }, stopImmediatePropagation() {} });
    return prevented;
  }
  assert.equal(click("https://dev.discourse.org/chat/c/other/2"), false);
  assert.equal(click("https://dev.discourse.org/t/topic/123"), true);
  assert.equal(click("https://example.com/chat", 1), true);
  assert.equal(click("https://dev.discourse.org/login"), true);
  assert.equal(opened.length, 3);
  assert.equal(opened.at(-1).name, "sessionExpired");
  let routeHandler;
  const router = { on(name, handler) { assert.equal(name, "routeWillChange"); routeHandler = handler; },
    urlFor(name, ...args) {
      assert.equal(name, "topic.fromParamsNear");
      assert.deepEqual(args.slice(0, -1), ["topic", "123", "4"]);
      return "/t/topic/123/4?test=1";
    } };
  window.testConnectRouter({ lookup: () => router });
  let aborted = false;
  routeHandler({ to: { name: "topic.fromParamsNear", params: { nearPost: "4" },
    parent: { params: { slug: "topic", id: "123" } } }, abort() { aborted = true; } });
  assert.ok(aborted);
  assert.equal(opened.at(-1).url, "https://dev.discourse.org/t/topic/123/4?test=1");
});
