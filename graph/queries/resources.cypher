MATCH (r:ResourceObservation)-[:IN_PROJECT]->(po:ProjectObservation {id:$projectObservationId})
WHERE ($kind IS NULL OR r.kind=$kind)
WITH r ORDER BY r.key LIMIT $limit
OPTIONAL MATCH (r)-[:HAS_FACT]->(f:Fact)
RETURN r.key AS key, r.name AS name, r.nativeId AS nativeId, r.nativeType AS nativeType,
 r.kind AS kind, r.region AS region, r.zones AS zones, r.zonesKnown AS zonesKnown,
 r.placementMeaning AS placementMeaning, r.tagsJson AS tagsJson,
 collect(CASE WHEN f IS NOT NULL THEN {name:f.name, status:f.status, valueJson:f.valueJson,
 evidenceId:f.evidenceLocalId, sourcePointer:f.sourcePointer} END) AS facts
ORDER BY key
