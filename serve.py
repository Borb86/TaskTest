"""Local development server for Borb — Tactical RPG Tracker PWA.
Forces correct JavaScript/CSS/SVG/JSON MIME types on Windows.
Usage: python serve.py [port]
"""

import http.server
import socketserver
import sys


class PwaHandler(http.server.SimpleHTTPRequestHandler):
    MIME_OVERRIDES = {
        '.js': 'application/javascript; charset=utf-8',
        '.mjs': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.webmanifest': 'application/manifest+json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
    }

    def guess_type(self, path):
        import os
        ext = os.path.splitext(path)[1].lower()
        if ext in self.MIME_OVERRIDES:
            return self.MIME_OVERRIDES[ext]
        return super().guess_type(path)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('127.0.0.1', port), PwaHandler) as httpd:
        print(f'Borb RPG Tracker running at http://127.0.0.1:{port}/')
        print(f'Unit Tests:                 http://127.0.0.1:{port}/tests/test-runner.html')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nShutting down.')


if __name__ == '__main__':
    main()
