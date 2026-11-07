"""Shared JSON, validation, identity and evidence utilities."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from decimal import Decimal
from importlib.resources import files
from pathlib import Path

from jsonschema import Draft7Validator


class CollectorError(ValueError):
    """A safe-to-display error without provider response bodies or credentials."""


def utc_now():
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def jsonable(value):
    if isinstance(value, datetime):
        return (
            value.astimezone(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else str(value)
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    return value


def dumps(value, *, canonical=False, pretty=False):
    return json.dumps(
        jsonable(value),
        ensure_ascii=False,
        sort_keys=canonical,
        indent=2 if pretty else None,
        separators=None if pretty else (",", ":"),
        allow_nan=False,
    )


def fingerprint(value):
    return hashlib.sha256(dumps(value, canonical=True).encode()).hexdigest()


def stamp(snapshot):
    snapshot["snapshotId"] = "sha256:" + fingerprint(
        {k: v for k, v in snapshot.items() if k != "snapshotId"}
    )
    return snapshot


def data_file(name):
    return json.loads(
        files("cloud_resource_collectors").joinpath("data", name).read_text()
    )


def read_json(path):
    # Reject duplicate object keys and non-finite constants before evidence validation.
    def pairs(items):
        result = {}
        for k, v in items:
            if k in result:
                raise CollectorError("JSON contains duplicate object keys")
            result[k] = v
        return result

    def invalid(_):
        raise CollectorError("JSON contains a non-finite number")

    try:
        return json.loads(
            Path(path).read_text(), object_pairs_hook=pairs, parse_constant=invalid
        )
    except (OSError, json.JSONDecodeError) as exc:
        raise CollectorError("Cannot read a valid JSON input file") from exc


SENSITIVE = re.compile(
    r"^(password|adminPassword|administratorLoginPassword|rootPassword|clientSecret|accessToken|refreshToken|connectionStrings?|primaryKey|secondaryKey|customData|userData|protectedSettings|protectedSettingsFromKeyVault|privateKey)$",
    re.I,
)
GCP_SENSITIVE = re.compile(
    r"^(metadata|environmentVariables|env|sshKeys|ssh-keys|startup-script|startupScript)$",
    re.I,
)


def redact(value, *, gcp=False):
    value = jsonable(value)
    if isinstance(value, list):
        return [redact(v, gcp=gcp) for v in value]
    if isinstance(value, dict):
        return {
            k: "[REDACTED]"
            if SENSITIVE.fullmatch(k) or (gcp and GCP_SENSITIVE.fullmatch(k))
            else redact(v, gcp=gcp)
            for k, v in value.items()
        }
    return value


def get_path(value, path):
    for part in path.split("."):
        if isinstance(value, dict):
            value = value.get(part)
        elif isinstance(value, list) and part.isdecimal() and int(part) < len(value):
            value = value[int(part)]
        else:
            return None
    return value


def pointer(path):
    return "/" + "/".join(
        p.replace("~", "~0").replace("/", "~1") for p in path.split(".")
    )


def resolve(record, path):
    if (
        not isinstance(path, str)
        or not path.startswith("/")
        or re.search(r"~(?![01])", path)
    ):
        raise CollectorError("Invalid evidence pointer")
    for part in path[1:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if isinstance(record, dict):
            record = record.get(part)
        elif isinstance(record, list) and part.isdecimal() and int(part) < len(record):
            record = record[int(part)]
        else:
            return None
    return record


_validator = Draft7Validator(data_file("cloud-inventory.schema.json"))


def validate_snapshot(snapshot):
    if not _validator.is_valid(snapshot):
        raise CollectorError("Cloud inventory does not match schema")

    def unique(rows, key):
        result = {r[key]: r for r in rows}
        if len(result) != len(rows):
            raise CollectorError("Cloud inventory has duplicate identities")
        return result

    def time(value):
        try:
            if not re.fullmatch(
                r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z", value
            ):
                raise ValueError()
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise CollectorError("Cloud inventory has invalid timestamps") from exc

    scopes = unique(snapshot["scopes"], "id")
    collections = unique(snapshot["collections"], "id")
    resources = unique(snapshot["resources"], "key")
    evidence = unique(snapshot["evidence"], "id")
    unique(snapshot["relationships"], "id")
    unique(snapshot["services"], "id")
    if time(snapshot["startedAt"]) > time(snapshot["finishedAt"]):
        raise CollectorError("Cloud inventory has invalid timestamps")
    for c in collections.values():
        if c["scopeId"] not in scopes or time(c["startedAt"]) > time(c["finishedAt"]):
            raise CollectorError("Cloud inventory has invalid collection references")
    for e in evidence.values():
        if e["collectionId"] not in collections:
            raise CollectorError("Cloud inventory has invalid evidence references")
        time(e["observedAt"])
    for r in resources.values():
        if r["scopeId"] not in scopes or any(
            eid not in evidence
            or collections[evidence[eid]["collectionId"]]["scopeId"] != r["scopeId"]
            for eid in r["evidenceIds"]
        ):
            raise CollectorError("Cloud inventory has invalid resource references")
        for f in r["facts"]:
            if f["evidenceId"] not in evidence:
                raise CollectorError("Cloud inventory has invalid fact evidence")
            value = resolve(evidence[f["evidenceId"]]["record"], f["sourcePointer"])
            if f["status"] == "observed" and (
                dumps(value, canonical=True) != dumps(f["value"], canonical=True)
            ):
                raise CollectorError("Cloud inventory has mismatched fact evidence")
    for s in snapshot["services"]:
        unique(s["memberships"], "resourceKey")
        if any(m["resourceKey"] not in resources for m in s["memberships"]):
            raise CollectorError("Cloud inventory has invalid membership references")
    for e in snapshot["relationships"]:
        if (
            e["from"] not in resources
            or e["evidenceId"] not in evidence
            or (
                e["target"]["resourceKey"] is not None
                and e["target"]["resourceKey"] not in resources
            )
            or (
                (e["target"]["resolution"] == "unresolved")
                != (e["target"]["resourceKey"] is None)
            )
            or resolve(evidence[e["evidenceId"]]["record"], e["sourcePointer"]) is None
        ):
            raise CollectorError("Cloud inventory has invalid relationship references")
    return snapshot
