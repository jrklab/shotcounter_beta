"""
serve.py — Local dev server for the web app.

Adds the headers required for cross-origin isolation (needed by ONNX Runtime
Web's WASM backend and SharedArrayBuffer):
  Cross-Origin-Opener-Policy:   same-origin
  Cross-Origin-Embedder-Policy: require-corp

Usage:
  python3 web/serve.py          # serves web/ on http://localhost:8765
  python3 web/serve.py 9000     # custom port
"""
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class COIHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # No COOP/COEP needed — cnn-classifier.js uses numThreads=1 which
        # avoids SharedArrayBuffer and works without cross-origin isolation.
        super().end_headers()

    def log_message(self, fmt, *args):
        print(f'  {self.address_string()} — {fmt % args}')


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = HTTPServer(('localhost', port), COIHandler)
    print(f'Serving http://localhost:{port}/  (Ctrl-C to stop)')
    server.serve_forever()
