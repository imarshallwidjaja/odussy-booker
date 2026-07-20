#!/usr/bin/env python3
"""Acquire Cloudflare clearance for a target URL using Scrapling.

Usage: python3 cf-clearance-acquire.py <url>
Outputs JSON to stdout: {"success": bool, "cookies": {...}, "user_agent": "...", "expires_at": ...}
"""

import json, sys, traceback
from scrapling.fetchers import StealthyFetcher

def acquire(url: str) -> dict:
    page = StealthyFetcher.fetch(
        url,
        solve_cloudflare=True,
        headless=True,
        network_idle=True,
        timeout=60,
    )

    context = getattr(page, 'context', None)
    if context is None:
        browser_contexts = getattr(page, '_browser_contexts', [])
        context = browser_contexts[0] if browser_contexts else None

    cookies = []
    if context:
        try:
            cookies = context.cookies()
        except Exception:
            cookies = []

    user_agent = "Mozilla/5.0"
    try:
        user_agent = page.evaluate("navigator.userAgent")
    except Exception:
        pass

    cf_clearance = next((c for c in cookies if c.get('name') == 'cf_clearance'), None)

    return {
        "success": cf_clearance is not None,
        "cookies": {c['name']: c['value'] for c in cookies},
        "user_agent": user_agent,
        "cf_clearance_expires": cf_clearance.get('expires') if cf_clearance else None,
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
