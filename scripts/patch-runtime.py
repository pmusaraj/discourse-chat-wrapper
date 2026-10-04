from pathlib import Path
import sys

source = Path(sys.argv[1])
text = source.read_text()
anchor = '// --- on-device AI: FoundationModels'
assert text.count(anchor) == 1
text = text.replace(anchor, '#include "chat-session.inc"\n\n' + anchor)
anchor = '      } else if (line == "RELOAD") {'
assert text.count(anchor) == 1
text = text.replace(anchor, '''      } else if (line == "CHATHOME") {
        webview_dispatch(g_w, do_chat_home, nullptr);
      } else if (line.rfind("CHATCLEAR ", 0) == 0) {
        webview_dispatch(g_w, do_chat_clear, new std::string(line.substr(10)));
      } else if (line.rfind("CHATSESSION ", 0) == 0) {
        size_t sp = line.find(' ', 12);
        if (sp == std::string::npos) continue;
        std::vector<std::string> p = split_tabs(line.substr(sp + 1));
        webview_dispatch(g_w, do_chat_session, new ChatSessionArgs{
          line.substr(12, sp - 12), p.size() > 0 ? p[0] : "", p.size() > 1 ? p[1] : "", p.size() > 2 ? p[2] : "check"});
''' + anchor)
source.write_text(text)
bridge = Path('.runtime/runtime/bridge.js')
text = bridge.read_text()
# Replace the complete app-specific block when updating an existing patch.
start = text.find("    chatHome() {")
if start != -1:
    end = text.index("    async reload(newHtml) {", start)
    text = text[:start] + text[end:]
anchor = '    async reload(newHtml) {'
assert text.count(anchor) == 1
text = text.replace(anchor, """    chatHome() { send('CHATHOME'); },
    chatSession(origin, token = '', operation = 'check') { return ask('CHATSESSION', [one(origin), one(token), one(operation)].join(String.fromCharCode(9))); },
    chatClearSessions() { return ask('CHATCLEAR'); },
""" + anchor)
bridge.write_text(text)
