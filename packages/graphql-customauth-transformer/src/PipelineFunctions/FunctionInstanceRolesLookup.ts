import { TransformerContext } from 'graphql-transformer-core';
import { AppSync, Fn } from 'cloudform-types';
import { ResourceConstants } from 'graphql-transformer-common';
import { RESOLVER_VERSION_ID } from 'graphql-mapping-template';

// const $roles = ['VIEWING_ACCESS', 'COMMENTING_ACCESS', 'EDITING_ACCESS', 'ADMIN_ACCESS']

export const pipelineFunctionName = 'FunctionInstanceRolesLookup';
export const generateFunction = (ctx: TransformerContext) => {
  const pipelineFunction = new AppSync.FunctionConfiguration({
    ApiId: Fn.GetAtt(ResourceConstants.RESOURCES.GraphQLAPILogicalID, 'ApiId'),
    DataSourceName: Fn.GetAtt('InstanceRoleRoleCheckingDataSource', 'Name'),
    RequestMappingTemplate: `
############################################
##      [Start] InstanceRoles lookup      ##
############################################
##  DynamoDB expression
#set($expressionValues = {
  ":pk": $util.defaultIfNull($ctx.stash.instanceLookupOrgID, $ctx.stash.organisationID),
  ":sk": $ctx.stash.modelName
})

##  Building the filter expression
#set($filter = {
  "expression": "#entity = :user",
  "expressionNames": {
    "#entity": "entityID"
  },
  "expressionValues": {
    ":user": $ctx.stash.userID
  }
})

##  If the lookup is for organisationID __EVERYONE__ only the user is able to be invited (no team nor organisation role)
##  In case the lookup is made for an organisation the entities can be the user, his team and his organisation
#if($ctx.stash.instanceLookupOrgID != "__EVERYONE__")
  #if($ctx.stash.organisationID)
    #set($filter.expression = "$filter.expression OR #entity = :org")
    $util.qr($filter.expressionValues.put(":org", $ctx.stash.organisationID))
  #end
  #if($ctx.stash.organisationUserRole && $ctx.stash.organisationUserRole.team)
    #set($filter.expression = "$filter.expression OR #entity = :team")
    $util.qr($filter.expressionValues.put(":team", $ctx.stash.organisationUserRole.team))
  #end
#end

##  Convert $filter.expressionValues to dynamo language
#set($filter.expressionValues = $util.dynamodb.toMapValues($filter.expressionValues))

{
  "version": "${RESOLVER_VERSION_ID}",
  "operation": "Query",
  "index": "instanceLookupByKind",
  "query": {
    "expression": "(#pk = :pk) AND (#sk = :sk)",
    "expressionNames" : {
      "#pk": "organisationID",
      "#sk": "instanceType"
    },
    "expressionValues": $util.dynamodb.toMapValuesJson($expressionValues)
  },
  "filter": $util.toJson($filter)
##  Others attributes
##  "nextToken": "a pagination token",
##  "scanIndexForward": true,
}

############################################
##       [End] InstanceRoles lookup       ##
############################################
`,
    ResponseMappingTemplate: `
############################################
##      [Start] InstanceRoles lookup      ##
############################################

## Pushing __EVERYONE__ for the next call
$util.qr($ctx.stash.put("instanceLookupOrgID", "__EVERYONE__"))

#if(!$ctx.stash.firstInstanceLookupCall)
  ## First call -> Stash data
  
  $util.qr($ctx.stash.put("firstInstanceLookupCall", "__DONE__")) ## Push first call marker
  $util.qr($ctx.stash.put("items", $ctx.result.items))
  #if($ctx.result.nextToken)
    $util.qr($ctx.stash.put("nextToken", $ctx.result.nextToken))
  #end
  
#else
  ## Second call -> Merge data
  
  ##  First create a mapping from instanceID -> { userRole, teamRole, orgRole }
  #set($itemsMapping = {})
  #foreach($items in [$util.defaultIfNull($ctx.stash.items, []), $ctx.result.items])
    #foreach($item in $items)
      ##  Create a mapping for that instanceID
      #if(!$itemsMapping[$item.instanceID])
        $util.qr($itemsMapping.put($item.instanceID, {}))
      #end
      
      ##  Map the correct role
      #if($item.entityID == $ctx.stash.userID)
        $util.qr($itemsMapping[$item.instanceID].put("userRole", $item.role))
      #elseif($item.entityID == $ctx.stash.organisationID)
        $util.qr($itemsMapping[$item.instanceID].put("orgRole", $item.role))
      #else
        $util.qr($itemsMapping[$item.instanceID].put("teamRole", $item.role))
      #end
    #end
  #end
  
  ##  Second step extract instanceIDs that work with the roles
  #set($ctx.stash.instanceIDsToGet = [])
  #foreach($item in $itemsMapping.entrySet())
    ##  Finding the role to check
    #if($item.value.userRole)
      #set($role = $item.value.userRole)
    #elseif($item.value.teamRole)
      #set($role = $item.value.teamRole)
    #elseif($item.value.orgRole)
      #set($role = $item.value.orgRole)
    #end
    
    ##  Checking the role
    #if($ctx.stash.roles.contains($role))
      $util.qr($ctx.stash.instanceIDsToGet.add($item.key))
    #end
  #end
  
  $util.qr($ctx.stash.put("items", "__CLEANUP__"))
  #if($ctx.result.nextToken || $ctx.stash.nextToken)
    #set($first = $util.defaultIfNull($ctx.stash.nextToken, '__NONE__'))
    #set($secnd = $util.defaultIfNull($ctx.result.nextToken, '__NONE__'))
    $util.qr($ctx.stash.put("nextToken", "\${first}:\${secnd}"))
  #end
#end

############################################
##       [End] InstanceRoles lookup       ##
############################################
##  DON'T REMOVE CAUSING EMPTY RESPONSE ERROR
{}
`,
    Name: pipelineFunctionName,
    FunctionVersion: RESOLVER_VERSION_ID,
  });

  ctx.setResource(pipelineFunctionName, pipelineFunction);
  ctx.mapResourceToStack('RoleChecking', pipelineFunctionName);
};
