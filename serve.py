"""
One-command launcher for the Sector Rotation RRG app.

  python serve.py            -> refresh data if stale, then serve + open browser
  python serve.py --no-fetch -> just serve whatever is in data/prices.json
  python serve.py --port 8090

Serving over http:// (instead of opening index.html as a file://) is what lets
the page load data/prices.json without the browser blocking it.
"""

import http.server
import json
import os
import socketserver
import sys
import threading
import webbrowser
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
DATA = os.path.join(HERE, "data", "prices.json")
STALE_HOURS = 6


def arg(flag, default=None):
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def needs_refresh():
    if "--no-fetch" in sys.argv:
        return False
    if "--fetch" in sys.argv:
        return True
    if not os.path.exists(DATA):
        return True
    try:
        with open(DATA, "r", encoding="utf-8") as f:
            gen = json.load(f).get("generated_at")
        age = datetime.now().astimezone() - datetime.fromisoformat(gen)
        return age > timedelta(hours=STALE_HOURS)
    except Exception:
        return True


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def do_POST(self):
        if self.path.rstrip("/") == "/api/refresh":
            try:
                import fetch_data
                code = fetch_data.main()
                body = json.dumps({"ok": code == 0}).encode()
            except Exception as e:  # noqa: BLE001
                body = json.dumps({"ok": False, "error": str(e)}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *a):
        pass


def main():
    if needs_refresh():
        print("Refreshing price data...\n")
        sys.path.insert(0, HERE)
        import fetch_data
        if fetch_data.main() != 0 and not os.path.exists(DATA):
            print("\nNo data available - cannot start. Fix connectivity and rerun.")
            return 1
        print("")

    port = int(arg("--port", "8777"))
    socketserver.TCPServer.allow_reuse_address = True
    while True:
        try:
            httpd = socketserver.TCPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            port += 1
            if port > 8820:
                print("No free port found.")
                return 1

    url = "http://127.0.0.1:%d/index.html" % port
    print("Sector Rotation RRG running at  %s" % url)
    print("Press Ctrl+C to stop.")
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
