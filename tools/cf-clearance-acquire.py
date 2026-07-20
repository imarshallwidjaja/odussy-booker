#!/usr/bin/env python3
"""Acquire Cloudflare clearance for a target URL using Scrapling StealthySession.

Proxy from CF_ACQUIRE_PROXY env var.

Usage: python3 cf-clearance-acquire.py <url>
Outputs JSON to stdout: {"success": bool, "cookies": {...}, "user_agent": "...", ...}
"""

import json, os, sys, traceback

proxy = os.environ.get("CF_ACQUIRE_PROXY") or None


def acquire(url: str) -> dict:
    from scrapling.fetchers import StealthySession

    opts = {
        "headless": True,
        "solve_cloudflare": True,
        "google_search": True,
        "network_idle": True,
        "timeout": 90,
        "block_webrtc": True,
        "hide_canvas": True,
    }
    if proxy:
        opts["proxy"] = proxy

    with StealthySession(**opts) as session:
        page = session.fetch(url)
        cookies = []
        try:
            if page.context:
                cookies = page.context.cookies()
        except Exception:
            try:
                raw = page.evaluate("() => document.cookie")
                if raw:
                    cookies = [
                        {"name": p.split("=")[0].strip(), "value": "=".join(p.split("=")[1:]).strip()}
                        for p in raw.split(";") if "=" in p
                    ]
            except Exception:
                pass
        ua = "Mozilla/5.0"
        try:
            ua = page.evaluate("navigator.userAgent")
        except Exception:
            pass
        cf = next((c for c in cookies if c.get("name") == "cf_clearance"), None)
        return {
            "success": cf is not None,
            "cookies": {c["name"]: c["value"] for c in cookies},
            "user_agent": ua,
            "cf_clearance_expires": cf.get("expires") if cf else None,
            "cf_clearance_domain": cf.get("domain", "") if cf else "",
        }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: python3 cf-clearance-acquire.py <url>"}))
        sys.exit(1)

    try:
        result = acquire(sys.argv[1])
        print(json.dumps(result))
        if not result.get("success"):
            sys.exit(1)
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e), "traceback": traceback.format_exc()}))
        sys.exit(1)
