"""Installed command entry points. Provider errors never print response bodies."""

import argparse
import os
from pathlib import Path
import sys
from .common import CollectorError, read_json, dumps
from .config import validate_config
from .collectors import collect_azure, collect_aws, collect_gcp
from .normalise import normalise


def collect_snapshot(cloud, config, inventory=None):
    validate_config(cloud, config)
    supplied = inventory is not None
    if inventory is None:
        inventory = {
            "azure": lambda: collect_azure(config),
            "aws": lambda: collect_aws(config),
            "gcp": lambda: collect_gcp(config),
        }[cloud]()
    origin = (
        "synthetic"
        if inventory.get("synthetic") is True
        else "provided"
        if supplied
        else "live"
    )
    return normalise(cloud, inventory, config, origin)


def collect_run(args=None):
    p = argparse.ArgumentParser(
        allow_abbrev=False,
        description="Collect selected Azure, AWS or GCP projects into cloud-neutral JSON. Uses official Python SDK credentials. Exit 2 means partial collection.",
    )
    p.add_argument("--cloud", required=True, choices=["azure", "aws", "gcp"])
    p.add_argument("--output", required=True)
    for name in ("project", "region", "resource-group"):
        p.add_argument("--" + name, action="append")
    for name in ("config", "inventory", "profile", "identity"):
        p.add_argument("--" + name)
    o = p.parse_args(args)
    dest = Path(o.output)
    if dest.exists() or dest.is_symlink():
        raise CollectorError("Output already exists; choose a new file")
    if o.config:
        if any((o.project, o.region, o.resource_group, o.profile, o.identity)):
            raise CollectorError("Use either --config or scope flags, not both")
        config = read_json(o.config)
    else:
        if not o.project:
            raise CollectorError("Supply one or more --project IDs")
        if o.cloud != "azure" and not o.region:
            raise CollectorError("Supply one or more --region values")
        if (
            (o.cloud != "azure" and o.resource_group)
            or (o.cloud != "aws" and o.profile)
            or (o.cloud != "gcp" and o.identity)
            or (o.cloud == "azure" and o.region)
        ):
            raise CollectorError("Option does not apply to this cloud")
        if o.cloud == "azure":
            config = dict(subscriptions=o.project)
            if o.resource_group:
                config["resourceGroups"] = o.resource_group
        elif o.cloud == "aws":
            config = dict(
                accounts=[
                    dict(
                        id=id,
                        partition="aws",
                        regions=o.region,
                        **({"profile": o.profile} if o.profile else {}),
                    )
                    for id in o.project
                ]
            )
        else:
            config = dict(projects=[dict(id=id, regions=o.region) for id in o.project])
            if o.identity:
                config["account"] = o.identity
    snapshot = collect_snapshot(
        o.cloud, config, read_json(o.inventory) if o.inventory else None
    )
    dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(dumps(snapshot, pretty=True) + "\n")
    print(
        f"{len(snapshot['scopes'])} scope(s), {len(snapshot['resources'])} resources: {dest.resolve()}"
    )
    partial = any(
        c["status"] != "collected" or not c["paginationComplete"]
        for c in snapshot["collections"]
    )
    if partial:
        print("Partial collection: review query coverage before assessment.")
    return 2 if partial else 0


def collect_main():
    try:
        return collect_run()
    except CollectorError as e:
        print(str(e), file=sys.stderr)
        return 1
    except Exception:
        print(
            "Collection failed. Check configuration, SDK credentials, selected scope and output path.",
            file=sys.stderr,
        )
        return 1


def graph_run(args=None):
    from . import graph
    from .graph_model import prepare_import

    p = argparse.ArgumentParser(
        allow_abbrev=False,
        description="Import inventory snapshots and query Neo4j resilience evidence.",
    )
    sub = p.add_subparsers(dest="command", required=True)
    for command in (
        "init",
        "import",
        "projects",
        "resources",
        "resilience",
        "evidence",
    ):
        sp = sub.add_parser(command)
        sp.add_argument("--uri")
        sp.add_argument("--database")
        if command == "import":
            sp.add_argument("--input", action="append", required=True)
        if command in ("projects", "resources", "resilience"):
            sp.add_argument("--cloud", choices=["azure", "aws", "gcp"])
            sp.add_argument("--limit", type=int, default=1000)
        if command in ("resources", "resilience"):
            sp.add_argument("--project", required=True)
            sp.add_argument("--snapshot")
            sp.add_argument("--origin", choices=["live", "synthetic", "provided"])
        if command == "resources":
            sp.add_argument("--kind")
        if command == "evidence":
            sp.add_argument("--snapshot", required=True)
            sp.add_argument("--evidence-id", required=True)
    o = p.parse_args(args)
    options = vars(o)
    snapshots = []
    seen = {}
    for path in options.get("input", []):
        file = Path(path)
        if not file.is_file() or file.stat().st_size > 256 * 1024 * 1024:
            raise CollectorError("Input must be a JSON file no larger than 256 MiB")
        snapshot = read_json(file)
        plan = prepare_import(snapshot)
        if (
            snapshot["snapshotId"] in seen
            and seen[snapshot["snapshotId"]] != plan["payloadHash"]
        ):
            raise CollectorError("Snapshot ID is repeated with different content")
        seen[snapshot["snapshotId"]] = plan["payloadHash"]
        snapshots.append(snapshot)
    if "limit" in options:
        graph.query_limit(o.limit)
    config = graph.connection_from_env(uri=o.uri, database=o.database)
    options["database"] = config["database"]
    with graph.open_driver(config) as driver:
        driver.verify_connectivity()
        if o.command == "init":
            graph.ensure_schema(driver, config["database"])
            result = dict(status="initialized", database=config["database"])
        elif o.command == "import":
            result = dict(
                imports=graph.import_snapshots(driver, snapshots, config["database"])
            )
        elif o.command == "projects":
            result = graph.read_query(
                driver,
                config["database"],
                "projects",
                dict(cloud=o.cloud, limit=o.limit),
            )
        elif o.command == "resources":
            result = graph.project_resources(driver, options)
        elif o.command == "resilience":
            result = graph.query_resilience(driver, options)
        else:
            result = graph.read_query(
                driver,
                config["database"],
                "evidence",
                dict(snapshot=o.snapshot, evidenceId=o.evidence_id),
            )
            for row in result:
                import json

                row["record"] = json.loads(row.pop("recordJson"))
    print(dumps(result, pretty=True))
    return 0


def graph_main():
    try:
        return graph_run()
    except CollectorError as e:
        print(str(e), file=sys.stderr)
        return 1
    except Exception:
        print(
            "Graph command failed. Check JSON validity, Neo4j connection and database permissions.",
            file=sys.stderr,
        )
        return 1
