import copy
import json
from pathlib import Path
import pytest
from cloud_resource_collectors.common import (
    read_json,
    validate_snapshot,
    CollectorError,
    fingerprint,
)
from cloud_resource_collectors.normalise import normalise
from cloud_resource_collectors.graph_model import prepare_import

ROOT = Path(__file__).resolve().parents[1]


def fixture(cloud, suffix):
    return read_json(ROOT / "examples" / f"{cloud}-service.{suffix}.json")


@pytest.mark.parametrize("cloud", ["azure", "aws", "gcp"])
def test_legacy_json_remains_valid(cloud):
    s = fixture(cloud, "cloud-inventory")
    validate_snapshot(s)
    plan = prepare_import(s)
    assert plan["payloadHash"] == fingerprint(s)
    assert (
        plan["payloadHash"]
        == read_json(ROOT / "python_tests/legacy_fingerprints.json")[cloud]
    )
    assert all(n["id"] == n["properties"]["id"] for n in plan["nodes"])
    assert sum(n["label"] == "Resource" for n in plan["nodes"]) == len(s["resources"])


@pytest.mark.parametrize("cloud", ["azure", "aws", "gcp"])
def test_normalized_fixture_semantic_parity(cloud):
    s = normalise(
        cloud, fixture(cloud, "inventory"), fixture(cloud, "config"), "synthetic"
    )
    old = fixture(cloud, "cloud-inventory")
    assert {r["key"] for r in s["resources"]} == {r["key"] for r in old["resources"]}

    def edges(x):
        return {
            (
                e["from"],
                e["target"]["nativeId"].lower()
                if cloud == "azure"
                else e["target"]["nativeId"],
                e["kind"],
                e["sourcePointer"],
                e["target"]["resourceKey"],
                e["target"]["resolution"],
            )
            for e in x["relationships"]
        }

    assert edges(s) == edges(old)
    oldnodes = {r["key"]: r for r in old["resources"]}
    for r in s["resources"]:
        before = oldnodes[r["key"]]
        assert r["kind"] == before["kind"]
        assert r["region"] == before["region"]
        assert set(r["zones"] or []) == set(before["zones"] or [])
        assert {
            (f["name"], f["status"], json.dumps(f["value"], sort_keys=True))
            for f in r["facts"]
        } == {
            (f["name"], f["status"], json.dumps(f["value"], sort_keys=True))
            for f in before["facts"]
        }
    assert s["simulationReady"] is False


@pytest.mark.parametrize("cloud", ["azure", "aws", "gcp"])
def test_untagged_resources_retained_without_catalogue(cloud):
    config = fixture(cloud, "config")
    config["services"] = []
    config["serviceLabelKey" if cloud == "gcp" else "serviceTagKey"] = "absent"
    s = normalise(cloud, fixture(cloud, "inventory"), config)
    assert len(s["resources"]) == len(fixture(cloud, "cloud-inventory")["resources"])
    assert s["services"] == []


@pytest.mark.parametrize("cloud", ["azure", "aws", "gcp"])
def test_missing_collection_never_means_complete(cloud):
    raw = fixture(cloud, "inventory")
    removed = raw["collections"].pop()
    if cloud == "azure":
        raw["records"] = [
            r
            for r in raw["records"]
            if not (
                r["subscriptionId"] == removed["subscriptionId"]
                and r["table"] == removed["table"]
            )
        ]
    else:
        raw["records"] = [
            r for r in raw["records"] if r["collectionId"] != removed["id"]
        ]
    s = normalise(cloud, raw, fixture(cloud, "config"))
    assert any(c["errorCode"] == "NotCollected" for c in s["collections"])
    assert all(
        any(g["code"] == "partial-collection" for g in svc["gaps"])
        for svc in s["services"]
    )


@pytest.mark.parametrize("cloud", ["azure", "aws", "gcp"])
def test_out_of_scope_inventory_rejected(cloud):
    c = fixture(cloud, "config")
    if cloud == "azure":
        c["subscriptions"] = ["99999999-9999-4999-8999-999999999999"]
    elif cloud == "aws":
        c["accounts"][0]["id"] = "999999999999"
    else:
        c["projects"][0]["id"] = "different-project"
    with pytest.raises(CollectorError):
        normalise(cloud, fixture(cloud, "inventory"), c)


@pytest.mark.parametrize(
    "mutation",
    [
        "duplicate-resource",
        "duplicate-evidence",
        "bad-fact",
        "bad-edge",
        "bad-time",
        "membership",
    ],
)
def test_validation_rejects_invalid_provenance(mutation):
    s = fixture("aws", "cloud-inventory")
    if mutation == "duplicate-resource":
        s["resources"].append(copy.deepcopy(s["resources"][0]))
    if mutation == "duplicate-evidence":
        s["evidence"].append(copy.deepcopy(s["evidence"][0]))
    if mutation == "bad-fact":
        s["resources"][0]["facts"].append(
            dict(
                name="fake",
                status="observed",
                value=123,
                evidenceId=s["evidence"][0]["id"],
                sourcePointer="/configuration/absent",
            )
        )
    if mutation == "bad-edge":
        s["relationships"][0]["target"]["resourceKey"] = "missing"
    if mutation == "bad-time":
        s["startedAt"] = "2026-02-30T00:00:00Z"
    if mutation == "membership":
        s["services"][0]["memberships"][0]["resourceKey"] = "missing"
    with pytest.raises(CollectorError):
        validate_snapshot(s)


def test_boolean_fact_stays_boolean_in_graph():
    plan = prepare_import(fixture("aws", "cloud-inventory"))
    facts = [
        n["properties"]
        for n in plan["nodes"]
        if n["label"] == "Fact" and n["properties"]["valueType"] == "boolean"
    ]
    assert facts and any(f["valueBoolean"] is False for f in facts)
    assert all(f["valueNumber"] is None for f in facts)


def test_duplicate_keys_rejected(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text('{"x":1,"x":2}')
    with pytest.raises(CollectorError):
        read_json(p)


def test_packaged_contract_and_cypher_match_repository():
    from cloud_resource_collectors.common import data_file
    from cloud_resource_collectors.graph import QUERIES

    assert data_file("cloud-inventory.schema.json") == read_json(
        ROOT / "cloud-inventory.schema.json"
    )
    for name, query in QUERIES.items():
        assert query == (ROOT / "graph/queries" / f"{name}.cypher").read_text()
