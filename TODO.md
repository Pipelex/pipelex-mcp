
REFRENCE DOC FOR MCP: https://gofastmcp.com/getting-started/welcome

✅ 0) Investigate current state (what we have vs want) - COMPLETED

Investigation Results:

✅ Uses FastMCP 2.13.0.1 (modern version)
✅ NOW FIXED: FastMCP(..., settings=Settings(show_cli_banner=False)) present (prevents banner)
✅ All logging configured to stderr (line 51) or RotatingFileHandler (lines 35-55)
✅ NOW FIXED: Pipelex.make() wrapped with stdout silencer (line 188-189)
✅ All tools (pipe_builder, pipe_runner) wrapped with _silence_stdout() (lines 88, 115)
✅ pyproject.toml has console script at line 42:
   [project.scripts]
   pipelex_mcp = "server.main:main"  # Note: uses underscore, not hyphen
✅ Command installed: .venv/bin/pipelex_mcp exists

CRITICAL FIXES APPLIED:
1. Import fastmcp.settings module (line 19)
2. Set fastmcp.settings.show_cli_banner = False before FastMCP init (line 61)
3. Wrapped Pipelex.make() with _silence_stdout() (lines 188-189)

Status: ~100% complete - All stdout protection mechanisms in place

Why: In STDIO transport the client expects JSON-RPC on stdout only; logs must go to stderr. Any banner/print on stdout breaks the client. 
Model Context Protocol
+1

✅ 1) Pin transports & silence banners (code) - COMPLETED

✅ In server/main.py implemented:

import fastmcp.settings  # line 19
fastmcp.settings.show_cli_banner = False  # line 61 - disable banner BEFORE FastMCP init
mcp = FastMCP("pipelex", version="2.0.0")  # line 63-67


✅ Stdout silencer added and used throughout:

class _Sink(io.StringIO):  # lines 70-74
    def write(self, s): return len(s)

def _silence_stdout():  # lines 77-79
    return redirect_stdout(_Sink())

def main():  # lines 186-190
    configure_logging(...)
    with _silence_stdout():
        Pipelex.make()  # Silenced!
    mcp.run()  # stdio by default

# Tools also wrapped (lines 88, 115)


Why: Prevents any import-time or dependency print() from touching stdout. 
GitHub

✅ 2) Central logging (stderr/file only) - ALREADY IMPLEMENTED

✅ Configure logging once (stderr or file; never stdout) - lines 35-55:

def configure_logging(level="INFO", log_file=None):
    root = logging.getLogger()
    root.setLevel(level.upper())
    for h in list(root.handlers): root.removeHandler(h)  # Remove stdout handlers!
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s",
                            "%Y-%m-%d %H:%M:%S")
    if log_file:
        fh = RotatingFileHandler(log_file, maxBytes=5_000_000, backupCount=3)
        fh.setFormatter(fmt); fh.setLevel(level.upper()); root.addHandler(fh)
    else:
        sh = logging.StreamHandler(sys.stderr)  # STDERR only!
        sh.setFormatter(fmt); sh.setLevel(level.upper()); root.addHandler(sh)


Why: MCP spec allows logging to stderr (clients may capture it). 
Model Context Protocol

✅ 3) Provide 2 run modes (stdio + HTTP) - ALREADY IMPLEMENTED

✅ Keep STDIO default for IDEs (lines 192-197):

if args.transport == "http":
    log.info("Starting Pipelex MCP Server on HTTP at %s:%s", args.host, args.port)
    mcp.run(transport="http", host=args.host, port=args.port)
else:
    log.info("Starting Pipelex MCP Server on stdio")
    mcp.run()  # stdio default


CLI args supported (lines 174-180):
  --transport {stdio,http}  (default: stdio)
  --host 127.0.0.1
  --port 9003
  --log-level INFO
  --log-file path/to/file.log

Why: STDIO is simplest; HTTP is best when you want to see one process and attach multiple clients/Inspector. 
modelcontextprotocol.info
+1

4) Claude Desktop/Code config (local stdio) - READY TO CONFIGURE

 Add/update claude_desktop_config.json:

{
  "mcpServers": {
    "pipelex": {
      "command": "/Users/thomashebrardevotis/dev/pipelex/pipelex-mcp/.venv/bin/pipelex_mcp",
      "args": ["--transport", "stdio"],
      "env": {
        "PYTHONUNBUFFERED": "1"
      }
    }
  }
}

NOTE: Command is "pipelex_mcp" (underscore), not "pipelex-mcp" (hyphen)
NOTE: FASTMCP_NO_BANNER env var not needed - banner disabled in code via Settings


 View logs: Claude → Settings → Local MCP Servers → Open Logs Folder (then tail -f that file). 
wjgilmore.com

Why: Claude spawns the process (stdio) and captures stderr to log files. 
DeepWiki

5) Cursor config (stdio or SSE) - READY TO CONFIGURE

 Cursor → Settings → Features → MCP → Add New MCP Server

Type: stdio → command /Users/thomashebrardevotis/dev/pipelex/pipelex-mcp/.venv/bin/pipelex_mcp
             args: --transport stdio

Or Type: sse/http → URL http://127.0.0.1:9003/sse (if running HTTP mode separately)

NOTE: Command is "pipelex_mcp" (underscore), not "pipelex-mcp" (hyphen)
Cursor
+1

6) Inspector (see JSON-RPC traffic)

 Run Inspector and connect via STDIO/HTTP to exercise tools & inspect payloads.
(It includes a proxy; keep it local.) 
Model Context Protocol
+1

7) Credentials

 Put API keys/base URLs in the client’s env block for this server (Claude/Cursor).

 If using a proxy (e.g., LiteLLM), set the correct BASE_URL and key type (proxy/virtual vs provider).
Why: Avoids 401s from the proxy; keys flow to the spawned process.

8) Sanity test (HTTP mode first, then stdio) - READY TO TEST

 Run manually (debug mode):

source .venv/bin/activate
pipelex_mcp --transport http --host 127.0.0.1 --port 9003 --log-level=DEBUG

NOTE: Command is "pipelex_mcp" (underscore)

 Open Inspector and connect to http://127.0.0.1:9003 → call health, then a real tool. 
Model Context Protocol

 Switch to stdio via Claude/Cursor. Confirm no "Unexpected token" popups (meaning stdout is clean).

9) Troubleshooting quick list

“Unexpected token … not valid JSON”
→ Something wrote to stdout (banner/print).
Fix: ensure banner disabled, logs→stderr/file, and redirect_stdout around init/tools. 
GitHub

Server launches, but no logs
→ Tail Claude’s MCP log folder (Desktop shows path in UI). 
wjgilmore.com

Cursor can’t see server
→ Re-check Type (stdio vs SSE) and path/URL; refresh servers list. 
cursor.directory

10) (Optional) Final polish

✅ --log-file and --log-level CLI flags already implemented (lines 178-180)
   - Can use: --log-file ./logs/pipelex-mcp.log
   - Can use: --log-level DEBUG
   - Also supports env vars: PIPELEX_MCP_LOG, PIPELEX_MCP_LOG_FILE

 Add a Make target to pip install -e . after uv sync (if needed)

✅ FastMCP version pinned at >=2.13.0.1 in pyproject.toml (line 16)
✅ show_cli_banner=False now in code (line 65)
GitHub

References

MCP transports & STDIO rules (JSON only on stdout; logs → stderr). 
Model Context Protocol
+1

FastMCP banner disable (Settings(show_cli_banner=False)). 
GitHub
+1

Claude Desktop local server setup & logs. 
DeepWiki
+1

Cursor MCP setup (stdio/SSE). 
Cursor
+1

MCP Inspector docs & repo. 
Model Context Protocol
+