"""Validate explicit cloud scope before any SDK call."""

import re
from .common import CollectorError


def require(condition, message="Invalid collection configuration"):
    if not condition:
        raise CollectorError(message)


def matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def validate_config(cloud, config):
    require(cloud in {"azure", "aws", "gcp"}, "Choose azure, aws or gcp")
    require(isinstance(config, dict))
    services = config.get("services", [])
    require(
        isinstance(services, list)
        and all(
            isinstance(s, dict) and isinstance(s.get("id"), str) and s["id"].strip()
            for s in services
        )
    )
    require(
        len({s["id"] for s in services}) == len(services), "Service IDs must be unique"
    )
    for key, maximum in (
        ("maxDependencyDepth", 5),
        ("maxDependenciesPerService", 100000),
    ):
        if key in config:
            require(type(config[key]) is int and 0 <= config[key] <= maximum)
    if cloud == "azure":
        subs = config.get("subscriptions")
        require(
            isinstance(subs, list)
            and 1 <= len(subs) <= 5000
            and all(
                matches(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", s)
                for s in subs
            ),
            "Supply explicit Azure subscription UUIDs",
        )
        require(len({s.lower() for s in subs}) == len(subs))
        if "resourceGroups" in config:
            groups = config["resourceGroups"]
            require(
                isinstance(groups, list)
                and groups
                and all(matches(r"[\w.()-]{1,90}", g) for g in groups)
                and len({g.lower() for g in groups}) == len(groups)
            )
    elif cloud == "aws":
        accounts = config.get("accounts")
        require(isinstance(accounts, list) and 1 <= len(accounts) <= 100)
        ids = set()
        for account in accounts:
            require(
                isinstance(account, dict)
                and matches(r"\d{12}", account.get("id"))
                and account["id"] not in ids
            )
            ids.add(account["id"])
            partition = account.get("partition", "aws")
            require(partition in {"aws", "aws-cn", "aws-us-gov"})
            if "profile" in account:
                require(
                    matches(r"[A-Za-z0-9][A-Za-z0-9_.@/-]{0,127}", account["profile"])
                )
            regions = account.get("regions")
            require(
                isinstance(regions, list)
                and 1 <= len(regions) <= 50
                and all(matches(r"[a-z]{2}(?:-[a-z0-9]+)+-\d+", r) for r in regions)
                and len(set(regions)) == len(regions)
            )
            require(
                all(
                    (partition == "aws-cn") == r.startswith("cn-")
                    and (partition == "aws-us-gov") == r.startswith("us-gov-")
                    for r in regions
                )
            )
    else:
        projects = config.get("projects")
        require(isinstance(projects, list) and 1 <= len(projects) <= 1000)
        ids = set()
        for project in projects:
            require(
                isinstance(project, dict)
                and matches(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project.get("id"))
                and project["id"] not in ids
            )
            ids.add(project["id"])
            if "number" in project:
                require(matches(r"\d{6,20}", project["number"]))
            regions = project.get("regions")
            require(
                isinstance(regions, list)
                and 1 <= len(regions) <= 100
                and all(matches(r"[a-z]+(?:-[a-z]+)*\d+", r) for r in regions)
                and len(set(regions)) == len(regions)
            )
        if "account" in config:
            require(matches(r"[A-Za-z0-9][A-Za-z0-9_.+@-]{1,253}", config["account"]))
        require(
            matches(
                r"[a-z][a-z0-9_-]{0,62}", config.get("serviceLabelKey", "service_id")
            )
        )
        aliases = config.get("serviceLabelValues", {})
        require(
            isinstance(aliases, dict)
            and all(
                matches(r"[a-z0-9_-]{1,63}", k) and isinstance(v, str) and v.strip()
                for k, v in aliases.items()
            )
        )
    if "serviceTagKey" in config:
        require(
            isinstance(config["serviceTagKey"], str) and config["serviceTagKey"].strip()
        )
    return config
