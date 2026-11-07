export const gcpSpecs=[
 {id:'assets',host:'cloudasset.googleapis.com',path:p=>`v1/projects/${p.number}/assets`,result:'assets',asset:true,query:{contentType:'RESOURCE',pageSize:'500'}},
 ...[
 ['instances','Instance','compute'],['instanceGroupManagers','InstanceGroupManager','compute-group'],['instanceGroups','InstanceGroup','compute-group-membership'],['autoscalers','Autoscaler','scaling-policy'],['backendServices','BackendService','routing-pool'],['forwardingRules','ForwardingRule','routing'],['subnetworks','Subnetwork','network'],['reservations','Reservation','allocation-reservation']
 ].map(([id,type,kind])=>({id,host:'compute.googleapis.com',path:p=>`compute/v1/projects/${p.id}/aggregated/${id}`,result:id,aggregated:true,type:'compute.googleapis.com/'+type,kind,query:{maxResults:'500',returnPartialSuccess:'true'}})),
 ...[['networks','Network','network'],['instanceTemplates','InstanceTemplate','compute-template'],['globalForwardingRules','ForwardingRule','routing'],['healthChecks','HealthCheck','health-check'],['urlMaps','UrlMap','routing-rule'],['targetHttpProxies','TargetHttpProxy','routing-rule'],['targetHttpsProxies','TargetHttpsProxy','routing-rule']].map(([id,type,kind])=>({id,host:'compute.googleapis.com',path:p=>`compute/v1/projects/${p.id}/global/${id==='globalForwardingRules'?'forwardingRules':id}`,result:'items',type:'compute.googleapis.com/'+type,kind,query:{maxResults:'500'}})),
 ...[['healthChecks','HealthCheck','health-check'],['urlMaps','UrlMap','routing-rule'],['targetHttpProxies','TargetHttpProxy','routing-rule'],['targetHttpsProxies','TargetHttpsProxy','routing-rule'],['instanceTemplates','InstanceTemplate','compute-template']].map(([id,type,kind])=>({id:'regional-'+id,regional:true,host:'compute.googleapis.com',path:(p,region)=>`compute/v1/projects/${p.id}/regions/${region}/${id}`,result:'items',type:'compute.googleapis.com/'+type,kind,query:{maxResults:'500'}})),
 {id:'sql-instances',host:'sqladmin.googleapis.com',path:p=>`v1/projects/${p.id}/instances`,result:'items',type:'sqladmin.googleapis.com/Instance',kind:'database',query:{maxResults:'500'}}
];
export const gcpFields={
 'compute.googleapis.com/Instance':['status','zone','machineType','scheduling','reservationAffinity','networkInterfaces','disks','deletionProtection'],
 'compute.googleapis.com/InstanceGroupManager':['targetSize','listManagedInstancesResults','instanceTemplate','versions','instanceGroup','distributionPolicy','autoHealingPolicies','updatePolicy','statefulPolicy','status'],
 'compute.googleapis.com/InstanceGroup':['size','zone','network','subnetwork','namedPorts'],
 'compute.googleapis.com/Autoscaler':['target','autoscalingPolicy','status'],
 'compute.googleapis.com/BackendService':['protocol','loadBalancingScheme','backends','healthChecks','timeoutSec','connectionDraining','failoverPolicy'],
 'compute.googleapis.com/ForwardingRule':['target','backendService','network','subnetwork','loadBalancingScheme','region','IPProtocol','portRange','ports'],
 'compute.googleapis.com/HealthCheck':['type','checkIntervalSec','timeoutSec','healthyThreshold','unhealthyThreshold','httpHealthCheck','httpsHealthCheck','tcpHealthCheck'],
 'compute.googleapis.com/UrlMap':['defaultService','hostRules','pathMatchers','routeRules'],
 'compute.googleapis.com/TargetHttpProxy':['urlMap'],
 'compute.googleapis.com/TargetHttpsProxy':['urlMap','sslPolicy'],
 'compute.googleapis.com/Subnetwork':['region','network','ipCidrRange','purpose','privateIpGoogleAccess'],
 'compute.googleapis.com/Network':['autoCreateSubnetworks','subnetworks','routingConfig'],
 'compute.googleapis.com/Reservation':['zone','status','specificReservation','specificReservationRequired','shareSettings'],
 'compute.googleapis.com/InstanceTemplate':['properties.machineType','properties.scheduling','properties.reservationAffinity','properties.networkInterfaces'],
 'sqladmin.googleapis.com/Instance':['state','region','gceZone','secondaryGceZone','databaseVersion','instanceType','masterInstanceName','replicaNames','failoverReplica','settings.tier','settings.availabilityType','settings.backupConfiguration','settings.ipConfiguration','settings.activationPolicy','replicationType','diskEncryptionConfiguration'],
 'collector.gcp/ManagedInstanceObservation':['instance','instanceStatus','currentAction','instanceHealth','version']
};
export const kindForType=type=>gcpSpecs.find(s=>s.type===type)?.kind??'uninterpreted';
