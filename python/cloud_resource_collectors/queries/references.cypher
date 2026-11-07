MATCH (r:ResourceObservation)-[:IN_PROJECT]->(po:ProjectObservation {id:$projectObservationId})
MATCH (r)-[:HAS_REFERENCE]->(ref:ConfigurationReference)
RETURN r.key AS `from`, r.name AS resourceName, ref.localId AS referenceId,
 ref.kind AS kind, ref.resolution AS resolution, ref.targetNativeId AS targetNativeId,
 ref.evidenceLocalId AS evidenceId, ref.sourcePointer AS sourcePointer
ORDER BY from, referenceId LIMIT $limit
