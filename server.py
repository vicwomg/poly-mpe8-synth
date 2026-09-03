#!/usr/bin/env python3
"""
HTTP / HTTPS server to serve the MPE Web MIDI Synth locally.
Usage:
  python3 server.py [port]             # Standard HTTP (e.g. http://localhost:8080)
  python3 server.py [port] --ssl       # Secure HTTPS (e.g. https://localhost:8443)
"""
import http.server
import socketserver
import socket
import ssl
import subprocess
import sys
import os

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'

def ensure_ssl_cert(cert_path='cert.pem', key_path='key.pem'):
    if not (os.path.exists(cert_path) and os.path.exists(key_path)):
        print("Generating self-signed SSL certificate for HTTPS...")
        cmd = [
            'openssl', 'req', '-x509', '-newkey', 'rsa:2048',
            '-keyout', key_path, '-out', cert_path,
            '-days', '365', '-nodes',
            '-subj', '/CN=localhost'
        ]
        subprocess.run(cmd, check=True)
        print("SSL certificate created (cert.pem, key.pem).")

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Enable CORS and disable caching during dev
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

def run():
    use_ssl = '--ssl' in sys.argv
    args = [a for a in sys.argv[1:] if a != '--ssl']
    default_port = 8443 if use_ssl else 8080
    port = int(args[0]) if len(args) > 0 else default_port

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", port), Handler) as httpd:
        protocol = "https" if use_ssl else "http"
        local_ip = get_local_ip()

        if use_ssl:
            ensure_ssl_cert()
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(certfile='cert.pem', keyfile='key.pem')
            httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

        print("==================================================")
        print(f"  MPE Web MIDI Synth running via {protocol.upper()}:")
        print(f"  Desktop: {protocol}://localhost:{port}")
        print(f"  Mobile:  {protocol}://{local_ip}:{port}")
        if not use_ssl:
            print("  Note for Android Chrome:")
            print("  If connecting via phone, run with --ssl or use")
            print("  Chrome Port Forwarding for Web MIDI to work.")
        print("==================================================")
        print("Press Ctrl+C to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")

if __name__ == '__main__':
    run()
