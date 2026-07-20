#!/usr/bin/env python3
"""Acquire Cloudflare clearance for a target URL using Scrapling.

Tries strategies in order:
  1. StealthySession with Camoufox (Firefox, best fingerprint spoofing)
  2. StealthySession plain (Playwright Chromium)

Usage: python3 cf-clearance-acquire.py <url>
Proxy set via CF_ACQUIRE_PROXY env var.
Outputs JSON to stdout: {"success": bool, "cookies": {...}, "user_agent": "...", "cf_clearance_expires": ...}
"""

import json, os, sys, traceback
from urllib.parse import urlparse

proxy = os.environ.get("CF_ACQUIRE_PROXY") or None


def try_camoufox(url: str) -> dict | None:
    try:
        from scrapling.fetchers import StealthySession as BaseSession
        from camoufox.utils import launch_options
        from playwright.sync_api import sync_playwright

        class CamoufoxSession(BaseSession):
            def start(self):
                if not self.playwright:
                    self.playwright = sync_playwright().start()
                lo = launch_options(**{
                    "headless": True,
                    "humanize": True,
                    "block_webrtc": True,
                    "geoip": False,
                    "i_know_what_im_doing": True,
                    "allow_webgl": False,
                })
                self.context = self.playwright.firefox.launch_persistent_context(**lo)

        opts = {
            "headless": True,
            "solve_cloudflare": True,
            "google_search": True,
            "network_idle": True,
            "timeout": 90,
            "block_webrtc": True,
            "hide_canvas": True,
            "humanize": True,
        }
        if proxy:
            opts["proxy"] = proxy

        with CamoufoxSession(**opts) as session:
            page = session.fetch(url)
            return extract_from_session(page)
    except Exception as e:
        return None


def try_chromium_stealth(url: str) -> dict | None:
    try:
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
            return extract_from_session(page)
    except Exception as e:
        return None


def extract_from_session(page) -> dict:
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

    user_agent = "Mozilla/5.0"
    try:
        user_agent = page.evaluate("navigator.userAgent")
    except Exception:
        pass

    cf_clearance = next((c for c in cookies if c.get("name") == "cf_clearance"), None)
    return {
        "success": cf_clearance is not None,
        "cookies": {c["name"]: c["value"] for c in cookies},
        "user_agent": user_agent,
        "cf_clearance_expires": cf_clearance.get("expires") if cf_clearance else None,
        "cf_clearance_domain": cf_clearance.get("domain", "") if cf_clearance else "",
    }


def acquire(url: str) -> dict:
    result = try_camoufox(url)
    if result and result.get("success"):
        result["strategy"] = "camoufox"
        return result

    result = try_chromium_stealth(url)
    if result and result.get("success"):
        result["strategy"] = "chromium_stealth"
        return result

    msg = "camoufox: no cf_clearance" if result is None else "failed"
    return {"success": False, "error": msg, "cookies": {}, "user_agent": "", "cf_clearance_expires": None}


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
