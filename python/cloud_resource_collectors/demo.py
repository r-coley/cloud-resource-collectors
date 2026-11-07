"""Offline demonstration; never connects to a provider or database."""

import argparse
from html import escape
from pathlib import Path
from .common import read_json, dumps
from .cli import collect_snapshot


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--examples", default="examples")
    p.add_argument("--output", default="runs/demo")
    o = p.parse_args()
    for cloud in ("azure", "aws", "gcp"):
        base = Path(o.examples)
        snapshot = collect_snapshot(
            cloud,
            read_json(base / f"{cloud}-service.config.json"),
            read_json(base / f"{cloud}-service.inventory.json"),
        )
        dest = Path(o.output) / cloud
        dest.mkdir(parents=True, exist_ok=True, mode=0o700)
        (dest / "cloud-inventory.json").write_text(dumps(snapshot, pretty=True) + "\n")
        rows = "".join(
            "<tr>"
            + "".join(
                "<td>" + escape(str(r[k])) + "</td>"
                for k in ("name", "kind", "region", "zones")
            )
            + "</tr>"
            for r in snapshot["resources"]
        )
        (dest / "report.html").write_text(
            '<!doctype html><meta charset="utf-8"><title>Resource inventory</title><h1>'
            + cloud.upper()
            + " synthetic inventory</h1><p>Configuration evidence only; not a resilience assessment.</p><table><tr><th>Name</th><th>Kind</th><th>Region</th><th>Zones</th></tr>"
            + rows
            + "</table>"
        )
        print(f"{cloud}: {len(snapshot['resources'])} resources → {dest}")
    return 0
