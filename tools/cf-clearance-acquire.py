#!/usr/bin/env python3
"""Fetch protected Lumos seat previews inside one restricted Scrapling browser."""

import base64
import ipaddress
import json
import os
import re
import select
import socket
import socketserver
import sys
import threading
from urllib.parse import unquote, urlparse


proxy = os.environ.get("CF_ACQUIRE_PROXY") or None
showtime_pattern = re.compile(r"^IMAX-[0-9]+$")
host_label_pattern = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
cloudflare_hosts = ("challenges.cloudflare.com",)
bootstrap_body_limit = 1_000_000
json_body_limit = 2_000_000
preview_payload_limit = 24_000_000
response_batch_size = 4
proxy_header_limit = 65_536


def normalize_allowed_hosts(values: object) -> tuple[str, ...]:
    if not isinstance(values, list) or not 1 <= len(values) <= 32:
        raise ValueError("Invalid Lumos host allowlist")
    normalized: list[str] = []
    for value in values:
        if not isinstance(value, str):
            raise ValueError("Invalid Lumos host allowlist")
        hostname = value.strip().lower().lstrip(".")
        labels = hostname.split(".")
        if (
            not hostname
            or len(hostname) > 253
            or any(not host_label_pattern.fullmatch(label) for label in labels)
        ):
            raise ValueError("Invalid Lumos host allowlist")
        try:
            ipaddress.ip_address(hostname)
        except ValueError:
            pass
        else:
            raise ValueError("Invalid Lumos host allowlist")
        if hostname not in normalized:
            normalized.append(hostname)
    return tuple(normalized)


def host_matches(hostname: str, allowed_hosts: tuple[str, ...]) -> bool:
    return any(hostname == host or hostname.endswith(f".{host}") for host in allowed_hosts)


def resolve_public_addresses(hostname: str) -> tuple[str, ...]:
    try:
        address = ipaddress.ip_address(hostname)
        return (str(address),) if address.is_global else ()
    except ValueError:
        pass
    try:
        addresses = tuple(dict.fromkeys(
            address[4][0].split("%", 1)[0]
            for address in socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
        ))
        if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
            return ()
        return addresses
    except (OSError, ValueError):
        return ()


def hostname_is_public(hostname: str) -> bool:
    return bool(resolve_public_addresses(hostname))


def parse_https_url(raw_url: str):
    parsed = urlparse(raw_url)
    hostname = (parsed.hostname or "").lower()
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError("Lumos service URL is not allowed") from error
    if (
        parsed.scheme != "https"
        or not hostname
        or parsed.username
        or parsed.password
        or port not in (None, 443)
    ):
        raise ValueError("Lumos service URL is not allowed")
    return parsed, hostname


def validated_navigation_url(raw_url: str, allowed_hosts: tuple[str, ...]) -> str:
    parsed, hostname = parse_https_url(raw_url)
    if (
        not host_matches(hostname, allowed_hosts)
        or not hostname_is_public(hostname)
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Lumos service URL is not allowed")
    return raw_url


def validated_base_url(raw_url: str, allowed_hosts: tuple[str, ...]) -> str:
    parsed = urlparse(validated_navigation_url(raw_url, allowed_hosts))
    if parsed.path not in ("", "/"):
        raise ValueError("Lumos service URL is not allowed")
    return raw_url.rstrip("/")


def browser_request_allowed(raw_url: str, method: str, allowed_hosts: tuple[str, ...]) -> bool:
    try:
        parsed, hostname = parse_https_url(raw_url)
    except ValueError:
        return False
    permitted_hosts = allowed_hosts + cloudflare_hosts
    if not host_matches(hostname, permitted_hosts) or not hostname_is_public(hostname):
        return False
    if method in ("GET", "HEAD", "OPTIONS"):
        return True
    return method == "POST" and (
        host_matches(hostname, cloudflare_hosts)
        or parsed.path.startswith("/cdn-cgi/challenge-platform/")
    )


def read_proxy_headers(connection: socket.socket) -> bytes:
    data = bytearray()
    while b"\r\n\r\n" not in data:
        chunk = connection.recv(4096)
        if not chunk:
            raise ConnectionError("Proxy client disconnected")
        data.extend(chunk)
        if len(data) > proxy_header_limit:
            raise ValueError("Proxy request headers exceeded the limit")
    return bytes(data)


def parse_upstream_proxy(raw_proxy: str | None):
    if not raw_proxy:
        return None
    parsed = urlparse(raw_proxy)
    if (
        parsed.scheme != "http"
        or not parsed.hostname
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Unsupported protected preview proxy")
    try:
        port = parsed.port or 80
    except ValueError as error:
        raise ValueError("Unsupported protected preview proxy") from error
    return {
        "hostname": parsed.hostname,
        "port": port,
        "username": unquote(parsed.username or ""),
        "password": unquote(parsed.password or ""),
    }


class RestrictedProxyServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, allowed_hosts: tuple[str, ...], upstream_proxy):
        self.allowed_hosts = allowed_hosts
        self.upstream_proxy = upstream_proxy
        super().__init__(("127.0.0.1", 0), RestrictedProxyHandler)


class RestrictedProxyHandler(socketserver.BaseRequestHandler):
    def send_status(self, status: int, reason: str) -> None:
        try:
            self.request.sendall(
                f"HTTP/1.1 {status} {reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".encode("ascii")
            )
        except OSError:
            pass

    def connect_target(self, address: str) -> socket.socket:
        upstream = self.server.upstream_proxy
        if upstream is None:
            return socket.create_connection((address, 443), timeout=10)

        connection = socket.create_connection((upstream["hostname"], upstream["port"]), timeout=10)
        authority = f"[{address}]:443" if ":" in address else f"{address}:443"
        headers = [
            f"CONNECT {authority} HTTP/1.1",
            f"Host: {authority}",
            "Proxy-Connection: Keep-Alive",
        ]
        if upstream["username"] or upstream["password"]:
            credentials = base64.b64encode(
                f"{upstream['username']}:{upstream['password']}".encode("utf-8")
            ).decode("ascii")
            headers.append(f"Proxy-Authorization: Basic {credentials}")
        connection.sendall(("\r\n".join(headers) + "\r\n\r\n").encode("ascii"))
        response = read_proxy_headers(connection)
        status_line = response.split(b"\r\n", 1)[0].split()
        if len(status_line) < 2 or status_line[1] != b"200":
            connection.close()
            raise ConnectionError("Upstream proxy rejected the tunnel")
        return connection

    def handle(self) -> None:
        target_connection = None
        try:
            self.request.settimeout(10)
            request = read_proxy_headers(self.request)
            request_line = request.split(b"\r\n", 1)[0].decode("ascii", "strict").split()
            if len(request_line) != 3 or request_line[0] != "CONNECT":
                self.send_status(405, "Method Not Allowed")
                return
            parsed = urlparse(f"//{request_line[1]}")
            hostname = (parsed.hostname or "").lower()
            public_addresses = resolve_public_addresses(hostname)
            if (
                parsed.port != 443
                or not host_matches(hostname, self.server.allowed_hosts + cloudflare_hosts)
                or not public_addresses
            ):
                self.send_status(403, "Forbidden")
                return

            for address in public_addresses:
                try:
                    target_connection = self.connect_target(address)
                    break
                except (ConnectionError, OSError):
                    continue
            if target_connection is None:
                raise ConnectionError("No validated target address was reachable")
            target_connection.settimeout(None)
            self.request.settimeout(None)
            self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            connections = (self.request, target_connection)
            while True:
                readable, _, _ = select.select(connections, (), (), 10)
                for source in readable:
                    data = source.recv(65_536)
                    if not data:
                        return
                    destination = target_connection if source is self.request else self.request
                    destination.sendall(data)
        except (ConnectionError, OSError, UnicodeError, ValueError):
            if target_connection is None:
                self.send_status(502, "Bad Gateway")
        finally:
            if target_connection is not None:
                target_connection.close()


class RestrictedProxy:
    def __init__(self, allowed_hosts: tuple[str, ...], upstream_proxy: str | None):
        self.server = RestrictedProxyServer(allowed_hosts, parse_upstream_proxy(upstream_proxy))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        host, port = self.server.server_address
        return f"http://{host}:{port}"

    def __exit__(self, _error_type, _error, _traceback) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def isolated_evaluate(cdp, context_id: int, function_source: str, argument: dict):
    expression = f"({function_source})({json.dumps(argument, separators=(',', ':'))})"
    response = cdp.send("Runtime.evaluate", {
        "expression": expression,
        "contextId": context_id,
        "awaitPromise": True,
        "returnByValue": True,
    })
    if response.get("exceptionDetails"):
        raise RuntimeError("Protected browser evaluation failed")
    result = response.get("result", {})
    if "value" not in result:
        raise RuntimeError("Protected browser evaluation returned no value")
    return result["value"]


def browser_json_fetch(cdp, context_id: int, url: str, token: str) -> dict:
    return isolated_evaluate(
        cdp,
        context_id,
        """async ({url, token, bodyLimit}) => {
          async function readBounded(response) {
            const declaredLength = Number(response.headers.get('content-length'));
            if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
              if (response.body) await response.body.cancel();
              return { body: '', oversized: true };
            }
            if (!response.body) return { body: '', oversized: false };
            const reader = response.body.getReader();
            const chunks = [];
            let total = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              total += value.byteLength;
              if (total > bodyLimit) {
                await reader.cancel();
                return { body: '', oversized: true };
              }
              chunks.push(value);
            }
            const bytes = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            return { body: new TextDecoder().decode(bytes), oversized: false };
          }
          const response = await fetch(url, {
            redirect: 'manual',
            headers: { accept: 'application/json', authorization: `Bearer ${token}` },
          });
          const bounded = await readBounded(response);
          return { status: response.status, url: response.url, ...bounded };
        }""",
        {"url": url, "token": token, "bodyLimit": json_body_limit},
    )


def acquire(url: str, allowed_hosts: tuple[str, ...], showtime_ids: list[str]) -> dict:
    if (
        not 1 <= len(showtime_ids) <= 100
        or len(set(showtime_ids)) != len(showtime_ids)
        or any(not showtime_pattern.fullmatch(showtime_id) for showtime_id in showtime_ids)
    ):
        raise ValueError("Invalid Lumos showtime IDs")
    navigation_url = validated_navigation_url(url, allowed_hosts)

    from scrapling.fetchers import StealthySession

    captured: dict = {
        "previews": [],
        "payload_bytes": 0,
        "bootstrap_oversized": False,
        "context_route_installed": False,
        "cdp": None,
    }

    def restrict_browser(page):
        def route_request(route):
            try:
                if browser_request_allowed(route.request.url, route.request.method, allowed_hosts):
                    route.continue_()
                else:
                    route.abort()
            except Exception:
                route.abort()

        try:
            if not captured["context_route_installed"]:
                page.context.route("**/*", route_request)
                captured["context_route_installed"] = True
            cdp = page.context.new_cdp_session(page)
            captured["cdp"] = cdp
            cdp.send("Network.enable")
            cdp.send("Page.enable")
            document_bytes: dict[str, int] = {}

            def stop_oversized_document():
                if captured["bootstrap_oversized"]:
                    return
                captured["bootstrap_oversized"] = True
                try:
                    cdp.send("Page.stopLoading")
                except Exception:
                    page.close()

            def response_received(event):
                if event.get("type") != "Document":
                    return
                request_id = event.get("requestId")
                if not isinstance(request_id, str):
                    return
                document_bytes[request_id] = 0
                headers = event.get("response", {}).get("headers", {})
                declared_length = next(
                    (value for key, value in headers.items() if key.lower() == "content-length"),
                    None,
                )
                try:
                    if declared_length is not None and int(declared_length) > bootstrap_body_limit:
                        stop_oversized_document()
                except (TypeError, ValueError):
                    pass

            def data_received(event):
                request_id = event.get("requestId")
                if request_id not in document_bytes:
                    return
                document_bytes[request_id] += int(event.get("dataLength", 0))
                if document_bytes[request_id] > bootstrap_body_limit:
                    stop_oversized_document()

            cdp.on("Network.responseReceived", response_received)
            cdp.on("Network.dataReceived", data_received)
        except Exception:
            page.close()
            raise

    def fetch_previews(page):
        try:
            if captured["bootstrap_oversized"] or str(page.url) != navigation_url:
                return page
            cdp = captured["cdp"]
            if cdp is None:
                return page
            frame_id = cdp.send("Page.getFrameTree")["frameTree"]["frame"]["id"]
            context_id = cdp.send("Page.createIsolatedWorld", {
                "frameId": frame_id,
                "worldName": "lumos-protected-preview",
                "grantUniveralAccess": False,
            })["executionContextId"]
            next_data = isolated_evaluate(
                cdp,
                context_id,
                """() => {
                  const element = document.querySelector('#__NEXT_DATA__');
                  if (!element) throw new Error('Missing bootstrap data');
                  return JSON.parse(element.textContent);
                }""",
                {},
            )
            page_props = next_data["props"]["pageProps"]
            environment = page_props["environment"]
            cms_config = page_props.get("cmsConfig") or environment["cmsConfig"]
            token = environment["gasToken"]
            if not isinstance(token, str) or not 1 <= len(token) <= 16_384:
                raise ValueError("Invalid Lumos bootstrap token")
            cms_base = validated_base_url(cms_config["apiUrl"], allowed_hosts)

            configuration_response = browser_json_fetch(
                cdp,
                context_id,
                f"{cms_base}/api/v1/sales-channels/web/configuration",
                token,
            )
            configuration_url = f"{cms_base}/api/v1/sales-channels/web/configuration"
            if (
                configuration_response["status"] != 200
                or configuration_response["url"] != configuration_url
                or configuration_response["oversized"]
            ):
                return page
            configuration = json.loads(configuration_response["body"])

            variants = configuration["configuration"]["languageVariantConfiguration"]
            digital_url = next(
                value["shared"]["initial"]["services"]["vistaConnect"]["url"]
                for value in variants.values()
                if value.get("shared", {}).get("initial", {}).get("services", {}).get("vistaConnect", {}).get("url")
            )
            digital_base = validated_base_url(digital_url, allowed_hosts)

            capacity_reached = False
            for batch_start in range(0, len(showtime_ids), response_batch_size):
                batch = showtime_ids[batch_start:batch_start + response_batch_size]
                responses = isolated_evaluate(
                    cdp,
                    context_id,
                    """async ({base, token, showtimeIds, bodyLimit}) => {
                      const results = new Array(showtimeIds.length);
                      let nextIndex = 0;
                      const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
                      async function readBounded(response) {
                        const declaredLength = Number(response.headers.get('content-length'));
                        if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
                          if (response.body) await response.body.cancel();
                          return { body: '', oversized: true };
                        }
                        if (!response.body) return { body: '', oversized: false };
                        const reader = response.body.getReader();
                        const chunks = [];
                        let total = 0;
                        while (true) {
                          const { done, value } = await reader.read();
                          if (done) break;
                          total += value.byteLength;
                          if (total > bodyLimit) {
                            await reader.cancel();
                            return { body: '', oversized: true };
                          }
                          chunks.push(value);
                        }
                        const bytes = new Uint8Array(total);
                        let offset = 0;
                        for (const chunk of chunks) {
                          bytes.set(chunk, offset);
                          offset += chunk.byteLength;
                        }
                        return { body: new TextDecoder().decode(bytes), oversized: false };
                      }
                      async function request(url, headers) {
                        for (let attempt = 0; attempt < 3; attempt += 1) {
                          try {
                            const response = await fetch(url, { headers, redirect: 'manual' });
                            const bounded = await readBounded(response);
                            if (bounded.oversized || ![403, 429].includes(response.status) || attempt === 2) {
                              return { status: response.status, url: response.url, ...bounded };
                            }
                          } catch {
                            if (attempt === 2) return { status: 0, url: '', body: '', oversized: false };
                          }
                          await wait(500 * (attempt + 1));
                        }
                        return { status: 0, url: '', body: '', oversized: false };
                      }
                      async function worker() {
                        while (true) {
                          const index = nextIndex++;
                          const id = showtimeIds[index];
                          if (!id) return;
                          const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
                          const [layout, availability] = await Promise.all([
                            request(`${base}/ocapi/v1/showtimes/${id}/seat-layout`, headers),
                            request(`${base}/ocapi/v1/showtimes/${id}/seat-availability?preview=true`, headers),
                          ]);
                          results[index] = {
                            showtimeId: id,
                            layoutStatus: layout.status,
                            layoutUrl: layout.url,
                            layoutBody: layout.body,
                            layoutOversized: layout.oversized,
                            availabilityStatus: availability.status,
                            availabilityUrl: availability.url,
                            availabilityBody: availability.body,
                            availabilityOversized: availability.oversized,
                          };
                        }
                      }
                      await Promise.all(Array.from({ length: Math.min(2, showtimeIds.length) }, worker));
                      return results;
                    }""",
                    {
                        "base": digital_base,
                        "token": token,
                        "showtimeIds": batch,
                        "bodyLimit": json_body_limit,
                    },
                )

                for response in responses:
                    expected_layout_url = (
                        f"{digital_base}/ocapi/v1/showtimes/{response['showtimeId']}/seat-layout"
                    )
                    expected_availability_url = (
                        f"{digital_base}/ocapi/v1/showtimes/{response['showtimeId']}"
                        "/seat-availability?preview=true"
                    )
                    if (
                        response["layoutStatus"] != 200
                        or response["availabilityStatus"] != 200
                        or response["layoutUrl"] != expected_layout_url
                        or response["availabilityUrl"] != expected_availability_url
                        or response["layoutOversized"]
                        or response["availabilityOversized"]
                    ):
                        continue
                    try:
                        preview = {
                            "showtime_id": response["showtimeId"],
                            "layout": json.loads(response["layoutBody"]),
                            "availability": json.loads(response["availabilityBody"]),
                        }
                        preview_bytes = len(
                            json.dumps(preview, separators=(",", ":")).encode("utf-8")
                        )
                    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                        continue
                    if captured["payload_bytes"] + preview_bytes > preview_payload_limit:
                        capacity_reached = True
                        break
                    captured["previews"].append(preview)
                    captured["payload_bytes"] += preview_bytes
                if capacity_reached:
                    break
        except Exception:
            pass
        return page

    options = {
        "headless": True,
        "solve_cloudflare": True,
        "google_search": True,
        "network_idle": True,
        "timeout": 45_000,
        "block_webrtc": True,
        "hide_canvas": True,
        "additional_args": {"service_workers": "block"},
        "extra_flags": ["--disable-quic", "--proxy-bypass-list=<-loopback>"],
        "page_setup": restrict_browser,
        "page_action": fetch_previews,
    }

    with RestrictedProxy(allowed_hosts, proxy) as restricted_proxy:
        options["proxy"] = restricted_proxy
        with StealthySession(**options) as session:
            page = session.fetch(navigation_url)
            final_url = validated_navigation_url(str(page.url), allowed_hosts)
            if final_url != navigation_url:
                raise ValueError("Protected bootstrap redirected unexpectedly")
            body = page.body if isinstance(page.body, bytes) else str(page.body).encode(page.encoding or "utf-8")
            usable_bootstrap = (
                page.status == 200
                and len(body) <= bootstrap_body_limit
                and b"__NEXT_DATA__" in body
            )
            previews = captured["previews"]
            return {
                "success": usable_bootstrap and len(previews) > 0,
                "previews": previews,
            }


def emit_failure() -> None:
    print(json.dumps({"success": False, "previews": []}, separators=(",", ":")))


if __name__ == "__main__":
    if len(sys.argv) < 4:
        emit_failure()
        sys.exit(1)

    try:
        hosts = normalize_allowed_hosts(json.loads(sys.argv[2]))
        result = acquire(sys.argv[1], hosts, sys.argv[3:])
        print(json.dumps(result, separators=(",", ":")))
        if not result["success"]:
            sys.exit(1)
    except Exception:
        emit_failure()
        sys.exit(1)
